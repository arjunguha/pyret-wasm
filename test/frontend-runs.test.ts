// Does the seed-compiled REAL Pyret front-end (self-compiler/) actually RUN, not
// just compile? This test exercises real trove/front-end modules through the seed
// and asserts the behavior that currently WORKS. The next milestone after "the
// front-end compiles" is "the front-end runs correctly"; the KNOWN-FAIL inventory
// below is the runtime-correctness work that remains.
//
// ===== CURRENT STATE (probed) =====
// RUNS correctly under the seed:
//   - srcloc.arr        : S.builtin(...).format(), S.srcloc(...).format()
//   - valueskeleton.arr : loads + constructs values
//   - variant methods called at load/top-level (data ... with: method ...)
// KNOWN-FAIL (compile OK, crash at RUN — for the next lanes):
//   - pprint.arr  : *** ROOT BLOCKER *** crashes at LOAD (top-level init null-ref,
//                   before any PP.* call). pprint uses the `provide { name: name, ... }`
//                   object-provide form + many top-level doc constants. Fixing this
//                   unblocks the rest of the front-end's RUNTIME.
//   - ast.arr     : crashes at load — it `import pprint as PP`, so it inherits the
//                   pprint load crash. (Construction/methods couldn't be reached.)
//   - => every pass that imports ast/pprint (well-formed, resolve-scope, desugar,
//        type-check, anf-loop-compiler, ...) compiles but does NOT run yet, all
//        blocked on the single pprint load crash.

import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { buildSourceFile } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

// Write a Pyret program to a temp file and run it through the seed (so trove
// imports like `import srcloc as S` resolve to self-compiler/).
async function runProg(src: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pyret-fr-"));
  const path = join(dir, "p.arr");
  writeFileSync(path, src);
  try {
    const r = await run(await buildSourceFile(path));
    return r.output.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("real srcloc trove module RUNS: builtin + format", async () => {
  expect(await runProg(`import srcloc as S\nS.builtin("x").format(true)`))
    .toBe("<builtin x>");
});

test("real srcloc trove module RUNS: srcloc ctor + format", async () => {
  expect(await runProg(`import srcloc as S\nS.srcloc("f", 1, 0, 0, 1, 5, 5).format(false)`))
    .toBe("line 1, column 0");
});

test("real valueskeleton trove module loads + constructs", async () => {
  // loading valueskeleton + constructing a value must not crash
  expect(await runProg(`import valueskeleton as VS\nx = VS.vs-str("hi")\n42`))
    .toBe("42");
});

test("variant methods run at load/top-level (front-end relies on this pervasively)", async () => {
  expect(await runProg(
    `data D: | mt with: method lab(self): "m" end | nd(x) with: method lab(self): "n" end end\n` +
    `mt.lab() + nd(1).lab()`))
    .toBe("mn");
});

// NOTE: intentionally NOT asserted (KNOWN-FAIL, see header) — `import pprint as PP`
// and `import ast as A` currently crash at LOAD (pprint top-level init null-ref).
// When the pprint runtime crash is fixed, promote these to real assertions:
//   import ast as A ; print(A.s-num(A.dummy-loc, 5).n)            -> "5"
//   import ast as A ; print(A.is-s-num(A.s-num(A.dummy-loc, 5)))  -> "true"
//   import pprint as PP ; print(PP.str("hi").pretty(80))          -> "hi"
