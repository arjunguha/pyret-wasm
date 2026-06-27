// The PURE-PYRET Pyret parser (self-host/pyret-parser.arr) — a hand-rolled
// tokenizer + recursive-descent parser written entirely in Pyret (no JS), the
// eventual replacement for the temporary JS GLR parser the self-hosted compiler
// leans on.  See self-host/pyret-parser-notes.md for coverage + the plan.
//
// What we can verify TODAY:
//   1. The parser COMPILES clean under the seed (source -> valid \0asm module).
//   2. (tripwire) Running it end-to-end currently hits the same front-end
//      module-init null-ref that affects EVERY program importing ast.arr in the
//      seed right now (being fixed in a separate runtime lane).  When that lands,
//      flip the tripwire test below into the real end-to-end assertion (the
//      commented expectation: parsing "fun f(x): x + 1 end\nf(2)" yields
//      "s-fun s-app").
//
// The tokenizer itself is already validated to run (in isolation from ast.arr)
// during development: it lexes numbers/fractions, strings, multi-char operators,
// dash-bearing identifiers (is-empty as ONE token), and — crucially — sets the
// whitespace-before flag so `f(x)` (application) is told apart from `g (y)`
// (grouping).  Those checks need no ast import; this file covers the AST path.

import { test, expect } from "bun:test";
import { buildSourceFile } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";
import { resolve } from "path";

const PROBE = resolve(import.meta.dir, "../self-host/pyret-parser-probe.arr");

test("pure-Pyret parser compiles clean under the seed (-> valid wasm)", async () => {
  const wasm = await buildSourceFile(PROBE);
  expect(wasm.length).toBeGreaterThan(8);
  expect(Array.from(wasm.slice(0, 4))).toEqual([0, 0x61, 0x73, 0x6d]); // \0asm
});

// END-TO-END: the pure-Pyret parser parses real source into the real ast.arr AST,
// entirely in Pyret (no JS).  (ast.arr loads fine in the seed — only desugar/
// well-formed/resolve-scope hit the module-init null-ref, which the parser doesn't
// import — so this runs today.)
test("pure-Pyret parser: parses fun + app into the real AST", async () => {
  const r = await run(await buildSourceFile(PROBE));
  expect(r.output.trim()).toBe("s-fun s-app");
});
