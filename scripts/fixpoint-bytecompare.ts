#!/usr/bin/env bun
// FIXPOINT BYTE-COMPARE — the endgame gate for self-hosting.
//
// The fixpoint criterion: the SELF-HOSTED compiler, compiled by itself, reaches a STABLE
// byte-identical fixed point. We iterate gen2 = compiler.wasm(merged), gen(N+1) = genN(merged),
// until two consecutive generations are byte-for-byte identical.
//
// Pipeline:
//   Stage A : seed compiles the driver closure -> compiler.wasm   (seed/binaryen backend)
//   merged  : the WHOLE driver closure as one Pyret source (prelude + every module body)
//   gen2    : compiler.wasm compiles `merged`  -> compiler2        (wasm-of-pyret backend)
//   gen3..  : genN compiles `merged`           -> gen(N+1)
//   FIXPOINT: genN === gen(N-1) byte-for-byte.
//
// (Stage A vs gen2 will NOT match — different backends — so we DON'T compare those. gen2 vs
// gen3 also won't match: `f64-bits` (encoder.arr) serializes a roughnum literal's IEEE bytes
// via the runtime's integer arithmetic, and the seed runtime (exact JS doubles) vs the
// self-hosted runtime differ by a few ULPs that WASH OUT after a couple of iterations — a
// normal multi-stage bootstrap convergence. The sequence is bit-stable once converged.)
//
// usage: bun scripts/fixpoint-bytecompare.ts

import { buildSourceFile, mergeSourcesFor } from "../src/build.ts";
import { compileWithDriver } from "../src/build-selfhosted.ts";
import { resolve } from "path";

function valid(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d;
}
const msg = (e: unknown) => String((e as Error).message ?? e).replace(/\x1b\[[0-9;]*m/g, "").split("\n")[0];

console.log("=== Self-hosting fixpoint byte-compare ===\n");

const DRIVER = resolve(import.meta.dir, "../self-host/compile-driver.arr");

// Stage A: seed builds the self-hosted compiler.
const compilerWasm = await buildSourceFile(DRIVER);
console.log(`Stage A ✅  seed -> compiler.wasm (${compilerWasm.length} bytes, binaryen backend)`);

// The whole driver closure as ONE merged source the self-hosted compiler can consume.
const { source, paths } = await mergeSourcesFor(DRIVER);
console.log(`merged source: ${source.length} chars over ${paths.length} modules\n`);

// Iterate the self-hosting sequence until two CONSECUTIVE generations are byte-identical.
//
// gen 2 = compiler.wasm(merged), gen N+1 = genN(merged). The fixpoint is the first genN with
// genN === gen(N-1). Note gen2 (seed-built) and gen3 are NOT expected to match: f64-const
// emission (encoder.arr `f64-bits`) computes a roughnum literal's IEEE bytes via the runtime's
// integer arithmetic, and the seed runtime (exact JS doubles) vs the self-hosted runtime differ
// by a few ULPs that then WASH OUT — the sequence converges in a couple of iterations and is
// perfectly stable thereafter (the standard multi-stage bootstrap convergence).
const MAX_GENS = 8;
let prev: Uint8Array | null = null;
let fixpointGen = -1;
let lastGen: Uint8Array | null = null;
let producer: Uint8Array = compilerWasm;
for (let gen = 2; gen <= MAX_GENS; gen++) {
  let cur: Uint8Array;
  try {
    cur = await compileWithDriver(producer, source);
  } catch (e) {
    console.log(`compiler${gen} ❌  ${msg(e)}`);
    break;
  }
  if (prev) {
    const nd = (() => { let c = 0; const n = Math.min(prev!.length, cur.length); for (let i = 0; i < n; i++) if (prev![i] !== cur[i]) c++; return c + Math.abs(prev!.length - cur.length); })();
    console.log(`compiler${gen} ✅  ${cur.length} bytes — ${nd === 0 ? "IDENTICAL to" : nd + " diff bytes vs"} compiler${gen - 1}`);
    if (nd === 0) { fixpointGen = gen; lastGen = cur; break; }
  } else {
    console.log(`compiler${gen} ✅  self-hosted compiled its OWN merged source: ${cur.length} bytes, \\0asm=${valid(cur)}`);
  }
  prev = cur;
  producer = cur;
  lastGen = cur;
}

console.log("");
if (fixpointGen > 0) {
  console.log(`FIXPOINT ✅  compiler${fixpointGen} === compiler${fixpointGen - 1} byte-for-byte (${lastGen!.length} bytes).`);
  console.log("Self-hosting reproduces itself: the self-hosted compiler, compiled by itself,");
  console.log("reaches a stable byte-identical fixed point.");
} else if (lastGen) {
  console.log(`No fixpoint within ${MAX_GENS} generations (still drifting). See per-gen diffs above.`);
} else {
  console.log("--- Status ---");
  console.log("compiler2 did not build/run — see the error above.");
}
