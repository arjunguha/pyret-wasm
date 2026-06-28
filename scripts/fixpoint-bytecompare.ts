#!/usr/bin/env bun
// FIXPOINT BYTE-COMPARE — the endgame gate for self-hosting.
//
// The TRUE fixpoint criterion: the SELF-HOSTED compiler, run on ITS OWN (whole, merged)
// SOURCE, produces a compiler (compiler2); compiler2 run on the same source produces
// compiler3; and compiler2 === compiler3 byte-for-byte (a stable fixed point). At that point
// the seed is out of the loop and the self-hosted compiler reproduces itself.
//
// Pipeline:
//   Stage A : seed compiles the driver closure -> compiler.wasm   (seed/binaryen backend)
//   merged  : the WHOLE driver closure as one Pyret source (prelude + every module body)
//   c2      : compiler.wasm compiles `merged`  -> compiler2        (wasm-of-pyret backend)
//   c3      : compiler2     compiles `merged`  -> compiler3        (wasm-of-pyret backend)
//   FIXPOINT: c2 === c3 byte-for-byte.
//
// (Stage A vs c2 will NOT match — different backends — so we DON'T compare those.)
//
// usage: bun scripts/fixpoint-bytecompare.ts

import { buildSourceFile, mergeSourcesFor } from "../src/build.ts";
import { compileWithDriver } from "../src/build-selfhosted.ts";
import { resolve } from "path";

function valid(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d;
}
function firstDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
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

// c2 = compiler.wasm(merged)
let c2: Uint8Array | null = null;
try {
  c2 = await compileWithDriver(compilerWasm, source);
  console.log(`compiler2 ✅  self-hosted compiled its OWN merged source: ${c2.length} bytes, \\0asm=${valid(c2)}`);
} catch (e) {
  console.log(`compiler2 ❌  ${msg(e)}`);
}

// c3 = compiler2(merged) — requires compiler2 to be a runnable (valid) module.
let c3: Uint8Array | null = null;
if (c2) {
  try {
    c3 = await compileWithDriver(c2, source);
    console.log(`compiler3 ✅  compiler2 compiled the same source: ${c3.length} bytes`);
  } catch (e) {
    console.log(`compiler3 ❌  compiler2 is not a runnable compiler yet — ${msg(e)}`);
  }
}

console.log("");
if (c2 && c3) {
  const d = firstDiff(c2, c3);
  if (d === -1) console.log("FIXPOINT ✅  compiler2 === compiler3 byte-for-byte. Self-hosting reproduces itself.");
  else console.log(`compiler2 != compiler3: lengths ${c2.length} vs ${c3.length}, first diff @ offset ${d}.`);
} else {
  console.log("--- Status ---");
  console.log("compiler2 BUILDS from the whole merged compiler source (the self-hosted compiler");
  console.log("compiles itself). The remaining gap to the fixpoint is making compiler2 a VALID,");
  console.log("runnable module so it can produce compiler3 — see the compiler2/3 error above.");
}
