#!/usr/bin/env bun
// FIXPOINT BYTE-COMPARE — the endgame gate for self-hosting.
//
// The TRUE fixpoint criterion: the SELF-HOSTED compiler, run on ITS OWN SOURCE, produces
// a compiler (compiler2); compiler2 run on the same source produces compiler3; and
// compiler2 === compiler3 byte-for-byte (a stable fixed point). At that point the seed is
// no longer in the loop and the self-hosted compiler is self-reproducing.
//
// What this script measures TODAY (a progress report — always exits 0):
//   Stage A : seed compiles the driver source            -> driverA.wasm   (the seed's backend)
//   Stage B : the self-hosted compiler compiles the SAME  -> driverB.wasm   (wasm-of-pyret backend)
//   Compare : lengths + first differing byte offset.
//
// IMPORTANT: Stage A and Stage B will NOT match and are NOT expected to — they are produced
// by DIFFERENT backends (seed = binaryen; self-hosted = the Pyret-written wasm-of-pyret).
// The real fixpoint compares Stage B against Stage B-of-B (same backend, twice), which
// requires the self-hosted compiler to FULLY compile its own multi-module source first
// (see `bun scripts/selfhost-modules.ts` for how far that is). This script reports whether
// Stage B compiles at all yet and, if so, sets up the byte-compare scaffold.
//
// usage: bun scripts/fixpoint-bytecompare.ts

import { compileSelfHostedDriver, buildSourceSelfHosted } from "../src/build-selfhosted.ts";
import { resolve } from "path";

const TIMEOUT_MS = 90_000;
function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms))]);
}

function firstDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

console.log("=== Fixpoint byte-compare (progress report) ===\n");

const DRIVER_SRC = resolve(import.meta.dir, "../self-host/compile-driver.arr");
const ownSrc = await Bun.file(DRIVER_SRC).text();
console.log(`compiler driver source: self-host/compile-driver.arr (${ownSrc.length} chars)\n`);

// ── Stage A : seed backend ──────────────────────────────────────────────────────
let driverA: Uint8Array | null = null;
try {
  driverA = await compileSelfHostedDriver();
  console.log(`Stage A ✅  seed-compiled driver (binaryen backend): ${driverA.length} bytes`);
} catch (e) {
  console.log(`Stage A ❌  ${String((e as Error).message ?? e).split("\n")[0]}`);
}

// ── Stage B : self-hosted backend on the SAME source ──────────────────────────────
let driverB: Uint8Array | null = null;
try {
  driverB = await withTimeout(buildSourceSelfHosted(ownSrc));
  console.log(`Stage B ✅  self-hosted-compiled driver (wasm-of-pyret backend): ${driverB.length} bytes`);
} catch (e) {
  console.log(`Stage B ❌  ${String((e as Error).message ?? e).replace(/\x1b\[[0-9;]*m/g, "").split("\n")[0]}`);
  console.log("            (the self-hosted compiler can't yet compile its full own source;");
  console.log("             run `bun scripts/selfhost-modules.ts` for the per-module roadmap.)");
}

// ── Compare ───────────────────────────────────────────────────────────────────────
console.log("");
if (driverA && driverB) {
  const valid = (b: Uint8Array) => b.length >= 4 && b[0] === 0 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d;
  console.log(`Stage A valid \\0asm: ${valid(driverA)};  Stage B valid \\0asm: ${valid(driverB)}`);
  const d = firstDiff(driverA, driverB);
  if (d === -1) console.log("A === B byte-for-byte (note: cross-backend match would be coincidental).");
  else console.log(`A vs B: lengths ${driverA.length} vs ${driverB.length}; first differing byte @ offset ${d} (EXPECTED — different backends).`);
} else {
  console.log("Byte-compare skipped (need both stages to produce bytes).");
}

console.log("\n--- True fixpoint criterion ---");
console.log("Compare Stage B against Stage-B-of-Stage-B (self-hosted backend run twice on its");
console.log("OWN full source). Reaching it requires the self-hosted compiler to compile the");
console.log("whole multi-module compiler closure — tracked by scripts/selfhost-modules.ts.");
