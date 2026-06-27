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
import { run, newHostState, buildHostImports, PyretError } from "../src/runtime/run.ts";
import { resolve } from "path";

const PROBE = resolve(import.meta.dir, "../self-host/pyret-parser-probe.arr");
const PROBE2 = resolve(import.meta.dir, "../self-host/pyret-parser-probe2.arr");
const PROBE3 = resolve(import.meta.dir, "../self-host/pyret-parser-probe3.arr");
const PROBE4 = resolve(import.meta.dir, "../self-host/pyret-parser-probe4.arr");
// Reads a REAL source file via `read-source()` and parses it with the pure-Pyret
// parser, printing `ok stmts=N` / `first=<label>` (asserted below).
const REALFILE_PROBE = resolve(import.meta.dir, "../self-host/pyret-parser-realfile-probe.arr");

// Compile the realfile probe once, then run it against several real source files by
// feeding each file's bytes as `state.sourceBytes` (what `read-source()` returns).
async function parseRealFile(probeWasm: Uint8Array, srcPath: string): Promise<string> {
  const src = await Bun.file(srcPath).text();
  const state = newHostState();
  state.sourceBytes = new TextEncoder().encode(src);
  const { instance } = await WebAssembly.instantiate(probeWasm as BufferSource, buildHostImports(state));
  state.instance = instance;
  state.memory = instance.exports.memory as WebAssembly.Memory;
  try { state.memory.grow(1500); } catch { /* already large enough */ }
  try { (instance.exports.main as () => void)(); }
  catch (e) { if (!(e instanceof PyretError)) throw e; state.stdout((e as Error).message + "\n"); }
  return state.captured;
}

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

// REAL compiler/library source files parse end-to-end into the real ast.arr AST,
// no JS — exercising for-loops (multi-bind), triple-backtick doc strings, unary
// minus, contract statements (ty-params + no-paren arrow anns), curly-brace
// lambdas, and `include from M: ... end`.  These are actual files from the
// self-hosted compiler / its trove, fed via `read-source()`.
test("pure-Pyret parser: parses real compiler source files", async () => {
  const wasm = await buildSourceFile(REALFILE_PROBE);
  // encoder.arr: the in-Pyret WASM binary encoder (uses triple-backtick docs,
  // many top-level fun defs).  (Exact count drifts as the backend grows — assert
  // it parses cleanly into many s-fun/s-let top-levels rather than a brittle count.)
  const enc = await parseRealFile(wasm, resolve(import.meta.dir, "../self-host/encoder.arr"));
  expect(enc).toContain("ok stmts=");
  expect(enc).toContain("first=s-fun");

  // arrays.arr: provide-block, newtype, generics on fun/method, contract
  // statements (`name :: <A> ... -> ...`), and curly-brace lambdas.
  const arr = await parseRealFile(wasm, resolve(import.meta.dir, "../self-compiler/trove/arrays.arr"));
  expect(arr).toContain("ok stmts=30");

  // concat-lists.arr: multi-binding `for` loops + data with sharing methods.
  const cl = await parseRealFile(wasm, resolve(import.meta.dir, "../self-compiler/compiler/concat-lists.arr"));
  expect(cl).toContain("ok stmts=14");

  // matrix-util.arr: `include from G: ... end` (incl. `type *`), unary minus.
  const mu = await parseRealFile(wasm, resolve(import.meta.dir, "../self-compiler/trove/matrix-util.arr"));
  expect(mu).toContain("ok stmts=34");

  // tables.arr: the `table:` literal grammar (table-expr: headers + `row:` rows).
  const tbl = await parseRealFile(wasm, resolve(import.meta.dir, "../self-compiler/trove/tables.arr"));
  expect(tbl).toContain("ok stmts=21");
});

// The LARGE core compiler/library files (80–130KB) parse end-to-end with the
// pure-Pyret parser — combining constant-stack tokenizing/parsing, the runtime's
// linear-memory auto-grow, and the grammar gaps closed here (trailing comma in a
// `with:` block before the next variant; `for f(loc)(b from e)` iterator-as-app;
// `{(a + b) - c; d}` parenthesized first tuple item vs `{(args): ...}` lambda).
// 83 of 84 real `self-compiler/**`+`self-host/*` files now parse for grammar; only
// matrices.arr (generic instantiation `f<T>(...)` — ambiguous LANGLE/LT) remains.
test("pure-Pyret parser: parses the large core compiler files", async () => {
  const wasm = await buildSourceFile(REALFILE_PROBE);
  for (const f of [
    "../self-compiler/trove/ast.arr",
    "../self-compiler/trove/lists.arr",
    "../self-compiler/compiler/compile-structs.arr",
    "../self-compiler/trove/checker.arr",
  ]) {
    const out = await parseRealFile(wasm, resolve(import.meta.dir, f));
    expect(out).toContain("ok stmts=");  // parsed without a grammar error
    expect(out).toContain("first=");
  }
});

// LARGE files that previously overflowed the WASM call stack ("Maximum call stack
// size exceeded") now parse, because the tokenizer (`lex`) and statement-list parse
// (`parse-stmts`) are tail-recursive (constant stack via the seed's native tail
// calls).  well-formed.arr is 1410 lines; anf.arr is 452 — both well past the depth
// that overflowed before.  (The very largest — resolve-scope/ast/type-check — still
// hit a separate "Length out of range of buffer" host/memory limit, see notes.)
test("pure-Pyret parser: large compiler files parse (constant-stack tokenizer/parser)", async () => {
  const wasm = await buildSourceFile(REALFILE_PROBE);
  const anf = await parseRealFile(wasm, resolve(import.meta.dir, "../self-compiler/compiler/anf.arr"));
  expect(anf).toContain("ok stmts=");
  expect(anf).not.toContain("Maximum call stack");
  const wf = await parseRealFile(wasm, resolve(import.meta.dir, "../self-compiler/compiler/well-formed.arr"));
  expect(wf).toContain("ok stmts=");
  expect(wf).not.toContain("Maximum call stack");
});
