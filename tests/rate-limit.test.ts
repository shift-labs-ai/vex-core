import { describe, expect, test } from "bun:test";
import {
  type RateLimitDecision,
  RateLimitExceededError,
  RateLimiter,
} from "../src/core/rate-limit.js";

/** A limiter with a controllable clock. */
function makeLimiter(
  opts: Partial<ConstructorParameters<typeof RateLimiter>[0]> = {},
) {
  let nowMs = 0;
  const limiter = new RateLimiter({
    limit: { requests: 3, window: 60 },
    now: () => nowMs,
    ...opts,
  });
  return { limiter, advance: (seconds: number) => (nowMs += seconds * 1000) };
}

describe("RateLimiter", () => {
  test("allows operations within the limit", () => {
    const { limiter } = makeLimiter();
    expect(limiter.tryConsume("k").allowed).toBe(true);
    expect(limiter.tryConsume("k").allowed).toBe(true);
    expect(limiter.tryConsume("k").allowed).toBe(true);
  });

  test("rejects over-limit with a positive retryAfter", () => {
    const { limiter } = makeLimiter({ limit: { requests: 2, window: 60 } });
    limiter.tryConsume("k");
    limiter.tryConsume("k");
    const d = limiter.tryConsume("k");
    expect(d.allowed).toBe(false);
    expect(d.retryAfter).toBeGreaterThan(0);
    expect(d.remaining).toBe(0);
  });

  test("keys have independent budgets", () => {
    const { limiter } = makeLimiter({ limit: { requests: 1, window: 60 } });
    expect(limiter.tryConsume("a").allowed).toBe(true);
    expect(limiter.tryConsume("b").allowed).toBe(true);
    expect(limiter.tryConsume("a").allowed).toBe(false);
    expect(limiter.tryConsume("b").allowed).toBe(false);
  });

  test("budget recovers as time passes (token refill, not window reset)", () => {
    const { limiter, advance } = makeLimiter({
      limit: { requests: 2, window: 60 },
    });
    limiter.tryConsume("k");
    limiter.tryConsume("k");
    expect(limiter.tryConsume("k").allowed).toBe(false);

    // Half a window refills one of two tokens.
    advance(30);
    expect(limiter.tryConsume("k").allowed).toBe(true);
    expect(limiter.tryConsume("k").allowed).toBe(false);

    // A full idle window restores the full budget, but never more.
    advance(180);
    expect(limiter.tryConsume("k").allowed).toBe(true);
    expect(limiter.tryConsume("k").allowed).toBe(true);
    expect(limiter.tryConsume("k").allowed).toBe(false);
  });

  test("retryAfter predicts when the operation becomes affordable", () => {
    const { limiter, advance } = makeLimiter({
      limit: { requests: 2, window: 60 },
    });
    limiter.tryConsume("k");
    limiter.tryConsume("k");
    const d = limiter.tryConsume("k");
    expect(d.retryAfter).toBe(30); // one token refills in window/requests

    advance(d.retryAfter);
    expect(limiter.tryConsume("k").allowed).toBe(true);
  });

  test("waiting exactly retryAfter is always sufficient, even at awkward rates", () => {
    // Rates like 3/7s make `elapsed * rate` accumulate float error;
    // without epsilon slack a caller who waits exactly retryAfter
    // can land at 0.999… tokens and get rejected again.
    for (const limit of [
      { requests: 3, window: 7 },
      { requests: 7, window: 13 },
      { requests: 10, window: 3 },
    ]) {
      const { limiter, advance } = makeLimiter({ limit });
      for (let i = 0; i < limit.requests; i++) limiter.tryConsume("k");
      const d = limiter.tryConsume("k");
      expect(d.allowed).toBe(false);
      advance(d.retryAfter);
      expect(limiter.tryConsume("k").allowed).toBe(true);
    }
  });

  test("cost-weighted operations draw proportionally from the budget", () => {
    const { limiter } = makeLimiter({ limit: { requests: 10, window: 60 } });
    expect(limiter.tryConsume("k", 7).allowed).toBe(true);
    expect(limiter.tryConsume("k", 4).allowed).toBe(false);
    expect(limiter.tryConsume("k", 3).allowed).toBe(true);
    expect(limiter.tryConsume("k").allowed).toBe(false);
  });

  test("a cost above capacity is a config error, not a rejection", () => {
    const { limiter } = makeLimiter({ limit: { requests: 5, window: 60 } });
    expect(() => limiter.tryConsume("k", 6)).toThrow(/cost/);
  });

  test("remaining counts whole operations left after the decision", () => {
    const { limiter } = makeLimiter({ limit: { requests: 3, window: 60 } });
    expect(limiter.tryConsume("k").remaining).toBe(2);
    expect(limiter.tryConsume("k").remaining).toBe(1);
    expect(limiter.tryConsume("k").remaining).toBe(0);
  });

  test("peek reports without spending budget", () => {
    const { limiter } = makeLimiter({ limit: { requests: 1, window: 60 } });
    expect(limiter.peek("k").allowed).toBe(true);
    expect(limiter.peek("k").allowed).toBe(true);
    expect(limiter.tryConsume("k").allowed).toBe(true);
    expect(limiter.peek("k").allowed).toBe(false);
    expect(limiter.peek("k").retryAfter).toBeGreaterThan(0);
  });

  test("consume throws RateLimitExceededError with retry metadata", () => {
    const { limiter } = makeLimiter({
      limit: { requests: 1, window: 60 },
      scope: "agent-runs",
    });
    limiter.consume("k");
    let caught: unknown;
    try {
      limiter.consume("k");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RateLimitExceededError);
    const err = caught as RateLimitExceededError;
    expect(err.retryAfter).toBeGreaterThan(0);
    expect(err.scope).toBe("agent-runs");
    expect(err.key).toBe("k");
    expect(err.limit).toEqual({ requests: 1, window: 60 });
    expect(err.message).toContain("agent-runs");
  });

  test("onDecision fires for consumes but not peeks", () => {
    const decisions: RateLimitDecision[] = [];
    const { limiter } = makeLimiter({
      limit: { requests: 1, window: 60 },
      scope: "s",
      onDecision: (d) => decisions.push(d),
    });
    limiter.peek("k");
    limiter.tryConsume("k");
    limiter.tryConsume("k", 1);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({
      allowed: true,
      scope: "s",
      key: "k",
      cost: 1,
    });
    expect(decisions[1]).toMatchObject({ allowed: false, key: "k" });
  });

  test("stats counts allowed and rejected decisions", () => {
    const { limiter } = makeLimiter({ limit: { requests: 2, window: 60 } });
    limiter.tryConsume("a");
    limiter.tryConsume("a");
    limiter.tryConsume("a");
    limiter.peek("a");
    expect(limiter.stats()).toEqual({ allowed: 2, rejected: 1, keys: 1 });
  });

  test("prune drops keys whose budget is fully recovered", () => {
    const { limiter, advance } = makeLimiter({
      limit: { requests: 1, window: 1 },
    });
    limiter.tryConsume("a");
    limiter.tryConsume("b");
    expect(limiter.stats().keys).toBe(2);
    advance(2);
    limiter.prune();
    expect(limiter.stats().keys).toBe(0);
    expect(limiter.tryConsume("a").allowed).toBe(true);
  });

  test("key count stays bounded under adversarial key churn", () => {
    const { limiter } = makeLimiter({
      limit: { requests: 1, window: 3600 },
      maxKeys: 10,
    });
    for (let i = 0; i < 100; i++) limiter.tryConsume(`k-${i}`);
    expect(limiter.stats().keys).toBeLessThanOrEqual(10);
    // Newest keys survive eviction; the freshly-added key is tracked.
    expect(limiter.peek("k-99").allowed).toBe(false);
  });
});
