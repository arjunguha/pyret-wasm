// Self-hosting path: compile a Pyret program using the compiler that is ITSELF
// written in Pyret (selfhost/compiler.arr) and compiled to WASM by the seed.
//
// The seed (src/compiler) stays the bootstrap: it compiles selfhost/compiler.arr
// once into compiler.wasm. To compile a *user* program we instantiate that
// compiler.wasm, hand it the user's source via the `read_source_into` host import,
// and collect the bytes it emits via `emit_byte` — those bytes ARE the user
// program's WASM module, produced entirely by Pyret-in-WASM (no JS codegen).
//
// The self-hosted compiler currently handles a subset: `fun` defs + calls +
// recursion, `if c: t else: e end`, `let .. = .. in .. end`, integer literals,
// `+ - *`, `< >`, parens, and a trailing expression. Callers fall back to the
// seed for anything outside that subset.

import { buildSourceFile } from "./build.ts";
import { buildHostImports, newHostState } from "./runtime/run.ts";
import { resolve } from "path";

const COMPILER_ARR = resolve(import.meta.dir, "../selfhost/compiler.arr");

let _compilerWasm: Uint8Array | null = null;

// Seed-compile the Pyret-written compiler to WASM (once; cached).
export async function compileSelfHostCompiler(): Promise<Uint8Array> {
  if (!_compilerWasm) _compilerWasm = await buildSourceFile(COMPILER_ARR);
  return _compilerWasm;
}

// Run an arbitrary compiler MODULE (one that does `each(eb, compile-source(read-source()))`)
// on a source string, returning the bytes it emits. Used both to compile user
// programs and, for the self-hosting fixpoint, to run the compiler on its own source.
export async function compileWithModule(compilerWasm: Uint8Array, src: string): Promise<Uint8Array> {
  const state = newHostState(() => {}); // discard the compiler's own stdout
  state.sourceBytes = new TextEncoder().encode(src);
  const imports = buildHostImports(state);
  const { instance } = await WebAssembly.instantiate(compilerWasm as BufferSource, imports);
  state.instance = instance;
  state.memory = instance.exports.memory as WebAssembly.Memory;
  (instance.exports.main as () => void)(); // runs compile-source(read-source()), emitting bytes
  if (state.emitted.length === 0) throw new Error("self-hosted compiler emitted no bytes");
  return new Uint8Array(state.emitted);
}

// Compile a user Pyret program to WASM *using the self-hosted compiler*.
// Returns the user program's WASM module bytes. Throws if the self-hosted
// compiler can't handle the program (caller should fall back to the seed).
export async function buildSelfHosted(userSrc: string): Promise<Uint8Array> {
  return compileWithModule(await compileSelfHostCompiler(), userSrc);
}

// Run a module produced by the self-hosted compiler. Its `main` is a self-contained
// `() -> i32` (no imports/memory) returning the program's integer result.
export async function runSelfHostedModule(wasm: Uint8Array): Promise<number> {
  const { instance } = await WebAssembly.instantiate(wasm as BufferSource);
  return (instance.exports.main as () => number)();
}

// Convenience: compile + run a program through the self-hosted compiler.
export async function runSelfHosted(userSrc: string): Promise<number> {
  return runSelfHostedModule(await buildSelfHosted(userSrc));
}
