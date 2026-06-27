#!/usr/bin/env bun
// Build step for the web IDE: compile the SELF-HOSTED compiler driver
// (self-host/compile-driver.arr — the real front-end + the Pyret-written backend)
// with the seed and emit web/selfhost-driver.wasm. web/main.ts fetches this at
// runtime; its "Self-hosted" run mode runs this driver on the editor source (read
// via read-source(), no JS parser) to produce the program's WASM bytes — entirely
// Pyret-in-WASM, no JS codegen, NO seed fallback. Generated artifact (gitignored).
import { buildSourceFile } from "../src/build.ts";
import { resolve } from "path";

const wasm = await buildSourceFile(resolve(import.meta.dir, "../self-host/compile-driver.arr"));
const out = resolve(import.meta.dir, "../web/selfhost-driver.wasm");
await Bun.write(out, wasm);
console.log(`wrote ${out} (${wasm.length} bytes)`);
