#!/usr/bin/env bun
// Parallel test runner: shards the test files across N worker processes (one `bun test`
// per file, up to JOBS in flight) and aggregates the pass/fail totals. `bun test` runs a
// single process over all files sequentially; sharding by file uses all the cores.
//
//   bun scripts/test-par.ts                  # JOBS = NUM_CORES (or detected core count)
//   JOBS=32 bun scripts/test-par.ts          # explicit concurrency
//   bun scripts/test-par.ts foo bar          # only files whose path contains foo/bar
import { Glob } from "bun";

const all = [...new Glob("test/**/*.test.ts").scanSync(".")].sort();
const filters = process.argv.slice(2);
const files = filters.length ? all.filter((f) => filters.some((s) => f.includes(s))) : all;

// Default 8-way: the heavy self-host/e2e files each load binaryen + compile large WASM, so
// higher concurrency oversubscribes RAM and causes spurious timeouts. Override with JOBS=.
const JOBS = Math.max(1, Number(process.env.JOBS ?? 8));

let pass = 0, fail = 0, idx = 0;
const failedFiles: string[] = [];
const t0 = Date.now();

async function worker(): Promise<void> {
  while (idx < files.length) {
    const f = files[idx++]!;
    // Generous per-test timeout: under parallel CPU contention a heavy WASM-compiling test
    // can blow bun's 5s default and fail spuriously (the failure is contention, not logic).
    const proc = Bun.spawn(["bun", "test", "--timeout", "120000", f], { stdout: "pipe", stderr: "pipe" });
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    // bun prints its summary to stderr, e.g. " 12 pass" / " 1 fail".
    const p = /(\d+)\s+pass/.exec(err);
    const fl = /(\d+)\s+fail/.exec(err);
    if (p) pass += Number(p[1]);
    if (fl) fail += Number(fl[1]);
    const bad = (proc.exitCode ?? 1) !== 0 || (fl ? Number(fl[1]) > 0 : false);
    if (bad) { failedFiles.push(f); process.stderr.write(err); }
    process.stdout.write(bad ? "x" : ".");
  }
}

await Promise.all(Array.from({ length: Math.min(JOBS, files.length) }, () => worker()));

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n\n${pass} pass, ${fail} fail across ${files.length} files in ${secs}s (jobs=${JOBS})`);
if (failedFiles.length) {
  console.log("FAILED: " + failedFiles.join(", "));
  process.exit(1);
}
