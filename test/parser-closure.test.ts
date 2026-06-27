// The pure-Pyret (no-JS) parser parses the ENTIRE self-hosted compiler closure.
// `self-host/pyret-parser.arr` is a hand-rolled tokenizer + recursive-descent parser
// written in Pyret; here we feed it real compiler/library source files (via the
// realfile probe's `read-source()` path) and assert they parse into a real ast.arr
// program.  This is the no-JS-fixpoint prerequisite: the compiler must be able to
// parse its own source with no JavaScript.
//
// The last grammar gap was generic INSTANTIATION (`name<Ann,...>(...)`) — the
// LANGLE-vs-LT ambiguity (`<`/`>` lex as comparison ops).  Resolved by a lookahead:
// a `<` with no whitespace-before whose matching `>` is immediately followed by `(`
// is a type application; a real comparison stays an s-op.

import { test, expect } from "bun:test";
import { buildSourceFile } from "../src/build.ts";
import { run, newHostState, buildHostImports, PyretError } from "../src/runtime/run.ts";
import { resolve } from "path";

const REALFILE_PROBE = resolve(import.meta.dir, "../self-host/pyret-parser-realfile-probe.arr");

async function parseRealFile(probeWasm: Uint8Array, srcPath: string): Promise<string> {
  const src = await Bun.file(srcPath).text();
  const state = newHostState();
  state.sourceBytes = new TextEncoder().encode(src);
  const { instance } = await WebAssembly.instantiate(probeWasm as BufferSource, buildHostImports(state));
  state.instance = instance;
  state.memory = instance.exports.memory as WebAssembly.Memory;
  try { state.memory.grow(2000); } catch { /* already large enough */ }
  try { (instance.exports.main as () => void)(); }
  catch (e) { if (!(e instanceof PyretError)) throw e; state.stdout((e as Error).message + "\n"); }
  return state.captured;
}

// Representative files across the closure, including the two that used to be the
// last holdouts: matrices.arr (generic instantiation) and a locator (recently added).
const CLOSURE_FILES = [
  "../self-compiler/trove/matrices.arr",          // generic instantiation in a `for` iterator
  "../self-compiler/compiler/locators/file.arr",  // a locator module
  "../self-compiler/trove/ast.arr",               // the 3739-LOC AST (memory + constant-stack)
  "../self-compiler/compiler/desugar.arr",
  "../self-compiler/compiler/resolve-scope.arr",  // 1874 LOC — constant-stack over big cases
  "../self-compiler/compiler/type-check.arr",     // 2662 LOC — the largest pass (huge cases)
  "../self-host/wasm-of-pyret.arr",
  // These were FALSELY flagged as parse blockers by the obsolete JS-GLR bridge
  // (serializeCst: "unhandled CST node contract-stmt" / "Parse error near import").
  // The no-JS parser (which surface-parse now uses) handles them fine.
  "../self-compiler/trove/tables.arr",            // top-level `contract-stmt` declarations
  "../self-compiler/trove/timing.arr",            // top-level `contract-stmt` declarations
  "../self-compiler/trove/starter2024.arr",       // an import spec the bridge rejected
];

test("pure-Pyret parser parses the whole self-hosted closure (representative files)", async () => {
  const wasm = await buildSourceFile(REALFILE_PROBE);
  for (const rel of CLOSURE_FILES) {
    const out = await parseRealFile(wasm, resolve(import.meta.dir, rel));
    expect(out).toContain("ok stmts="); // parsed into a non-empty s-program, no parse error
  }
});

// Generic instantiation vs comparison disambiguation (the LANGLE-vs-LT fix).
test("pure-Pyret parser: generic instantiation vs comparison", async () => {
  const probe = resolve(import.meta.dir, "../self-host/pyret-parser-probe5.arr");
  const r = await run(await buildSourceFile(probe));
  const o = r.output;
  expect(o).toContain("inst-expr=s-app/head=s-instantiate"); // f<Number>(3) is an app of an instantiation
  expect(o).toContain("cmp=s-op");                            // a < b stays a comparison
  expect(o).toContain("for-iter=s-instantiate");             // for name<...>(...) iterator
});
