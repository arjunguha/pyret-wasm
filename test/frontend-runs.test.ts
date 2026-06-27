// Does the seed-compiled REAL Pyret front-end (self-compiler/) actually RUN, not
// just compile? This exercises real trove/front-end modules through the seed and
// asserts the behavior that currently WORKS. The KNOWN-FAIL inventory is the
// remaining runtime-correctness work.
//
// ===== CURRENT STATE (re-probed after the pprint load-crash fix) =====
// RUNS correctly under the seed:
//   - srcloc.arr        : S.builtin(...).format(), S.srcloc(...).format()
//   - valueskeleton.arr : loads + constructs values
//   - variant methods at load/top-level (data ... with: method ...)
//   - pprint.arr        : LOADS (its where: tests run) — the root crash is FIXED
//   - ast.arr           : LOADS + construct nodes + field access + is-<variant> +
//                         .tosource() (number docs) + Name.toname()  ALL RUN
// KNOWN-FAIL (compile OK, crash at RUN — next runtime-correctness lanes):
//   1. pprint `PP.str(s).pretty(width)` -> "Out of bounds array.get". The str-doc
//      pretty path indexes a string/array out of range. (s-num.tosource().pretty
//      works, so it's specific to the str doc's line-fitting.) HIGH leverage:
//      pprint pretty-printing underlies every `.tosource()` of non-trivial nodes.
//   2. ast `s-op(...).tosource()` -> "object does not have the requested field"
//      (richer AST nodes' tosource; likely a missing field/op-name lookup).
//   3. ast-util / well-formed helpers: take rich args (NameResolution, AST trees);
//      can't be exercised without the parser (parse-pyret is a stub that raises).
//      Blocked on wiring a real parser, not a runtime bug per se.

import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { buildSourceFile } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

// Run a Pyret program through the seed (trove imports resolve to self-compiler/).
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
// The program's value prints first; modules with where: blocks append a check
// summary afterward — so assert the first output line.
async function firstLine(src: string): Promise<string> {
  return (await runProg(src)).split("\n")[0]!.trim();
}

test("real srcloc trove module RUNS: builtin + format", async () => {
  expect(await runProg(`import srcloc as S\nS.builtin("x").format(true)`)).toBe("<builtin x>");
});

test("real srcloc trove module RUNS: srcloc ctor + format", async () => {
  expect(await runProg(`import srcloc as S\nS.srcloc("f", 1, 0, 0, 1, 5, 5).format(false)`))
    .toBe("line 1, column 0");
});

test("real valueskeleton trove module loads + constructs", async () => {
  expect(await runProg(`import valueskeleton as VS\nx = VS.vs-str("hi")\n42`)).toBe("42");
});

test("variant methods run at load/top-level", async () => {
  expect(await runProg(
    `data D: | mt with: method lab(self): "m" end | nd(x) with: method lab(self): "n" end end\n` +
    `mt.lab() + nd(1).lab()`)).toBe("mn");
});

// ===== promoted now that pprint loads + ast runs =====
test("real ast.arr RUNS: construct s-num + field access", async () => {
  expect(await firstLine(`import ast as A\nA.s-num(A.dummy-loc, 5).n`)).toBe("5");
});

test("real ast.arr RUNS: is-<variant> predicate", async () => {
  expect(await firstLine(`import ast as A\nA.is-s-num(A.s-num(A.dummy-loc, 5))`)).toBe("true");
});

test("real ast.arr RUNS: .tosource() of a number doc (pprint number path)", async () => {
  expect(await firstLine(`import ast as A\nA.s-num(A.dummy-loc, 5).tosource().pretty(80)`))
    .toBe("[list: 5]");
});

test("real ast.arr RUNS: Name.toname()", async () => {
  expect(await firstLine(`import ast as A\nA.s-name(A.dummy-loc, "x").toname()`)).toBe("x");
});

test("real pprint.arr LOADS (root crash fixed)", async () => {
  expect(await runProg(`import pprint as PP\n42`)).toContain("42");
});
