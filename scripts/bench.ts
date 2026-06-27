#!/usr/bin/env bun
// Benchmark the seed Pyret→Wasm pipeline on Pyret's own pitometer programs:
// compile time + run time (best of N) per program.
//
// Other configs live elsewhere: original Pyret = scripts/bench-pyret-baseline.sh;
// the stoppable (CPS) config will return once the Pyret→Pyret transform
// (self-host/cps.arr) is wired in (stoppability is not part of the TS seed).
//
// usage: bun scripts/bench.ts [reps]

import { buildSourceFile } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";
import { resolve } from "path";

const reps = Number(process.argv[2] ?? 5);
const P = "pyret/lang/pitometer/programs";
const PROGRAMS = ["adding-ones-2000", "recursion-triangle-20000", "tail-sum-1000000"];

function ms(ns: bigint): number { return Number(ns) / 1e6; }
const best = (xs: number[]) => Math.min(...xs);

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

const f = (x: number) => Number.isNaN(x) ? "    —" : x.toFixed(2);

console.log(`Pyret→Wasm (seed) benchmark — best of ${reps}\n`);
console.log("program".padEnd(26) + "compile(ms)".padStart(12) + "run(ms)".padStart(10) + "  result");
console.log("-".repeat(60));
for (const p of PROGRAMS) {
  const path = resolve(P, p + ".arr");
  try {
    const c = await timeBest(() => buildSourceFile(path));
    const r = await timeBest(() => run(c.last));
    console.log(p.padEnd(26) + f(c.best).padStart(12) + f(r.best).padStart(10) + "  " + r.last.output.trim().slice(0, 20));
  } catch (e) {
    console.log(p.padEnd(26) + "   ERROR: " + String((e as Error).message ?? e).slice(0, 40));
  }
}
