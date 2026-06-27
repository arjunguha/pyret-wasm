// How far does the seed-compiled REAL Pyret front-end PIPELINE actually RUN when
// driven on hand-built ast.arr ASTs (no parser needed)? This complements
// frontend-runs.test.ts (which exercises ast/pprint/srcloc construction) by
// invoking the *compiler passes* — desugar / well-formed / resolve-scope / anf —
// on real AST values and asserting what works today.
//
// ===== CURRENT STATE (re-probed on master, 2026-06-27) =====
// RUNS correctly under the seed:
//   - anf.arr  : module loads (its ast.arr dep's 10 where:-tests pass), and
//                `anf-program(<s-program>)` NORMALIZES a hand-built program and
//                round-trips through `.tosource().pretty(w)`.  anf also raises a
//                *clean Pyret error* ("Missed case in anf: ...") on un-normalized
//                input — i.e. it executes correctly, it isn't a wasm trap.
//
// KNOWN-FAIL (compile OK, but the MODULE crashes at init — next runtime lanes):
//   1. desugar.arr       : `import desugar`       -> "access to a null reference"
//   2. well-formed.arr   : `import well-formed`   -> "access to a null reference"
//   3. resolve-scope.arr : `import resolve-scope` -> "access to a null reference"
//      All three null-ref during *module initialization* (top-level/where: code
//      running at load), BEFORE any pass entry point can be called. anf.arr does
//      NOT, which is why anf is exercisable and the other three are not yet.
//      PRIORITY ORDER for fixing (each unblocks the next stage of the pipeline):
//        (a) desugar      — runs first in the real pipeline; highest leverage.
//        (b) resolve-scope — needs a C.CompileEnvironment to call anyway, but the
//            init crash must be cleared first.
//        (c) well-formed  — `check-well-formed(ast)`; init crash blocks it.
//      The init crashes are likely a single shared root cause (a top-level value
//      in a common dependency of all three that anf doesn't pull in) — worth
//      diagnosing once.
//
// NOTE: two KNOWN-FAILs documented in frontend-runs.test.ts are now STALE / fixed
// on master: `s-op(...).tosource().pretty()` -> "[list: 1 + 2]" and
// `PP.str(s).pretty(w)` -> "[list: hello]" both RUN now.

import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { buildSourceFile } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

// Run a Pyret program through the seed (trove imports resolve to self-compiler/).
async function runProg(src: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pyret-pl-"));
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
// summary afterward — so assert against the first output line.
async function firstLine(src: string): Promise<string> {
  return (await runProg(src)).split("\n")[0]!.trim();
}

// A hand-built s-program wrapping `body`, with the single (desugared-shaped)
// provide block that anf-program expects (it reads `provides.first`).
const PROG = (body: string) => `
import ast as A
import anf as N
fun prog(b): A.s-program(A.dummy-loc, none, A.s-provide-none(A.dummy-loc),
  A.s-provide-types-none(A.dummy-loc),
  [list: A.s-provide-block(A.dummy-loc, [list:], [list:])], [list:], b) end
`;

// ===== anf.arr RUNS on hand-built programs =====
test("anf.arr module loads + initializes under the seed", async () => {
  // importing anf pulls in ast.arr, whose 10 where:-tests run and pass.
  expect(await runProg(`import anf as N\n42`)).toContain("42");
});

test("anf-program NORMALIZES a number-literal program", async () => {
  const out = await firstLine(
    PROG("b") + `N.anf-program(prog(A.s-num(A.dummy-loc, 1))).tosource().pretty(80)`);
  expect(out).toContain("1");
});

test("anf-program NORMALIZES a string-literal program", async () => {
  const out = await firstLine(
    PROG("b") + `N.anf-program(prog(A.s-str(A.dummy-loc, "hi"))).tosource().pretty(80)`);
  expect(out).toContain("hi");
});

// ===== KNOWN-FAIL tripwires =====
// These pass today *because the pass module crashes at init*. When a runtime lane
// fixes the init crash, the corresponding tripwire flips red — a deliberate signal
// to promote that pass to a real "RUNS" assertion (and update the header above).
test("KNOWN-FAIL: desugar.arr crashes at module init (tripwire)", async () => {
  await expect(runProg(`import desugar as D\n1`)).rejects.toThrow(/null reference/);
});

test("KNOWN-FAIL: well-formed.arr crashes at module init (tripwire)", async () => {
  await expect(runProg(`import well-formed as W\n1`)).rejects.toThrow(/null reference/);
});

test("KNOWN-FAIL: resolve-scope.arr crashes at module init (tripwire)", async () => {
  await expect(runProg(`import resolve-scope as R\n1`)).rejects.toThrow(/null reference/);
});
