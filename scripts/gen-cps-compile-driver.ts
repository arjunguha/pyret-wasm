#!/usr/bin/env bun
// Build step for the web IDE: compile the SINGLE stoppable compile driver
// (self-host/cps-compile-driver.arr) with the seed and emit web/cps-compile-driver.wasm.
//
// This is the ONLY compiler the web IDE loads. The driver does, entirely in WASM:
//   source -> pure-Pyret parser (NO JS) -> cps-ast CPS stoppability transform
//          -> desugar -> ANF -> wasm-of-pyret backend (lowers yield-check/finish-result/
//             cps-op-* + exports `resume`)  -> the program's WASM module bytes.
// Parse-once (no re-parse), no JS-GLR parser, no seed at runtime. web/main.ts fetches
// this, runs it on the editor source via read-source(), and runs the emitted module on
// the single-thread stoppable trampoline. Generated artifact (gitignored).
import { buildSourceFile } from "../src/build.ts";
import { resolve } from "path";

const wasm = await buildSourceFile(resolve(import.meta.dir, "../self-host/cps-compile-driver.arr"));
const out = resolve(import.meta.dir, "../web/cps-compile-driver.wasm");
await Bun.write(out, wasm);
console.log(`wrote ${out} (${wasm.length} bytes)`);
