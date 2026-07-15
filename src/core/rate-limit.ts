/**
 * Rate limiting — the core primitive behind the HTTP `rateLimit`
 * middleware and any resource-intensive operation that needs a
 * budget (agent runs, SQL, uploads).
 *
 * One `RateLimiter` instance = one scope + one limit. Share the
 * instance to share the budget; construct another for an isolated
 * one. The algorithm is a token bucket: capacity `requests`,
 * refilling continuously at `requests / window` per second. That
 * keeps sustained throughput identical to a fixed window while
 * eliminating the burst-at-the-window-edge artifact, and it gives
 * cost-weighted consumption for free — an expensive operation can
 * draw more than one token via `tryConsume(key, cost)`.
 *
 * Three verbs:
 *   - `tryConsume(key, cost?)` — spend budget, get a decision back.
 *   - `consume(key, cost?)`    — same, but throws
 *                                `RateLimitExceededError` on reject.
 *   - `peek(key, cost?)`       — report without spending. For "is
 *                                this caller already blocked?" checks
 *                                that must not charge the caller.
 *
 * Observability is deliberately storage-free: an `onDecision` hook
 * fires for every consume (not peeks), and `stats()` exposes
 * running counters. Consumers decide what to log, trace, or persist.
 *
 * State is in-memory and bounded: `prune()` drops fully-recovered
 * buckets, and `maxKeys` caps the map under adversarial key churn
 * (prune first, then evict oldest-tracked keys). Note the cap's
 * trade-off: an evicted key returns with a full budget, so a caller
 * rotating through more than `maxKeys` distinct keys dilutes the
 * limit. Per-key limits bound per-key abuse, not aggregate volume —
 * cap aggregate volume with a second limiter on a constant key.
 */

/**
 * Slack for float error in refill arithmetic (`elapsed * rate`
 * accumulates mantissa noise). Without it, a caller who waits
 * exactly `retryAfter` seconds can land at 0.999… tokens and get
 * rejected again. One-millionth of a token is far below anything
 * a 1ms clock tick can legitimately grant.
 */
const TOKEN_EPSILON = 1e-6;

export interface RateLimit {
  /** Max operations (token capacity) per window. */
  requests: number;
  /** Window size in seconds. */
  window: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /**
   * Seconds until enough budget refills for this operation.
   * 0 when allowed. Whole seconds, rounded up, minimum 1 on reject —
   * suitable for a `Retry-After` header.
   */
  retryAfter: number;
  /** Whole operations of cost 1 still affordable after this decision. */
  remaining: number;
  /** Seconds until the key's budget is completely full again. */
  resetAfter: number;
  limit: RateLimit;
  scope: string;
  key: string;
  cost: number;
}

export interface RateLimiterOptions {
  limit: RateLimit;
  /**
   * Label naming what this limiter protects ("login", "agent-runs").
   * Carried on decisions and errors. Default "requests".
   */
  scope?: string;
  /** Fires on every consume decision (allowed and rejected). Not on peeks. */
  onDecision?: (decision: RateLimitDecision) => void;
  /**
   * Hard cap on tracked keys. When exceeded (after pruning
   * recovered buckets), the oldest-tracked keys are evicted.
   * Default 10_000.
   */
  maxKeys?: number;
  /** Clock override for tests. Milliseconds. Default `Date.now`. */
  now?: () => number;
}

export class RateLimitExceededError extends Error {
  readonly retryAfter: number;
  readonly limit: RateLimit;
  readonly scope: string;
  readonly key: string;
  readonly cost: number;

  constructor(decision: RateLimitDecision) {
    super(
      `Rate limit exceeded for ${decision.scope}: ` +
        `${decision.limit.requests}/${decision.limit.window}s, ` +
        `retry after ${decision.retryAfter}s`,
    );
    this.name = "RateLimitExceededError";
    this.retryAfter = decision.retryAfter;
    this.limit = decision.limit;
    this.scope = decision.scope;
    this.key = decision.key;
    this.cost = decision.cost;
  }
}

/** True when the thrown value is a RateLimitExceededError. */
export function isRateLimitExceeded(e: unknown): e is RateLimitExceededError {
  return e instanceof RateLimitExceededError;
}

interface Bucket {
  /** Available budget in cost units. */
  tokens: number;
  /** Last refill timestamp, ms. */
  updatedAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly limit: RateLimit;
  private readonly scope: string;
  private readonly onDecision?: (decision: RateLimitDecision) => void;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private allowed = 0;
  private rejected = 0;

  constructor(options: RateLimiterOptions) {
    if (options.limit.requests <= 0 || options.limit.window <= 0) {
      throw new Error(
        "RateLimiter: limit.requests and limit.window must be positive",
      );
    }
    this.limit = { ...options.limit };
    this.scope = options.scope ?? "requests";
    this.onDecision = options.onDecision;
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /** Tokens refilled per millisecond. */
  private get refillRate(): number {
    return this.limit.requests / (this.limit.window * 1000);
  }

  /** Refreshed bucket for `key` — never stored by this method. */
  private refreshed(key: string): Bucket {
    const nowMs = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket) return { tokens: this.limit.requests, updatedAt: nowMs };
    const elapsed = Math.max(0, nowMs - bucket.updatedAt);
    return {
      tokens: Math.min(
        this.limit.requests,
        bucket.tokens + elapsed * this.refillRate,
      ),
      updatedAt: nowMs,
    };
  }

  private decide(key: string, cost: number, bucket: Bucket): RateLimitDecision {
    const allowed = bucket.tokens >= cost - TOKEN_EPSILON;
    const afterTokens = allowed ? bucket.tokens - cost : bucket.tokens;
    const retryAfter = allowed
      ? 0
      : Math.max(1, Math.ceil((cost - bucket.tokens) / this.refillRate / 1000));
    const resetAfter = Math.ceil(
      (this.limit.requests - afterTokens) / this.refillRate / 1000,
    );
    return {
      allowed,
      retryAfter,
      remaining: Math.floor(afterTokens),
      resetAfter,
      limit: { ...this.limit },
      scope: this.scope,
      key,
      cost,
    };
  }

  private assertCost(cost: number): void {
    if (cost <= 0 || cost > this.limit.requests) {
      throw new Error(
        `RateLimiter: cost ${cost} outside (0, ${this.limit.requests}] — ` +
          "an operation costing more than the full budget can never run",
      );
    }
  }

  /** Spend `cost` tokens from `key`'s budget if affordable. */
  tryConsume(key: string, cost = 1): RateLimitDecision {
    this.assertCost(cost);
    const bucket = this.refreshed(key);
    const decision = this.decide(key, cost, bucket);
    if (decision.allowed) {
      bucket.tokens = Math.max(0, bucket.tokens - cost);
      this.allowed++;
    } else {
      this.rejected++;
    }
    this.track(key, bucket);
    this.onDecision?.(decision);
    return decision;
  }

  /** Like `tryConsume`, but throws `RateLimitExceededError` on reject. */
  consume(key: string, cost = 1): RateLimitDecision {
    const decision = this.tryConsume(key, cost);
    if (!decision.allowed) throw new RateLimitExceededError(decision);
    return decision;
  }

  /** Report the decision `tryConsume` would make, without spending. */
  peek(key: string, cost = 1): RateLimitDecision {
    this.assertCost(cost);
    return this.decide(key, cost, this.refreshed(key));
  }

  /** Running counters since construction. */
  stats(): { allowed: number; rejected: number; keys: number } {
    return {
      allowed: this.allowed,
      rejected: this.rejected,
      keys: this.buckets.size,
    };
  }

  /** Drop buckets whose budget is fully recovered. */
  prune(): void {
    for (const [key, bucket] of this.buckets) {
      const elapsed = Math.max(0, this.now() - bucket.updatedAt);
      const refilled = bucket.tokens + elapsed * this.refillRate;
      if (refilled >= this.limit.requests - TOKEN_EPSILON) {
        this.buckets.delete(key);
      }
    }
  }

  /** Store the refreshed bucket, enforcing the key cap. */
  private track(key: string, bucket: Bucket): void {
    // Re-insert so Map order approximates recency — eviction below
    // then drops the least-recently-touched keys first.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (this.buckets.size <= this.maxKeys) return;
    this.prune();
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
}
