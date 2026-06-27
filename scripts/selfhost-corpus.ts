#!/usr/bin/env bun
// SELF-HOSTED SCOREBOARD: for each corpus program, attempt to COMPILE it with
//   (a) the SEED  (src/build.ts buildSourceFile)             — the bootstrap compiler
//   (b) the SELF-HOSTED compiler (src/build-selfhosted.ts)   — Pyret-written, no JS codegen
// and tally compile-success per compiler + a breakdown of the SELF-HOSTED failure
// reasons, so we know exactly what to implement next in the self-hosted pipeline.
//
// We measure COMPILE success (bounded — terminates) rather than running the user
// programs (which can infinite-loop); compilation is what gates self-hosting coverage.
//
// usage: bun scripts/selfhost-corpus.ts [corpus-root] [--limit N] [--show-self-ok]
//   default root: test-corpus/pyret/tests   (pass "test-corpus" for the full ~339)

import { Glob } from "bun";
import { resolve } from "path";
import { buildSourceFile } from "../src/build.ts";
import { compileSelfHostedDriver, compileWithDriver } from "../src/build-selfhosted.ts";

const root = process.argv[2] && !process.argv[2].startsWith("--")
  ? process.argv[2]
  : "test-corpus/pyret/tests";
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg >= 0 ? parseInt(process.argv[limitArg + 1]!) : Infinity;
const showSelfOk = process.argv.includes("--show-self-ok");

// Reduce an error message to a stable CATEGORY so failures group usefully:
//   "Missed case in anf: s-construct(builtin(...), ...)" -> "Missed case in anf: s-construct"
//   parse/compile/unbound errors -> short normalized tags
function categorize(msg: string): string {
  const first = (msg.split("\n").find((l) => l.trim()) ?? msg).trim();
  let m = first.match(/Missed case in (\w[\w-]*):\s*(s-[\w-]+|a-[\w-]+|[\w-]+)/);
  if (m) return `Missed case in ${m[1]}: ${m[2]}`;
  if (/self-hosted compiler emitted no bytes/.test(first)) return "emitted no bytes";
  if (/parse error/i.test(first)) return "parse error";
  if (/unbound|not (defined|in scope)/i.test(first)) return "unbound/undefined name";
  if (/object does not have the requested field|requested field/i.test(first)) return "missing field (visitor/method)";
  if (/out of bounds|null reference|unreachable/i.test(first)) return "wasm trap (oob/null/unreachable)";
  if (/compile error/i.test(first)) {
    const tail = first.replace(/.*compile error[^:]*:\s*/i, "").replace(/\/\S*?\.arr\S*/g, "<f>");
    return "compile error: " + tail.slice(0, 60);
  }
  // generic: strip paths + arg payloads, keep the leading phrase
  return first.replace(/\([^)]*\)/g, "(…)").replace(/\/\S*?\.arr\S*/g, "<f>").slice(0, 70);
}

const glob = new Glob("**/*.arr");
const files: string[] = [];
for await (const f of glob.scan(root)) files.push(resolve(root, f));
files.sort();
const todo = files.slice(0, limit);

console.error(`Compiling the self-hosted driver once (this is the slow part)…`);
const driver = await compileSelfHostedDriver();
console.error(`Driver ready (${driver.length} bytes). Scoring ${todo.length} files under ${root}…\n`);

let seedOk = 0, selfOk = 0, seedErr = 0;
const selfErrs: Record<string, number> = {};
const selfOkFiles: string[] = [];

let done = 0;
for (const f of todo) {
  const text = await Bun.file(f).text();

  // (a) SEED — full capability (prelude + local module loading via buildSourceFile)
  let seedCompiles = false;
  try { await buildSourceFile(f); seedCompiles = true; seedOk++; }
  catch { seedErr++; }

  // (b) SELF-HOSTED — the Pyret-written compiler driver on the program source
  try {
    await compileWithDriver(driver, text);
    selfOk++;
    selfOkFiles.push(f);
  } catch (e) {
    const cat = categorize(String((e as Error)?.message ?? e));
    selfErrs[cat] = (selfErrs[cat] ?? 0) + 1;
  }

  done++;
  if (done % 20 === 0) console.error(`  …${done}/${todo.length}  (seed ${seedOk}, self-hosted ${selfOk})`);
  void seedCompiles;
}

const pct = (n: number) => `${n} (${((100 * n) / todo.length).toFixed(1)}%)`;
console.log(`\n=== SELF-HOSTED SCOREBOARD — ${todo.length} files under ${root} ===`);
console.log(`  seed compiles:         ${pct(seedOk)}`);
console.log(`  seed fails:            ${seedErr}`);
console.log(`  self-hosted compiles:  ${pct(selfOk)}`);
console.log(`  self-hosted fails:     ${todo.length - selfOk}`);

console.log(`\nTop self-hosted failure reasons (what to implement next):`);
Object.entries(selfErrs).sort((a, b) => b[1] - a[1]).slice(0, 25)
  .forEach(([k, n]) => console.log(`  ${String(n).padStart(4)}  ${k}`));

if (showSelfOk) {
  console.log(`\nPrograms the SELF-HOSTED compiler handles today:`);
  for (const f of selfOkFiles) console.log(`  ${f.replace(process.cwd() + "/", "")}`);
}
