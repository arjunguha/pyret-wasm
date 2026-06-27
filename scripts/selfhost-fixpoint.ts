#!/usr/bin/env bun
// SELF-HOSTING FIXPOINT meter — progress toward the REAL self-hosted Pyret->WASM
// compiler reproducing itself. (The older toy `selfhost/compiler.arr` microcosm has
// its own discipline in test/selfhost.test.ts via src/build-selfhost.ts; THIS meter
// tracks the real driver self-host/compile-driver.arr via src/build-selfhosted.ts.)
//
//   Stage A : seed compiles self-host/compile-driver.arr -> driver.wasm           (done today)
//   Ladder  : how far up the language the self-hosted compiler currently reaches   (meter)
//   Stage B : the self-hosted compiler compiles real compiler source              (aspirational)
//   FIXPOINT: ... eventually it compiles its OWN source byte-identically.
//
// This is a PROGRESS REPORT, not a pass/fail gate: it always exits 0 and prints what
// compiles self-hosted, what doesn't, and the next blocker to implement.
//
// usage: bun scripts/selfhost-fixpoint.ts

import { compileSelfHostedDriver, buildSourceSelfHosted } from "../src/build-selfhosted.ts";
import { run } from "../src/runtime/run.ts";
import { resolve } from "path";

const TIMEOUT_MS = 60_000;
function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms))]);
}

// Try to compile (and optionally run) a program with the self-hosted compiler.
// Returns null on success, or the first blocker message.
async function selfHostBlocker(src: string, doRun = true): Promise<string | null> {
  try {
    const bytes = await withTimeout(buildSourceSelfHosted(src));
    if (doRun) {
      const r = await withTimeout(run(bytes));
      if (r.error) return "runtime: " + r.error.split("\n")[0];
    }
    return null;
  } catch (e) {
    return String((e as Error).message ?? e).split("\n")[0];
  }
}

console.log("=== Self-hosting fixpoint meter (real compiler) ===\n");

// ── Stage A ───────────────────────────────────────────────────────────────────
const driver = await compileSelfHostedDriver();
console.log(`Stage A ✅  seed -> self-host/compile-driver.arr  (${driver.length} bytes of WASM)\n`);

// ── Capability ladder ───────────────────────────────────────────────────────────
// Each rung is a representative program; we report whether the self-hosted compiler
// compiles+runs it. Ordered roughly by language complexity.
const LADDER: [string, string][] = [
  ["literal", "5"],
  ["arithmetic", "2 + 3"],
  ["chained arith (parens)", "(1 + 2) * 3"],
  ["comparison", "3 > 1"],
  ["if / else", "if true: 1 else: 2 end"],
  ["function def + app", "block: fun f(x): x + 1 end\n f(5) end"],
  ["lambda", "(lam(x): x + 2 end)(8)"],
  ["object + dot", "{a: 1, b: 2}.b"],
  ["data + cases", "block: data D: | a(n) | b end\n cases(D) a(7): | a(n) => n | b => 0 end end"],
  ["list literal", "[list: 1, 2, 3]"],
  ["check block", "check: 2 + 3 is 5 end"],
  ["print", 'print(5)'],
  ["string concat", '"ab" + "cd"'],
];

let reached = 0;
console.log("Capability ladder (self-hosted compile + run):");
for (const [name, src] of LADDER) {
  const blocker = await selfHostBlocker(src);
  if (blocker === null) { console.log(`  ✅ ${name}`); reached++; }
  else { console.log(`  ❌ ${name.padEnd(24)} — ${blocker}`); }
}
console.log(`\n  → self-hosted reaches ${reached}/${LADDER.length} ladder rungs.\n`);

// ── Stage B: compile real compiler source ────────────────────────────────────────
// The ultimate target is compiling the driver's OWN source (the fixpoint precondition).
// Report the first blocker so we know the next feature to implement.
const DRIVER_SRC = resolve(import.meta.dir, "../self-host/compile-driver.arr");
const ownSrc = await Bun.file(DRIVER_SRC).text();
console.log(`Stage B (aspirational): self-hosted compiler on its OWN source`);
console.log(`  self-host/compile-driver.arr: ${ownSrc.length} bytes`);
const ownBlocker = await selfHostBlocker(ownSrc, /*doRun*/ false);
if (ownBlocker === null) {
  console.log("  ✅ the self-hosted compiler COMPILES its own driver source! (fixpoint within reach — next: byte-compare)");
} else {
  console.log(`  ❌ next blocker: ${ownBlocker}`);
  console.log("\nFIXPOINT: not yet reached. Implement the blocker above (and any failing");
  console.log("ladder rungs) to advance the self-hosted compiler toward compiling itself.");
}

process.exit(0);
