// Multi-file `import file(...)` resolution.
//
// (1) A program importing a SIBLING .arr compiles + runs (whole-program inlining).
// (2) The src/arr REDIRECT: Pyret's own corpus tests import the compiler via relative
//     paths like `import file("../../../src/arr/compiler/X.arr")`, which in our repo
//     layout point at a nonexistent `<repo>/src/arr/...`. build.ts redirects those to
//     our `self-compiler/{compiler,trove}/` copies (or the original `pyret/lang/src/arr`
//     tree as a fallback), so multi-file compiler tests resolve instead of ENOENT.

import { test, expect } from "bun:test";
import { resolve } from "path";
import { buildSourceFile } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

const MAIN = resolve(import.meta.dir, "fixtures/multifile-main.arr");      // imports ./multifile-dep.arr
const SRCARR = resolve(import.meta.dir, "fixtures/multifile-srcarr.arr");  // imports ../../src/arr/compiler/gensym.arr

test("import file(sibling) compiles + runs (whole-program inlining)", async () => {
  const wasm = await buildSourceFile(MAIN);
  expect(Array.from(wasm.slice(0, 4))).toEqual([0, 0x61, 0x73, 0x6d]); // \0asm
  const r = await run(wasm);
  expect(r.error).toBeUndefined();
  expect(r.output.trim()).toBe("13"); // add-one(twelve) from the sibling module
});

test("import file('.../src/arr/...') redirects to the self-compiler copy (no ENOENT)", async () => {
  // gensym.arr is a leaf module; the literal path src/arr/compiler/gensym.arr does not
  // exist, so resolution must redirect to self-compiler/compiler/gensym.arr.
  const wasm = await buildSourceFile(SRCARR);
  const r = await run(wasm);
  expect(r.error).toBeUndefined();
  expect(r.output.trim()).toBe("42");
});
