/**
 * The invalidation benchmark across engines and scales, in one table.
 *
 * Each engine is a git ref checked out into a temporary worktree with
 * this directory's benchmark copied in, so every engine runs the same
 * scenarios. Configurations vary the people, the handler cost and the
 * burst; the current tree runs with and without evaluation workers.
 *
 *   bun benchmarks/compare.ts                      # markdown to stdout
 *   BENCH_REFS=v0.21.0,v0.22.1 BENCH_OUT=report.md bun benchmarks/compare.ts
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const REFS = (process.env.BENCH_REFS ?? "v0.21.0,v0.22.1").split(",");
const ROUNDS = process.env.BENCH_ROUNDS ?? "5";
const OUT = process.env.BENCH_OUT;

interface Config {
  users: number;
  handlerMs: number;
  burst: number;
}
const CONFIGS: Config[] = [
  { users: 10, handlerMs: 0, burst: 6 },
  { users: 35, handlerMs: 0, burst: 6 },
  { users: 35, handlerMs: 20, burst: 6 },
  { users: 100, handlerMs: 0, burst: 6 },
  { users: 100, handlerMs: 20, burst: 24 },
];

interface Row {
  scenario: string;
  writes: number;
  passes: number;
  reruns: number;
  deliveries: number;
  invalidationMs: number;
  wallP50: number;
  wallMax: number;
  stallMs: number;
}

interface Engine {
  label: string;
  dir: string;
  workers: number;
}

function git(...args: string[]): string {
  const run = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout.trim();
}

/** A worktree at `ref` carrying this tree's benchmark. */
function checkout(ref: string, into: string): string {
  const dir = join(into, ref.replace(/[^\w.-]/g, "_"));
  git("worktree", "add", "--detach", "-q", dir, ref);
  rmSync(join(dir, "benchmarks"), { recursive: true, force: true });
  cpSync(join(ROOT, "benchmarks"), join(dir, "benchmarks"), {
    recursive: true,
  });
  spawnSync("bun", ["install", "--silent"], { cwd: dir });
  return dir;
}

function run(engine: Engine, config: Config): Row[] {
  const result = spawnSync("bun", ["benchmarks/invalidation.ts"], {
    cwd: engine.dir,
    encoding: "utf8",
    env: {
      ...process.env,
      BENCH_JSON: "1",
      BENCH_ROUNDS: ROUNDS,
      BENCH_USERS: String(config.users),
      BENCH_HANDLER_MS: String(config.handlerMs),
      BENCH_BURST: String(config.burst),
      BENCH_WORKERS: String(engine.workers),
    },
  });
  if (result.status !== 0) {
    throw new Error(`${engine.label}: ${result.stderr || result.stdout}`);
  }
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Row);
}

const n = (value: number, digits = 1) => value.toFixed(digits);

function main() {
  const tmp = mkdtempSync(join(tmpdir(), "vex-compare-"));
  const engines: Engine[] = [];
  try {
    for (const ref of REFS) {
      engines.push({ label: ref, dir: checkout(ref, tmp), workers: 0 });
    }
    const head = git("rev-parse", "--short", "HEAD");
    engines.push({ label: `${head} (this tree)`, dir: ROOT, workers: 0 });
    engines.push({
      label: `${head} + 4 workers`,
      dir: ROOT,
      workers: 4,
    });

    const lines: string[] = [
      "# Invalidation benchmark across engines",
      "",
      `Rounds per scenario: ${ROUNDS}. Each row: passes / re-runs per round, wall p50 ms, main-thread stall ms per round.`,
      "",
    ];
    for (const config of CONFIGS) {
      lines.push(
        `## ${config.users} people, ${config.handlerMs} ms handlers, bursts of ${config.burst}`,
        "",
      );
      const results = engines.map((engine) => ({
        engine,
        rows: run(engine, config),
      }));
      const scenarios = results[0].rows.map((row) => row.scenario);
      lines.push(
        `| engine | ${scenarios.map((s) => `${s}: passes / re-runs / wall p50 / stall`).join(" | ")} |`,
        `| --- | ${scenarios.map(() => "---").join(" | ")} |`,
      );
      for (const { engine, rows } of results) {
        lines.push(
          `| ${engine.label} | ${rows
            .map(
              (row) =>
                `${n(row.passes)} / ${n(row.reruns)} / ${n(row.wallP50)} / ${n(row.stallMs)}`,
            )
            .join(" | ")} |`,
        );
        console.error(
          `${config.users}p ${config.handlerMs}ms ${engine.label}: done`,
        );
      }
      lines.push("");
    }
    const report = lines.join("\n");
    if (OUT) writeFileSync(OUT, report);
    else console.log(report);
  } finally {
    for (const engine of engines) {
      if (engine.dir !== ROOT) git("worktree", "remove", "--force", engine.dir);
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
