// The self-hosted compiler's module closure must be SELF-CONTAINED under
// `self-compiler/` — it should compile our own modifiable copies, never fall back
// to the original `pyret/lang` tree. This matters for the fixpoint (the compiler
// compiling its own source) and so edits to `self-compiler/*.arr` actually take effect.
//
// build.ts's `redirectFileImport` redirects a `.../src/arr/<rest>` (or a
// `self-compiler/<rest>`) import to the self-compiler copy, falling back to
// `pyret/lang/src/arr/<rest>` only as a last resort. These tests assert the fallback
// is NOT needed for the compiler closure: every module it pulls resolves inside
// self-compiler/.  (Previously the `compiler/locators/*` modules were missing and fell
// back to pyret/lang; they're now copied in.)

import { test, expect } from "bun:test";
import { redirectFileImport } from "../src/build.ts";
import { resolve } from "path";
import { existsSync } from "fs";

const REPO = resolve(import.meta.dir, "..");
const SELF = resolve(REPO, "self-compiler");
const PYRET = resolve(REPO, "pyret/lang/src/arr");

// A `src/arr/<rest>` spec (how Pyret's own sources import each other) must resolve
// into self-compiler/, not pyret/lang/, for every module in the compiler closure.
function resolvedInSelf(rest: string): boolean {
  const p = redirectFileImport(resolve(REPO, "src/arr", rest));
  return p.startsWith(SELF + "/") && existsSync(p) && !p.startsWith(PYRET + "/");
}

test("the 5 compiler/locators modules are present in self-compiler (no longer missing)", () => {
  for (const n of ["builtin", "file", "jsfile", "npm", "url"]) {
    expect(existsSync(resolve(SELF, "compiler/locators", n + ".arr"))).toBe(true);
  }
});

test("locators resolve into self-compiler, not the pyret/lang fallback", () => {
  for (const n of ["builtin", "file", "jsfile", "npm", "url"]) {
    expect(resolvedInSelf(`compiler/locators/${n}.arr`)).toBe(true);
  }
});

test("core compiler-closure modules resolve entirely within self-compiler", () => {
  // The passes the self-hosted driver uses + the full IO/driver layer that pulls locators.
  const closure = [
    "compiler/desugar.arr", "compiler/resolve-scope.arr", "compiler/anf.arr",
    "compiler/compile-structs.arr", "compiler/well-formed.arr", "compiler/ast-util.arr",
    "compiler/js-of-pyret.arr", "compiler/type-structs.arr",
    "compiler/compile-lib.arr", "compiler/cli-module-loader.arr",
    "trove/ast.arr",
  ];
  for (const rest of closure) expect(resolvedInSelf(rest)).toBe(true);
});
