// AST-to-AST CPS transform (self-host/cps-ast.arr) — the AST-consuming successor to
// cps.arr that lets us drop the JS-GLR parser from the web runtime. This test drives
// it through the seed-compiled cps-ast-driver.arr, which:
//   raw source --(pure-Pyret parser, pyret-parser.arr)--> ast.arr nodes
//              --(cps-ast.arr cps-program)--> CPS'd ast.arr nodes
//              --(.tosource(), TEST shim only)--> CPS'd Pyret source.
// We then compile that source with the seed's {stoppable:true} codegen and run it
// under the single-thread trampoline (run-stoppable). In production the CPS'd AST
// feeds the self-hosted backend DIRECTLY (no .tosource(), no re-parse); the render
// here exists only because the seed backend (which has the stoppability codegen
// today) consumes the JS-GLR parser's CST, not ast.arr nodes. Moving the
// stoppability intrinsics to the self-hosted backend is a SEPARATE workstream; this
// test verifies the transform's correctness in the meantime.
//
// ORACLE = COMPILER #2 (the self-hosted compiler compiled by the seed,
// `runSourceSelfHosted`). Per the project's three-compiler model the CPS transform
// must preserve meaning as judged by compiler #2 running the ORIGINAL program. So
// for each program we assert: CPS'd-via-cps-ast (run stoppable) == original-via-#2.
//
// SCOPE TODAY mirrors cps-ast.arr's step-1 core: arithmetic, if/else, fun + app,
// recursion, `and`/`or` SHORT-CIRCUIT (the cps.arr gap this file fixes), and nested
// let. Programs avoid the free prelude HOFs (map/foldl/range) — compiler #2 injects
// only a minimal List, so those aren't runnable as a bare oracle program (same
// constraint as test/stoppable.test.ts).
import { test, expect } from "bun:test";
import { resolve } from "path";
import { buildSourceFile } from "../src/build.ts";
import { newHostState, buildHostImports } from "../src/runtime/run.ts";
import { parsePyret } from "../src/parser/pyret-parser.ts";
import { compile } from "../src/compiler/compile.ts";
import { runStoppable } from "../src/runtime/run-stoppable.ts";
import { runSourceSelfHosted } from "../src/build-selfhosted.ts";

const DRIVER = resolve(import.meta.dir, "../self-host/cps-ast-driver.arr");

// Seed-compile the cps-ast driver once (it bundles pyret-parser.arr + cps-ast.arr).
let _driver: Promise<Uint8Array> | null = null;
function driverWasm(): Promise<Uint8Array> {
  if (!_driver) _driver = buildSourceFile(DRIVER);
  return _driver;
}

// Run the driver on RAW source (delivered via read-source()); returns the CPS'd
// Pyret source it prints.
async function cpsAstTransform(src: string): Promise<string> {
  const driver = await driverWasm();
  const state = newHostState();
  state.sourceBytes = new TextEncoder().encode(src);
  const imports = buildHostImports(state);
  const { instance } = await WebAssembly.instantiate(driver as BufferSource, imports);
  state.instance = instance;
  const mem = instance.exports.memory as WebAssembly.Memory;
  state.memory = mem;
  // The parser + output build up in linear memory; the seed's bump allocator doesn't
  // grow memory itself, so pre-grow with margin (seed max = 256 pages).
  const need = state.sourceBytes.length * 16 + (4 << 20);
  const have = mem.buffer.byteLength;
  if (need > have) {
    const want = Math.ceil((need - have) / 65536);
    const room = 256 - Math.ceil(have / 65536);
    if (room > 0) { try { mem.grow(Math.min(want, room)); } catch { /* best effort */ } }
  }
  (instance.exports.main as () => void)();
  return state.captured.trim();
}

// ACTUAL: cps-ast transform -> seed stoppable codegen -> trampoline run.
async function evalCpsAst(src: string): Promise<string> {
  const cps = await cpsAstTransform(src);
  const full = await parsePyret(cps);
  const wasm = compile(full, { stoppable: true });
  const r = await runStoppable(wasm, { noYield: true }).promise;
  if (r.error) throw new Error(`${r.error}\n--- CPS'd source ---\n${cps}`);
  return r.output.trimEnd();
}

// ORACLE: compiler #2 (self-hosted compiler compiled by the seed) on the ORIGINAL.
async function evalSelfHosted(src: string): Promise<string> {
  return (await runSourceSelfHosted(src)).trimEnd();
}

// run-stoppable echoes a trailing top-level `nothing` (finish-result prints it) that
// compiler #2 doesn't — strip it on both sides so only the `print(...)` observable
// is compared. Each program ends in `nothing` so the top-level result is nothing.
function stripNothing(s: string): string {
  return s.split("\n").filter((l) => l !== "nothing").join("\n").trimEnd();
}

test("cps-ast: matches COMPILER #2 on core constructs", async () => {
  for (const src of [
    "print(1 + 2)\nnothing",                                                       // arithmetic
    "print((10 - 3) + (4 * 2))\nnothing",                                          // nested arithmetic (parens)
    "print(if 3 > 1: 100 else: 200 end)\nnothing",                                 // if / else
    "fun add1(n): n + 1 end\nprint(add1(41))\nnothing",                            // fun + app
    "fun sm(n, s): if n <= 0: s else: sm(n - 1, s + n) end end\nprint(sm(5, 0))\nnothing", // recursion
    "x = 10\ny = x + 5\nprint(x + y)\nnothing",                                     // nested let (top level)
    "fun f(n): a = n + 1\n b = a * 2\n b end\nprint(f(10))\nnothing",              // let-block in a fun body
    "print(if true: 1 else: 2 end)\nnothing",                                      // bool literal in test
  ]) {
    expect(stripNothing(await evalCpsAst(src)), src).toBe(stripNothing(await evalSelfHosted(src)));
  }
});

// `and`/`or` must SHORT-CIRCUIT: the right operand is only evaluated when reached.
// cps.arr lowered these to a strict `(a and b)` (evaluating BOTH); cps-ast desugars
// to `if`. We probe it with a right operand that would RAISE (1 / 0) if evaluated:
// the program only runs to completion if the short-circuit holds.
test("cps-ast: and/or short-circuit (right operand not evaluated)", async () => {
  for (const src of [
    "print(false and (1 / 0 == 0))\nnothing", // -> false (rhs would raise)
    "print(true or (1 / 0 == 0))\nnothing",   // -> true  (rhs would raise)
    "print(true and false)\nnothing",         // -> false (both safe)
    "print(false or true)\nnothing",          // -> true
  ]) {
    expect(stripNothing(await evalCpsAst(src)), src).toBe(stripNothing(await evalSelfHosted(src)));
  }
});
