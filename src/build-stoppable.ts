// Node entry for the stoppable (CPS) build pipeline. Composes the CPS pass
// (src/compiler/cps.ts) before the untouched main compiler. The parser-agnostic
// core lives in build-stoppable-core.ts (so the browser bundle avoids Node deps).
import { parsePyret } from "./parser/pyret-parser.ts";
import { cpsSource } from "./compiler/cps.ts";
import { PRELUDE_SRC } from "./compiler/prelude.ts";
import { buildStoppableSourceWith } from "./build-stoppable-core.ts";

export { buildStoppableSourceWith } from "./build-stoppable-core.ts";

export async function buildStoppableSource(src: string): Promise<Uint8Array> {
  return buildStoppableSourceWith(parsePyret, src);
}

export async function buildStoppableSourceFile(path: string): Promise<Uint8Array> {
  const src = await Bun.file(path).text();
  return buildStoppableSource(src);
}

// Expose the intermediate CPS source (useful for debugging / inspection).
export async function stoppableCpsSource(src: string): Promise<string> {
  return cpsSource(await parsePyret(PRELUDE_SRC + "\n" + src));
}
