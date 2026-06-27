#!/usr/bin/env bun
// Benchmark harness: times our Pyret→Wasm pipeline on Pyret's own pitometer
// programs, in two configs:
//   "wasm"      = Pyret→Wasm (direct, the main compiler)
//   "stoppable" = CPS-transformed Pyret→Wasm (interruptible, UI-thread stop button)
// Reports compile + run time (best of N) and the slowdown factor of stoppability.
//
// A third config, "pyret" (original Pyret), is blocked on rebuilding the stale
// checked-in phase0 bundle (see ROADMAP / memory original-pyret-baseline).
//
// usage: bun scripts/bench.ts [reps]

import { buildSourceFile } from "../src/build.ts";
import { buildStoppableSourceFile } from "../src/build-stoppable.ts";
import { run } from "../src/runtime/run.ts";
import { runStoppable } from "../src/runtime/run-stoppable.ts";
import { resolve } from "path";

const reps = Number(process.argv[2] ?? 5);
const P = "pyret/lang/pitometer/programs";

const PROGRAMS = [
  "adding-ones-2000",
  "recursion-triangle-20000", // non-tail recursion: overflows direct, OK under CPS
  "tail-sum-1000000",
];

function ms(ns: bigint): number { return Number(ns) / 1e6; }
const best = (xs: number[]) => Math.min(...xs);

interface Row {
  bestCompile: number;
  bestRun: number;
  bytes: number;
  out: string;
  pauses?: number;
  error?: string;
}

async function timeBest<T>(fn: () => Promise<T>): Promise<{ best: number; last: T }> {
  const times: number[] = [];
  let last!: T;
  for (let i = 0; i < reps; i++) {
    const t = process.hrtime.bigint();
    last = await fn();
    times.push(ms(process.hrtime.bigint() - t));
  }
  return { best: best(times), last };
}

async function benchPlain(path: string): Promise<Row> {
  try {
    const c = await timeBest(() => buildSourceFile(path));
    const wasm = c.last;
    const r = await timeBest(() => run(wasm));
    return { bestCompile: c.best, bestRun: r.best, bytes: wasm.length, out: r.last.output.trim() };
  } catch (e) {
    return { bestCompile: NaN, bestRun: NaN, bytes: 0, out: "", error: String((e as Error).message ?? e).slice(0, 40) };
  }
}

async function benchStoppable(path: string): Promise<Row> {
  try {
    const c = await timeBest(() => buildStoppableSourceFile(path));
    const wasm = c.last;
    // noYield: skip the event-loop setTimeout between pauses to measure raw
    // throughput (the loop is still interruptible via the stop flag / onPause).
    const r = await timeBest(() => runStoppable(wasm, { noYield: true }).promise);
    return {
      bestCompile: c.best, bestRun: r.best, bytes: wasm.length,
      out: r.last.output.trim(), pauses: r.last.pauses,
    };
  } catch (e) {
    return { bestCompile: NaN, bestRun: NaN, bytes: 0, out: "", error: String((e as Error).message ?? e).slice(0, 40) };
  }
}

const f = (x: number) => Number.isNaN(x) ? "    —" : x.toFixed(1);
const f2 = (x: number) => Number.isNaN(x) ? "    —" : x.toFixed(2);

console.log(`Pyret→Wasm benchmark — direct vs stoppable (CPS) — best of ${reps}\n`);
const hdr =
  "program".padEnd(26) +
  "│ " + "direct run".padStart(11) + "  " + "stop run".padStart(11) +
  "  " + "slowdown".padStart(9) + "  " + "pauses".padStart(7) + "   result";
console.log(hdr);
console.log("─".repeat(hdr.length));

for (const p of PROGRAMS) {
  const path = resolve(P, p + ".arr");
  const plain = await benchPlain(path);
  const stop = await benchStoppable(path);

  const slow = (!Number.isNaN(plain.bestRun) && !Number.isNaN(stop.bestRun) && plain.bestRun > 0)
    ? (stop.bestRun / plain.bestRun).toFixed(1) + "×"
    : "—";
  const result = stop.out || plain.out || (plain.error ? "ERR:" + plain.error : "");
  const directRun = plain.error ? "overflow" : f2(plain.bestRun) + "ms";

  console.log(
    p.padEnd(26) +
    "│ " + directRun.padStart(11) +
    "  " + (f2(stop.bestRun) + "ms").padStart(11) +
    "  " + slow.padStart(9) +
    "  " + String(stop.pauses ?? "—").padStart(7) +
    "   " + result.slice(0, 18),
  );
}

console.log(`\ncompile times (best of ${reps}, ms):`);
for (const p of PROGRAMS) {
  const path = resolve(P, p + ".arr");
  const plain = await benchPlain(path);
  const stop = await benchStoppable(path);
  console.log(
    "  " + p.padEnd(26) +
    "direct " + (f(plain.bestCompile) + "ms").padStart(9) +
    "   stoppable " + (f(stop.bestCompile) + "ms").padStart(9) +
    "   wasm " + String(plain.bytes || stop.bytes).padStart(6) + "/" + String(stop.bytes) + "B",
  );
}
