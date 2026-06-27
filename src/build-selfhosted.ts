// Self-hosting path (REAL compiler): compile a Pyret program using the compiler
// that is ITSELF written in Pyret — the real front-end (self-compiler/) + the
// Pyret-written backend (self-host/wasm-of-pyret.arr + encoder.arr + runtime.arr),
// driven by self-host/compile-driver.arr — and compiled to WASM by the seed.
//
// (NB: the older src/build-selfhost.ts drives the small `selfhost/compiler.arr`
// microcosm toy used by the dual-run/fixpoint discipline in test/selfhost.test.ts.
// THIS module drives the real driver and is what the CLI's --self-hosted uses.)
//
// To compile a *user* program we instantiate the seed-compiled driver, hand it the
// user's source via the `read-source()` host import (state.sourceBytes) plus the
// JS-GLR surface-parse bridge (state.parseNodes), and collect the bytes it emits via
// `emit-byte` — those bytes ARE the user program's WASM module, produced entirely by
// Pyret-in-WASM (no JS codegen). Mirrors the harness in test/selfhost-e2e.test.ts.
//
// The self-hosted compiler currently handles a growing subset (driven by the
// driver: surface-parse -> anf-program -> wasm-of-pyret; desugar/resolve are being
// wired in). Callers fall back to the seed for anything outside that subset
// (buildSourceSelfHosted throws).

import { buildSourceFile } from "./build.ts";
import { buildHostImports, newHostState, run } from "./runtime/run.ts";
import type { RunResult } from "./runtime/run.ts";
import { resolve } from "path";

const DRIVER_ARR = resolve(import.meta.dir, "../self-host/compile-driver.arr");

let _driverWasm: Uint8Array | null = null;

// Seed-compile the Pyret-written compiler driver to WASM (once; cached — it's large).
export async function compileSelfHostedDriver(): Promise<Uint8Array> {
  if (!_driverWasm) _driverWasm = await buildSourceFile(DRIVER_ARR);
  return _driverWasm;
}

// Run the self-hosted compiler driver MODULE on a source string, returning the WASM
// module bytes it emits. The driver reads its input via `read-source()`
// (state.sourceBytes) and parses with the no-JS pure-Pyret parser — NO JS-GLR bridge.
// (The old `state.parseNodes = serializeCst(parsePyret(src))` priming was vestigial —
// surface-parse no longer reads parseNodes — and it CRASHED `toAnn` on `a-app`
// annotations, which masqueraded as the "×10 JS error a.name" self-compile blocker.)
export async function compileWithDriver(driverWasm: Uint8Array, src: string): Promise<Uint8Array> {
  const state = newHostState(() => {}); // discard the compiler's own stdout
  state.sourceBytes = new TextEncoder().encode(src);
  const { instance } = await WebAssembly.instantiate(driverWasm as BufferSource, buildHostImports(state));
  state.instance = instance;
  state.memory = instance.exports.memory as WebAssembly.Memory;
  (instance.exports.main as () => void)(); // runs the driver, emitting the target module's bytes
  if (state.emitted.length === 0) throw new Error("self-hosted compiler emitted no bytes");
  return new Uint8Array(state.emitted);
}

// Compile a user Pyret program to WASM *using the real self-hosted compiler*.
// Returns the user program's WASM module bytes. Throws if the self-hosted compiler
// can't handle the program (caller should fall back to the seed).
export async function buildSourceSelfHosted(userSrc: string): Promise<Uint8Array> {
  return compileWithDriver(await compileSelfHostedDriver(), userSrc);
}

// Run a module produced by the self-hosted compiler under the normal Pyret runtime
// (it uses the same host imports / memory as a seed-compiled module). Returns the
// program's stdout output; streams it too if `opts.stdout` is given.
export async function runSelfHostedModule(
  wasm: Uint8Array,
  opts: { stdout?: (s: string) => void } = {},
): Promise<string> {
  const r: RunResult = await run(wasm, opts);
  if (r.error) throw new Error(r.error);
  return r.output;
}

// Convenience: compile + run a program through the real self-hosted compiler.
export async function runSourceSelfHosted(
  userSrc: string,
  opts: { stdout?: (s: string) => void } = {},
): Promise<string> {
  return runSelfHostedModule(await buildSourceSelfHosted(userSrc), opts);
}
