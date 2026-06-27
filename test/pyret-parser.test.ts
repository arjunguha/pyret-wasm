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
const PROBE2 = resolve(import.meta.dir, "../self-host/pyret-parser-probe2.arr");
const PROBE3 = resolve(import.meta.dir, "../self-host/pyret-parser-probe3.arr");
const PROBE4 = resolve(import.meta.dir, "../self-host/pyret-parser-probe4.arr");

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
  // output also carries ast.arr's own check-block footer; assert the parse result line
  expect(r.output.trim().startsWith("s-fun s-app")).toBe(true);
});

// Richer grammar: full annotations (name / app / arrow), `type` aliases, and
// tuple-binding args — all parsed into the real ast.arr AST end-to-end.
test("pure-Pyret parser: annotations, type aliases, tuple bindings", async () => {
  const r = await run(await buildSourceFile(PROBE2));
  const o = r.output;
  expect(o).toContain("stmts: s-type s-fun s-fun");
  expect(o).toContain("ret: a-name");
  expect(o).toContain("arg0: a-name");
  expect(o).toContain("arg1: a-arrow");      // (Number -> String)
  expect(o).toContain("talias: s-type a-app"); // List<Number>
  expect(o).toContain("hbind: s-tuple-bind"); // fun h({a; b}): ...
});

// Real source locations: line/column/char offsets + source name thread through
// (no more dummy-loc on the primary nodes).
test("pure-Pyret parser: produces real source locations", async () => {
  const r = await run(await buildSourceFile(PROBE3));
  const o = r.output;
  expect(o).toContain("app: test.arr 2:0-2:4 char 20-24"); // f(2) on line 2
  expect(o).toContain("op: line 1 col 10 char 10");          // x + 1 op
  expect(o).toContain("is-srcloc: true");                    // not a builtin/dummy loc
});

// Round-3 grammar: full check-ops (incl. is%(refine) and the does-not-raise
// postfix), multi-let / letrec / type-let, spy, exact decimals + rough integers,
// and tuple-destructuring let — all into the real ast.arr AST end-to-end.
test("pure-Pyret parser: let/letrec/type-let, check-ops, spy, decimals", async () => {
  const r = await run(await buildSourceFile(PROBE4));
  const o = r.output;
  expect(o).toContain("stmts: s-let s-let s-let s-letrec s-type-let s-check s-spy-block");
  expect(o).toContain("dec: 157/50");                 // 3.14 -> exact rational
  expect(o).toContain("rough: s-num true");           // ~5 -> roughnum-valued s-num
  expect(o).toContain("tuplelet: s-tuple-bind");      // {a; b} = {1; 2}
  expect(o).toContain("multilet: s-let binds=2 body=s-block");
  expect(o).toContain("letrec: s-letrec binds=1");
  expect(o).toContain("typelet: s-type-let s-type-bind");
  expect(o).toContain("checkops: [list: s-op-is, s-op-is-not, s-op-raises-not, s-op-is]");
  expect(o).toContain("postfix-none: true");          // does-not-raise has no RHS
  expect(o).toContain("refine-some: true");           // is%(within(1)) carries a refinement
  expect(o).toContain("spy: s-spy-block msg=true implicit=true");
});
