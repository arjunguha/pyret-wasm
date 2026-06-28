#!/usr/bin/env bun
// Benchmark: CPS self-hosted Pyret→WASM (immediate-resume trampoline) vs original Pyret on Node.
//
// CONFIG B: loads web/cps-compile-driver.wasm (the same single artifact the web IDE uses),
// compiles each program through it (PRELUDE_SRC + "\n" + userSrc), then runs the emitted
// module with an immediate-resume trampoline (no setTimeout — raw throughput). Both compile
// time and run time are measured and reported.
//
// CONFIG A (original Pyret, Node): runs the pre-built per-program standalone JS (built by
// scripts/bench-pyret-baseline.sh) and times it with best-of-N.
//
// Usage: bun scripts/bench-cps.ts [reps]
//   reps: number of timing repetitions (default 5)

import { buildHostImports, newHostState, PauseSignal, PyretError } from "../src/runtime/run.ts";
import { PRELUDE_SRC } from "../src/compiler/prelude.ts";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { spawnSync } from "child_process";

const ROOT = resolve(dirname(import.meta.path), "..");
const REPS = Number(process.argv[2] ?? "5");

// ── Load the CPS compile driver (once) ──────────────────────────────────────
const DRIVER_PATH = resolve(ROOT, "web/cps-compile-driver.wasm");
if (!existsSync(DRIVER_PATH)) {
  console.error("web/cps-compile-driver.wasm not found. Rebuild: bun scripts/gen-cps-compile-driver.ts");
  process.exit(1);
}
const driver = new Uint8Array(await Bun.file(DRIVER_PATH).arrayBuffer());

// ── Compile a program through the CPS driver ────────────────────────────────
async function compileCPS(userSrc: string): Promise<Uint8Array> {
  const state = newHostState(() => {});
  state.sourceBytes = new TextEncoder().encode(PRELUDE_SRC + "\n" + userSrc);
  const { instance } = await WebAssembly.instantiate(driver as BufferSource, buildHostImports(state));
  state.instance = instance;
  const mem = instance.exports.memory as WebAssembly.Memory;
  state.memory = mem;
  // Pre-grow generously so large inputs don't OOM the compiler.
  const need = state.sourceBytes.length * 16 + (8 << 20);
  const have = mem.buffer.byteLength;
  if (need > have) {
    const pages = Math.ceil((need - have) / 65536);
    try { mem.grow(pages); } catch { /* best effort */ }
  }
  (instance.exports.main as () => void)();
  if (!state.emitted || state.emitted.length === 0) throw new Error("CPS driver emitted no bytes");
  return new Uint8Array(state.emitted);
}

// ── Run a CPS module with immediate-resume trampoline ────────────────────────
async function runCPS(wasm: Uint8Array): Promise<{ output: string; pauses: number }> {
  let output = "";
  const state = newHostState((s) => { output += s; });
  const { instance } = await WebAssembly.instantiate(wasm as BufferSource, buildHostImports(state));
  state.instance = instance;
  state.memory = instance.exports.memory as WebAssembly.Memory;
  const main = instance.exports.main as () => void;
  const resumeFn = instance.exports.resume as (() => void) | undefined;
  let step: () => void = main;
  let pauses = 0;
  for (;;) {
    try {
      step();
      return { output, pauses };
    } catch (e) {
      if (e instanceof PauseSignal) {
        pauses++;
        step = resumeFn!;
        continue; // immediate resume — no setTimeout
      }
      if (e instanceof PyretError) {
        return { output: output + "\n[PyretError] " + e.message, pauses };
      }
      throw e;
    }
  }
}

// ── Timing helpers ───────────────────────────────────────────────────────────
async function timeBestOf<T>(n: number, fn: () => Promise<T>): Promise<{ best: number; last: T }> {
  let best = Infinity;
  let last!: T;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    last = await fn();
    const elapsed = performance.now() - t0;
    if (elapsed < best) best = elapsed;
  }
  return { best, last };
}

// ── Program definitions ──────────────────────────────────────────────────────
// The adding-ones-2000 source has no print(); we wrap it.
const ADDING_ONES_SRC = await Bun.file(resolve(ROOT, "pyret/lang/pitometer/programs/adding-ones-2000.arr")).text();
const TRIANGLE_SRC    = `fun triangle(n):
  if n <= 0: 1
  else: n + triangle(n - 1)
  end
end
print(triangle(20000))`;
const TAILSUM_SRC = `fun sum(n, sofar):
  if n <= 0: sofar
  else:
    sum(n - 1, sofar + n)
  end
end
print(sum(1000000, 0))`;

// adding-ones is a long expression but does no output; wrap in print.
// The raw file is just "1 + 1 + ... + 1 # test parsing"
// We strip comments and wrap.
function makeAddingOnesSrc(raw: string): string {
  const body = raw.replace(/#.*$/gm, "").trim();
  return `print(${body})`;
}

interface BenchProgram {
  name: string;
  src: string;
  expectedOutput?: string;
}

const PROGRAMS: BenchProgram[] = [
  {
    name: "adding-ones-2000",
    src: makeAddingOnesSrc(ADDING_ONES_SRC),
    expectedOutput: "2000",
  },
  {
    name: "recursion-triangle-20000",
    src: TRIANGLE_SRC,
    expectedOutput: "200010001",
  },
  {
    name: "tail-sum-1000000",
    src: TAILSUM_SRC,
    expectedOutput: "500000500000",
  },
];

// ── Run benchmarks ───────────────────────────────────────────────────────────
console.log(`\n=== CPS self-hosted Pyret→WASM benchmark (${REPS} reps, immediate-resume) ===\n`);
console.log(`bun ${Bun.version}`);
console.log(`driver: ${DRIVER_PATH} (${(driver.length / 1024).toFixed(0)} KB)\n`);

const results: {
  name: string;
  compileMs: number;
  runMs: number;
  output: string;
  pauses: number;
  ok: boolean;
  error?: string;
}[] = [];

for (const prog of PROGRAMS) {
  process.stdout.write(`[${prog.name}] compiling... `);
  let wasm: Uint8Array;
  let compileMs: number;
  try {
    const ct = await timeBestOf(1, () => compileCPS(prog.src));
    compileMs = ct.best;
    wasm = ct.last;
    process.stdout.write(`OK (${wasm.length} bytes, ${compileMs.toFixed(0)} ms compile)\n`);
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 300);
    console.log(`COMPILE FAIL: ${msg}`);
    results.push({ name: prog.name, compileMs: 0, runMs: 0, output: "", pauses: 0, ok: false, error: msg });
    continue;
  }

  process.stdout.write(`[${prog.name}] running (${REPS} reps)... `);
  let runMs: number;
  let lastResult: { output: string; pauses: number };
  try {
    const rt = await timeBestOf(REPS, () => runCPS(wasm));
    runMs = rt.best;
    lastResult = rt.last;
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 300);
    console.log(`RUN FAIL: ${msg}`);
    results.push({ name: prog.name, compileMs, runMs: 0, output: "", pauses: 0, ok: false, error: msg });
    continue;
  }

  const outputTrimmed = lastResult.output.trim();
  const ok = prog.expectedOutput === undefined || outputTrimmed === prog.expectedOutput;
  console.log(`${ok ? "OK" : "WRONG OUTPUT"} => "${outputTrimmed}" (run best: ${runMs.toFixed(1)} ms, pauses: ${lastResult.pauses})`);
  results.push({ name: prog.name, compileMs, runMs, output: outputTrimmed, pauses: lastResult.pauses, ok, error: ok ? undefined : `expected "${prog.expectedOutput}", got "${outputTrimmed}"` });
}

// ── Summary table ────────────────────────────────────────────────────────────
console.log("\n┌──────────────────────────────────┬──────────────┬──────────────┬─────────┬────────┐");
console.log("│ program                          │ compile (ms) │    run (ms)  │ pauses  │ ok?    │");
console.log("├──────────────────────────────────┼──────────────┼──────────────┼─────────┼────────┤");
for (const r of results) {
  const n = r.name.padEnd(32);
  const c = r.ok || r.compileMs > 0 ? r.compileMs.toFixed(0).padStart(12) : "       FAIL".padStart(12);
  const run = r.ok ? r.runMs.toFixed(1).padStart(12) : "      FAIL".padStart(12);
  const p = r.pauses.toString().padStart(7);
  const ok = (r.ok ? "yes" : "NO " + (r.error ?? "")).slice(0, 6).padEnd(6);
  console.log(`│ ${n} │ ${c} │ ${run} │ ${p} │ ${ok} │`);
}
console.log("└──────────────────────────────────┴──────────────┴──────────────┴─────────┴────────┘");
console.log(`\n(run = best-of-${REPS} wall-clock, CPS+prelude, immediate-resume, no event-loop yield)`);
