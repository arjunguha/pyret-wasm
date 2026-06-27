// END-TO-END self-hosted compile: a Pyret program is compiled to WASM by the
// SELF-HOSTED compiler (self-host/compile-driver.arr) — which is itself compiled
// to WASM by the seed — and the resulting module is instantiated and run.
//
// Pipeline exercised (all written in Pyret, no JS codegen):
//   source --surface-parse--> ast.arr AST --anf-program--> ANF --compile-prog-->
//   WASM-GC module bytes (via self-host/encoder.arr + runtime.arr).
//
// The driver emits the target module's bytes via the `emit-byte` host import; we
// collect them, then instantiate+run that module with the normal host imports.
//
// Currently the driver handles already-core forms (anf accepts them directly).
// Operators / `if` / function defs need `desugar` + `resolve-scope`, which require
// a C.CompileEnvironment and don't run standalone yet — see compile-driver.arr.

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

test("self-hosted compiler emits a valid WASM module for a literal", async () => {
  const bytes = await selfHostCompile("5");
  expect(bytes.length).toBeGreaterThan(8);
  expect(Array.from(bytes.slice(0, 4))).toEqual([0, 0x61, 0x73, 0x6d]); // \0asm
  // it VALIDATES (instantiate throws on an invalid module) and RUNS without trapping
  const r = await run(bytes);
  expect(r.error).toBeUndefined();
});
