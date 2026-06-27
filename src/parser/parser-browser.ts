// Browser adapter: load the pre-bundled Pyret parser (web/parser-bundle.js) at
// RUNTIME via a dynamic import, so the bundler doesn't inline it alongside
// binaryen (whose emscripten UMD wrapper collides with the parser's AMD shim).

import { parseWith, type CstNode } from "./parse-core.ts";

// Pyret's jglr timing helper checks `window.performance` (else Node's
// process.hrtime). A module Worker has neither `window` nor `process`, which
// makes it return undefined and crash. Workers do have `performance`, so alias
// `window` to the worker global.
if (typeof (globalThis as any).window === "undefined" && typeof (globalThis as any).performance !== "undefined") {
  (globalThis as any).window = globalThis;
}

let _mod: Promise<any> | null = null;
function loadParser(): Promise<any> {
  // Computed URL keeps this import external (resolved next to the worker).
  if (!_mod) _mod = import(/* @vite-ignore */ new URL("./parser-bundle.js", import.meta.url).href);
  return _mod;
}

export async function parsePyretBrowser(src: string): Promise<CstNode> {
  const { Tokenizer, PyretGrammar } = await loadParser();
  return parseWith(Tokenizer, { PyretGrammar }, src);
}
