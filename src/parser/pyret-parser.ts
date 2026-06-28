// Node adapter: load Pyret's tokenizer + GLR parser via requirejs (filesystem)
// and parse with the shared core. (Browser uses parser-browser.ts instead.)

import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { existsSync } from "fs";
import { parseWith, type CstNode } from "./parse-core.ts";

export type { CstNode, Pos } from "./parse-core.ts";
export { ParseError } from "./parse-core.ts";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
// Prefer the local `pyret` symlink for dev; fall back to the vendored JS-GLR
// parser (vendor/pyret-lang) so the seed compiles HERMETICALLY in CI / on a clean
// checkout with no external pyret checkout.
const SYMLINK_LANG = resolve(HERE, "../../pyret/lang");
const VENDOR_LANG = resolve(HERE, "../../vendor/pyret-lang");
const LANG = existsSync(SYMLINK_LANG) ? SYMLINK_LANG : VENDOR_LANG;

let _loaded: Promise<{ T: any; G: any }> | null = null;

function load(): Promise<{ T: any; G: any }> {
  if (_loaded) return _loaded;
  const R = require("requirejs");
  R.config({
    paths: {
      jglr: resolve(LANG, "lib/jglr"),
      "pyret-base/js": resolve(LANG, "build/phase0/js"),
      "src-base/js": resolve(LANG, "src/js/base"),
    },
  });
  _loaded = new Promise((res, rej) => {
    R(["pyret-base/js/pyret-tokenizer", "pyret-base/js/pyret-parser"], (tok: any, gram: any) => {
      res({ T: tok, G: gram });
    }, (err: any) => rej(err));
  });
  return _loaded;
}

export async function parsePyret(src: string): Promise<CstNode> {
  const { T, G } = await load();
  return parseWith(T, G, src);
}
