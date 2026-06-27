// Parser-agnostic build pipeline: parse prelude + user source with the supplied
// parse function, merge, and compile to WASM. Node and browser supply their own
// parser (so the browser bundle never imports Node's fs/requirejs).

import type { CstNode } from "./parser/parse-core.ts";
import { compile, mergePrograms } from "./compiler/compile.ts";
import { PRELUDE_SRC } from "./compiler/prelude.ts";

export type ParseFn = (src: string) => Promise<CstNode>;

let _prelude: CstNode | null = null;

export async function buildSourceWith(parse: ParseFn, src: string): Promise<Uint8Array> {
  // Parse sequentially: Pyret's tokenizer/parser are stateful singletons and
  // must not be driven concurrently.
  if (!_prelude) _prelude = await parse(PRELUDE_SRC);
  const user = await parse(src);
  return compile(mergePrograms(_prelude, user));
}
