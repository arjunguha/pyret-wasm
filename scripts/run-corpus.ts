#!/usr/bin/env bun
// Scoreboard: run Pyret's own .arr test corpus through our pipeline and
// categorize each outcome. Each file runs in a subprocess with a timeout so
// infinite loops / crashes are isolated.
//
// usage: bun scripts/run-corpus.ts [glob-root] [--show-errors] [--limit N]

import { Glob } from "bun";
import { resolve } from "path";

// The corpus is copied into the repo (test-corpus/, from Pyret's own tests). Default
// to the behavioral subset; pass "test-corpus" to score the full ~339-file corpus.
const root = process.argv[2] && !process.argv[2].startsWith("--")
  ? process.argv[2]
  : "test-corpus/pyret/tests";
const showErrors = process.argv.includes("--show-errors");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg >= 0 ? parseInt(process.argv[limitArg + 1]!) : Infinity;

const TIMEOUT_MS = 8000;

interface Outcome {
  file: string;
  category: "pass" | "check-fail" | "parse-error" | "compile-error" | "runtime-error" | "timeout";
  detail?: string;
}

async function runFile(file: string): Promise<Outcome> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "run", file], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(9), TIMEOUT_MS);
  let exited: number;
  try {
    exited = await proc.exited;
  } finally {
    clearTimeout(timer);
  }
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();

  if (proc.killed && exited !== 0 && !err && !out) {
    return { file, category: "timeout" };
  }
  if (exited === 0) {
    if (/\d+ failed/.test(out) || /test failed/.test(out)) {
      return { file, category: "check-fail", detail: firstLine(out) };
    }
    return { file, category: "pass" };
  }
  // non-zero exit: classify by stderr
  const firstErr = firstLine(err) || firstLine(out);
  if (/^parse error/i.test(firstErr)) return { file, category: "parse-error", detail: firstErr };
  if (/^compile error/i.test(firstErr) || /unsupported/i.test(firstErr)) {
    return { file, category: "compile-error", detail: firstErr };
  }
  return { file, category: "runtime-error", detail: firstErr };
}

function firstLine(s: string): string {
  const line = (s.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
  // strip absolute paths so the message (the useful part) survives truncation
  return line.replace(/\/\S*?\.arr/g, "<f>").slice(0, 200);
}

const glob = new Glob("**/*.arr");
const files: string[] = [];
for await (const f of glob.scan(root)) files.push(resolve(root, f));
files.sort();
const todo = files.slice(0, limit);

const counts: Record<string, number> = {};
const compileErrs: Record<string, number> = {};
const results: Outcome[] = [];

let done = 0;
for (const f of todo) {
  const o = await runFile(f);
  results.push(o);
  counts[o.category] = (counts[o.category] ?? 0) + 1;
  if ((o.category === "compile-error" || o.category === "parse-error") && o.detail) {
    // detail like "compile error at <f>:12:3: unsupported expression: foo"
    const msg = o.detail.split(/<f>:\d+:\d+:\s*/).slice(1).join("").trim()
      || o.detail.replace(/^compile error:?\s*/, "").trim();
    // group by the full message (keeps the specific identifier / node type)
    compileErrs[msg] = (compileErrs[msg] ?? 0) + 1;
  }
  done++;
  if (done % 20 === 0) process.stderr.write(`  ...${done}/${todo.length}\n`);
}

console.log(`\n=== Corpus results (${todo.length} files under ${root}) ===`);
for (const cat of ["pass", "check-fail", "parse-error", "compile-error", "runtime-error", "timeout"]) {
  if (counts[cat]) console.log(`  ${cat.padEnd(14)} ${counts[cat]}`);
}
console.log(`\nTop blockers (compile/parse-error messages):`);
Object.entries(compileErrs).sort((a, b) => b[1] - a[1]).slice(0, 30)
  .forEach(([k, n]) => console.log(`  ${String(n).padStart(4)}  ${k}`));

if (showErrors) {
  console.log(`\nPer-file:`);
  for (const o of results) {
    console.log(`  [${o.category}] ${o.file.replace(process.cwd() + "/", "")}${o.detail ? "  — " + o.detail : ""}`);
  }
}
