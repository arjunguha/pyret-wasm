#!/usr/bin/env bun
// SELF-COMPILE COVERAGE — the precise roadmap toward full self-hosting.
//
// For every module in the compiler closure (self-compiler/compiler, self-compiler/trove,
// self-host), attempt to compile it with the REAL self-hosted compiler
// (src/build-selfhosted.ts → self-host/compile-driver.arr) and report per-module:
//   ✅ self-compiles   /   ❌ <first blocker>
// then a grouped summary of the top blockers. This is a PROGRESS REPORT (always exits 0).
//
// NB: these are LIBRARY modules (provide/import headers, no `main`); we only test that
// the self-hosted compiler can COMPILE them to a WASM module (emit bytes), not run them.
//
// usage: bun scripts/selfhost-modules.ts [--limit N]

import { buildSourceSelfHosted, compileSelfHostedDriver } from "../src/build-selfhosted.ts";
import { readdirSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const DIRS = ["self-compiler/compiler", "self-compiler/trove", "self-host"];
const TIMEOUT_MS = 45_000;

const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;

function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms))]);
}

// Collect closure modules (skip parser/driver test probes, which aren't compiler modules).
const modules: string[] = [];
for (const d of DIRS) {
  let names: string[];
  try { names = readdirSync(resolve(ROOT, d)); } catch { continue; }
  for (const n of names.sort()) {
    if (!n.endsWith(".arr")) continue;
    if (n.includes("probe")) continue; // test probes, not compiler modules
    modules.push(`${d}/${n}`);
  }
}

console.log("=== Self-compile coverage (real self-hosted compiler) ===\n");

// Warm the driver once (seed-compiles the Pyret-written compiler to WASM).
const driver = await compileSelfHostedDriver();
console.log(`driver: seed -> self-host/compile-driver.arr (${driver.length} bytes)\n`);

const blockers = new Map<string, number>();
let ok = 0;
let n = 0;

// Normalize a blocker message into a coarse category for grouping.
function categorize(msg: string): string {
  let m = msg.replace(/\x1b\[[0-9;]*m/g, "").split("\n")[0]!.trim();
  m = m.replace(/\s*\(evaluating '[^']*'\)/g, ""); // strip noisy JS eval tails
  const anf = m.match(/Missed case in anf:\s*([\w-]+)/);
  if (anf) return `anf: ${anf[1]} (driver desugar/anf)`;
  const unbound = m.match(/[Uu]nbound (?:identifier|id)[:\s]+([\w-]+)/);
  if (unbound) return `unbound: ${unbound[1]}`;
  const unsup = m.match(/unsupported[:\s]+([\w-]+)/i);
  if (unsup) return `unsupported: ${unsup[1]}`;
  if (/timeout after/.test(m)) return "timeout";
  if (/emitted no bytes/.test(m)) return "emitted no bytes (driver produced nothing)";
  if (/access to a null reference/.test(m)) return "null-ref at module load (compiled, traps at init)";
  if (/undefined is not an object.*a\.name|a\.name/.test(msg)) return "JS error a.name (name-key on non-Name)";
  if (/ref\.cast failed/.test(m)) return "ref.cast failed (GC type mismatch in emitted module)";
  if (/object does not have the requested field/.test(m)) return "no field (method/.visit dispatch)";
  if (/no branch matched|cases:/.test(m)) return "cases: no branch matched";
  return m.slice(0, 60);
}

for (const mod of modules) {
  if (n >= LIMIT) break;
  n++;
  const src = await Bun.file(resolve(ROOT, mod)).text();
  let status: string;
  try {
    const bytes = await withTimeout(buildSourceSelfHosted(src));
    status = `✅ (${bytes.length}B)`;
    ok++;
  } catch (e) {
    const cat = categorize(String((e as Error).message ?? e));
    blockers.set(cat, (blockers.get(cat) ?? 0) + 1);
    status = `❌ ${cat}`;
  }
  console.log(`  ${status.startsWith("✅") ? "✅" : "❌"}  ${mod.padEnd(48)} ${status.replace(/^[✅❌]\s*/, "")}`);
}

console.log(`\n=== Summary: ${ok}/${n} closure modules self-compile ===`);
if (blockers.size > 0) {
  console.log("\nTop blockers (what to implement next for full self-compile):");
  const sorted = [...blockers.entries()].sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of sorted) console.log(`  ${String(count).padStart(3)}  ${cat}`);
}
