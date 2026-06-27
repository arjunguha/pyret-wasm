// Parser-agnostic stoppable build: parse (prelude + user) -> CPS source-to-source
// -> re-parse -> compile. Node and browser supply their own parser, so the
// browser bundle never imports Node's fs/requirejs/module.
import { cpsSource } from "./compiler/cps.ts";
import { compile } from "./compiler/compile.ts";
import { PRELUDE_SRC } from "./compiler/prelude.ts";
import type { CstNode } from "./parser/parse-core.ts";

export type ParseFn = (src: string) => Promise<CstNode>;

// The stdlib prelude is CPS-transformed TOGETHER with user code so built-in
// higher-order functions are interruptible. Pyret's tokenizer/parser are
// stateful singletons, so parse sequentially.
export async function buildStoppableSourceWith(parse: ParseFn, src: string): Promise<Uint8Array> {
  const program = await parse(PRELUDE_SRC + "\n" + src);
  const cps = cpsSource(program);
  const transformed = await parse(cps);
  return compile(transformed, { stoppable: true });
}
