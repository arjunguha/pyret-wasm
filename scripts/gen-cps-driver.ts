#!/usr/bin/env bun
// Build step for the web IDE: compile the CPS driver (self-host/cps-driver.arr,
// which imports self-host/cps.arr) with the seed and emit web/cps-driver.wasm.
// web/main.ts fetches this at runtime to run the Pyret->Pyret CPS transform in
// the browser (the stoppable pipeline). Generated artifact (gitignored).
import { buildSourceFile } from "../src/build.ts";
import { resolve } from "path";

const wasm = await buildSourceFile(resolve(import.meta.dir, "../self-host/cps-driver.arr"));
const out = resolve(import.meta.dir, "../web/cps-driver.wasm");
await Bun.write(out, wasm);
console.log(`wrote ${out} (${wasm.length} bytes)`);
