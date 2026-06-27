// END-TO-END self-hosted compile: a Pyret program is compiled to WASM by the
// SELF-HOSTED compiler (self-host/compile-driver.arr) — which is itself compiled
// to WASM by the seed — and the resulting module is instantiated and run.
//
// Pipeline exercised (all written in Pyret, no JS codegen):
//   source --surface-parse--> ast.arr AST --desugar-check--> --desugar-scope-->
//   --resolve-names--> --desugar--> AST visitors --> --anf-program--> ANF
//   --compile-prog--> WASM-GC module bytes (via self-host/encoder.arr + runtime.arr).
//
// The driver emits the target module's bytes via the `emit-byte` host import; we
// collect them, then instantiate+run that module with the normal host imports.
//
// Ladder of supported forms (each builds on the previous):
//   Level 1: bare numeric literals (e.g. "5")
//   Level 2: arithmetic operators (e.g. "2 + 3") — requires desugar + resolve-names
//   Level 3: conditionals (e.g. "if true: 1 else: 2 end")
//   Level 4: single-argument function definition + application

import { test, expect } from "bun:test";
import { resolve } from "path";
import { buildSourceFile } from "../src/build.ts";
import { parsePyret } from "../src/parser/pyret-parser.ts";
import { serializeCst } from "../src/runtime/parse-bridge.ts";
import { buildHostImports, newHostState, run } from "../src/runtime/run.ts";

const DRIVER = resolve(import.meta.dir, "../self-host/compile-driver.arr");

// seed-compile the self-hosted driver once (it's large)
let _driver: Uint8Array | null = null;
async function driverWasm(): Promise<Uint8Array> {
  if (!_driver) _driver = await buildSourceFile(DRIVER);
  return _driver;
}

// Run the self-hosted compiler on `src`, returning the emitted target module bytes.
async function selfHostCompile(src: string): Promise<Uint8Array> {
  const state = newHostState(() => {});
  state.sourceBytes = new TextEncoder().encode(src);
  state.parseNodes = serializeCst(await parsePyret(src)); // prime the JS-GLR bridge
  const { instance } = await WebAssembly.instantiate(await driverWasm() as BufferSource, buildHostImports(state));
  state.instance = instance;
  state.memory = instance.exports.memory as WebAssembly.Memory;
  (instance.exports.main as () => void)();
  return new Uint8Array(state.emitted);
}

// Helper: compile src with the self-hosted compiler and run the resulting module.
// Returns { bytes, result } where result is the RunResult of the compiled module.
async function selfHostRun(src: string): Promise<{ bytes: Uint8Array; result: Awaited<ReturnType<typeof run>> }> {
  const bytes = await selfHostCompile(src);
  expect(bytes.length).toBeGreaterThan(8);
  expect(Array.from(bytes.slice(0, 4))).toEqual([0, 0x61, 0x73, 0x6d]); // \0asm magic
  const result = await run(bytes);
  return { bytes, result };
}

// ─── Level 1: bare numeric literal ────────────────────────────────────────────
test("self-hosted compiler emits a valid WASM module for a literal", async () => {
  const bytes = await selfHostCompile("5");
  expect(bytes.length).toBeGreaterThan(8);
  expect(Array.from(bytes.slice(0, 4))).toEqual([0, 0x61, 0x73, 0x6d]); // \0asm
  // it VALIDATES (instantiate throws on an invalid module) and RUNS without trapping
  const r = await run(bytes);
  expect(r.error).toBeUndefined();
});

// ─── Level 2: arithmetic operators ─────────────────────────────────────────────
// "2 + 3" desugars via desugar.arr to s-app(s-id(s-global("_plus")), [2, 3]).
// The pipeline must wire desugar + resolve-names + the AST visitors so that anf-program
// sees s-app-enriched (not s-app). The backend fast-paths global#_plus -> $plus runtime.
test("self-hosted: arithmetic operator 2 + 3 compiles and runs", async () => {
  const { result } = await selfHostRun("2 + 3");
  expect(result.error).toBeUndefined();
});

test("self-hosted: subtraction 10 - 4 compiles and runs", async () => {
  const { result } = await selfHostRun("10 - 4");
  expect(result.error).toBeUndefined();
});

test("self-hosted: chained arithmetic (1 + 2) * 3 compiles and runs", async () => {
  const { result } = await selfHostRun("(1 + 2) * 3");
  expect(result.error).toBeUndefined();
});

// ─── Level 3: conditionals ──────────────────────────────────────────────────────
// "if true: 1 else: 2 end" desugars to s-if-else, then via desugar to
// s-let-expr with s-if-else core form. The truthy test casts to i31 and branches.
test("self-hosted: if true: 1 else: 2 end compiles and runs", async () => {
  const { result } = await selfHostRun("if true: 1 else: 2 end");
  expect(result.error).toBeUndefined();
});

test("self-hosted: if false: 1 else: 2 end compiles and runs", async () => {
  const { result } = await selfHostRun("if false: 1 else: 2 end");
  expect(result.error).toBeUndefined();
});

test("self-hosted: if with arithmetic condition compiles and runs", async () => {
  const { result } = await selfHostRun("if (3 > 1): 100 else: 200 end");
  expect(result.error).toBeUndefined();
});

// ─── Level 4: single-argument function definition + application ─────────────────
// "fun f(x): x + 1 end  f(5)" desugars to a letrec + closure. The closure is
// allocated via a-lam, captured free-vars packed into $Closure.env. Application
// dispatches via the indirect call table (closure-call-type index).
test("self-hosted: single-arg function definition and application compiles and runs", async () => {
  const { result } = await selfHostRun("fun f(x): x + 1 end\nf(5)");
  expect(result.error).toBeUndefined();
});

test("self-hosted: identity function compiles and runs", async () => {
  const { result } = await selfHostRun("fun id(x): x end\nid(42)");
  expect(result.error).toBeUndefined();
});

// ─── Level 5: data declarations, constructors, and cases ────────────────────────
// `data` desugars to s-data-expr (with a generated type name); the driver binds the
// data object + each constructor name from it (so bare `bar(x)` / `baz` resolve). The
// backend emits a constructor fn per variant (table slot = nlams + id) building a
// $Variant, and `cases` does vtag dispatch on $variant_id over the data registry.
//
// These tests use a "trap on wrong value" helper — `expect(v, e)` does `1 / 0` (a
// runtime error) when v != e — so a WRONG cases dispatch / field binding TRAPS and the
// test fails, making `result.error === undefined` a real correctness check.
const DATA_PRELUDE =
  "data Foo: | bar(x) | baz end\n" +
  "fun expect(v, e): if v == e: 0 else: 1 / 0 end end\n";

test("self-hosted: data declaration + constructor call compiles and runs", async () => {
  const { result } = await selfHostRun("data Foo: | bar(x) | baz end\nbar(5)");
  expect(result.error).toBeUndefined();
});

test("self-hosted: cases binds a variant's field (bar(7) -> 7)", async () => {
  const { result } = await selfHostRun(
    DATA_PRELUDE + "expect(cases(Foo) bar(7): | bar(x) => x | baz => 99 end, 7)");
  expect(result.error).toBeUndefined();
});

test("self-hosted: cases dispatches a singleton variant (baz -> 99)", async () => {
  const { result } = await selfHostRun(
    DATA_PRELUDE + "expect(cases(Foo) baz: | bar(x) => x | baz => 99 end, 99)");
  expect(result.error).toBeUndefined();
});

test("self-hosted: a WRONG cases dispatch traps (sanity: the trap-pattern catches it)", async () => {
  // bar(7) yields 7, not 99, so expect(...,99) divides by zero -> a runtime error
  // (a trap makes run() reject), proving the trap-pattern would catch a bad dispatch.
  let threw = false;
  try {
    await selfHostRun(
      DATA_PRELUDE + "expect(cases(Foo) bar(7): | bar(x) => x | baz => 99 end, 99)");
  } catch (_) { threw = true; }
  expect(threw).toBe(true);
});

// ─── Level 6: top-level `let` bindings and `[list: ...]` ────────────────────────
// `x = e` at statement position desugars to s-let-expr over the rest (previously it
// reached ANF as a bare s-let and errored "s-let should have been desugared
// already"). `[list: e1, ...]` lowers to nested link(e1, ... empty); link/empty come
// from the (minimal) List prelude prepended here.  NOTE: recursive list functions
// (length/sum/map) do NOT work yet — a self-recursive call passing a cases-bound
// variant FIELD as its argument hits a backend ref.cast trap (documented in the
// driver); these tests deliberately stay non-recursive.
const LIST_PRELUDE =
  "data List:\n  | empty\n  | link(first, rest)\nend\n" +
  "fun expect(v, e): if v == e: 0 else: 1 / 0 end end\n";

test("self-hosted: top-level let binding compiles and runs", async () => {
  const { result } = await selfHostRun("x = 10\nx + 5");
  expect(result.error).toBeUndefined();
});

test("self-hosted: multiple top-level let bindings compile and run", async () => {
  const { result } = await selfHostRun(
    "fun expect(v, e): if v == e: 0 else: 1 / 0 end end\na = 3\nb = 4\nexpect(a + b, 7)");
  expect(result.error).toBeUndefined();
});

test("self-hosted: [list: ...] literal builds and runs", async () => {
  const { result } = await selfHostRun(LIST_PRELUDE + "[list: 1, 2, 3]");
  expect(result.error).toBeUndefined();
});

test("self-hosted: non-recursive cases over a [list: ...] (head -> 7)", async () => {
  const { result } = await selfHostRun(
    LIST_PRELUDE + "expect(cases(List) [list: 7, 8]: | empty => 0 | link(f, r) => f end, 7)");
  expect(result.error).toBeUndefined();
});

// ─── Level 7: recursion over lists (length / sum) ───────────────────────────────
// A self-recursive function over a `[list: ...]` — recursing on the variant's `rest`
// field — compiles and runs with the CORRECT value.  We verify with an inline `if`
// (`if v == expected: 0 else: 1 / 0 end`) rather than a sibling `expect` helper: a
// recursive function PLUS a sibling helper of different arity in the same top-level
// group currently hits a separate backend trap (documented in the driver); a single
// recursive function is fine.  `if cond: 0 else: 1 / 0` makes a wrong value TRAP, so
// `result.error === undefined` confirms the value is right.
const LIST_LEN =
  "data List:\n  | empty\n  | link(first, rest)\nend\n" +
  "fun len(l):\n  cases(List) l:\n    | empty => 0\n    | link(f, r) => 1 + len(r)\n  end\nend\n";
const LIST_SUM =
  "data List:\n  | empty\n  | link(first, rest)\nend\n" +
  "fun lsum(l):\n  cases(List) l:\n    | empty => 0\n    | link(f, r) => f + lsum(r)\n  end\nend\n";

test("self-hosted: recursive length over a [list:] (== 3)", async () => {
  const { result } = await selfHostRun(LIST_LEN + "if len([list: 1, 2, 3]) == 3: 0 else: 1 / 0 end");
  expect(result.error).toBeUndefined();
});

test("self-hosted: a WRONG length traps (sanity)", async () => {
  let threw = false;
  try { await selfHostRun(LIST_LEN + "if len([list: 1, 2, 3]) == 9: 0 else: 1 / 0 end"); }
  catch (_) { threw = true; }
  expect(threw).toBe(true);
});

test("self-hosted: recursive sum over a [list:] (== 60)", async () => {
  const { result } = await selfHostRun(LIST_SUM + "if lsum([list: 10, 20, 30]) == 60: 0 else: 1 / 0 end");
  expect(result.error).toBeUndefined();
});

// ─── Level 8: `check:` blocks ───────────────────────────────────────────────────
// `check: lhs is rhs end` desugars (driver) to a `check-is` prim-app -> the runtime
// $check_is harness (bumps $passed/$total, reports failures); main emits a guarded
// check_summary($passed,$total) host call so the Pyret-style summary prints.
test("self-hosted: a passing check: block prints the shipshape summary", async () => {
  const { result } = await selfHostRun("check: 1 is 1 end");
  expect(result.error).toBeUndefined();
  expect(result.output).toContain("Looks shipshape");
});

test("self-hosted: a failing check: block reports the failure + results line", async () => {
  const { result } = await selfHostRun("check: 1 is 2 end");
  expect(result.error).toBeUndefined();
  expect(result.output).toContain("test failed");
  expect(result.output).toContain("0 passed, 1 failed");
});

test("self-hosted: is-not + multiple tests in one check: block", async () => {
  const { result } = await selfHostRun("check:\n  2 + 3 is 5\n  4 is-not 5\nend");
  expect(result.error).toBeUndefined();
  expect(result.output).toContain("all 2 tests passed");
});

test("self-hosted: a program with no check: blocks prints no test summary", async () => {
  const { result } = await selfHostRun("2 + 3");
  expect(result.error).toBeUndefined();
  expect(result.output).not.toContain("test");
});
