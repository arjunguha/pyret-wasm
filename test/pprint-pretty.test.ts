// pprint's `str` doc pretty-printing, exercised through the seed-compiled real
// front-end (self-compiler/). Regression for the "Out of bounds array.get" RUNTIME
// crash: `PP.str(s)` (module-qualified) was resolving to pprint's 3-field data
// VARIANT `str` instead of its top-level `shadow str = lam(s): str(s, ...) end`
// smart constructor. Called with 1 arg, lenient arity built a 1-field variant, so
// `.flat-width` (field index 1) read out of bounds. The fix: a module-qualified
// call `N.foo(args)` now prefers a top-level binding over a same-named variant
// (matching resolveName's topScope-before-variants order). This path underlies
// every `.tosource()` of a node containing a string.

import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { buildSourceFile } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function runProg(src: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pyret-pp-"));
  const path = join(dir, "p.arr");
  writeFileSync(path, src);
  try {
    const r = await run(await buildSourceFile(path));
    return r.output.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
async function firstLine(src: string): Promise<string> {
  return (await runProg(src)).split("\n")[0]!.trim();
}

// The smart constructor (1-arg lambda), not the 3-field variant, must answer
// module-qualified `PP.str` — so the resulting str doc is fully formed.
test("pprint PP.str(s) builds the full str doc (flat-width is in bounds)", async () => {
  expect(await firstLine(`import pprint as PP\nnum-to-string(PP.str("abc").flat-width)`)).toBe("3");
});

test("pprint PP.str(s).pretty(width) RUNS (no Out of bounds array.get)", async () => {
  expect(await firstLine(`import pprint as PP\nPP.str("abc").pretty(80).first`)).toBe("abc");
});

// A string AST node renders through the str doc — previously OOB at runtime.
test("ast s-str .tosource().pretty(width) RUNS through the str doc", async () => {
  expect(await firstLine(`import ast as A\nA.s-str(A.dummy-loc, "hi").tosource().pretty(80).first`))
    .toBe("hi");
});
