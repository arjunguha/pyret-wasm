// Node entry for the STOPPABLE (CPS) build pipeline. Composes the Pyret->Pyret
// CPS transform (self-host/cps.arr, run via the seed-compiled cps-driver.arr)
// BEFORE the untouched main compiler. The parser-agnostic core is in
// build-stoppable-core.ts (so the browser bundle avoids Node-only deps).
import { parsePyret } from "./parser/pyret-parser.ts";
import { buildSourceFile } from "./build.ts";
import { buildStoppableSourceWith } from "./build-stoppable-core.ts";
import { resolve } from "path";

export { buildStoppableSourceWith } from "./build-stoppable-core.ts";

// The CPS driver (cps-driver.arr -> imports cps.arr) compiled by the seed, once.
let _driver: Promise<Uint8Array> | null = null;
export function cpsDriverWasm(): Promise<Uint8Array> {
  if (!_driver) {
    _driver = buildSourceFile(resolve(import.meta.dir, "../self-host/cps-driver.arr"));
  }
  return _driver;
}

export async function buildStoppableSource(src: string): Promise<Uint8Array> {
  return buildStoppableSourceWith(parsePyret, src, cpsDriverWasm);
}

export async function buildStoppableSourceFile(path: string): Promise<Uint8Array> {
  return buildStoppableSource(await Bun.file(path).text());
}
