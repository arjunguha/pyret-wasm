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
