// How far does the seed-compiled REAL Pyret front-end PIPELINE actually RUN when
// driven on hand-built ast.arr ASTs (no parser needed)? This complements
// frontend-runs.test.ts (which exercises ast/pprint/srcloc construction) by
// invoking the *compiler passes* — desugar / well-formed / resolve-scope / anf —
// on real AST values and asserting what works today.
//
// ===== CURRENT STATE (2026-06-27) =====
// The whole desugar / well-formed / resolve-scope / anf dependency closure now LOADS
// under the seed: `import X` runs each module's top-level init without crashing or
// hanging (asserted below). Getting here cleared a chain of seed bugs surfaced only by
// the real front-end's scale and idioms:
//   - missing prelude funcs (Either/fold-while/take-while/each2.../find-index);
//   - block-level `fun` letrec hoisting; module-alias arg currying; tuple `{a;b} as x`;
//   - anonymous `method(...)` values; operator overloading via `_plus`/`_lessthan`/...;
//   - arity-based variant-vs-`shadow` smart-constructor disambiguation;
//   - non-recursive top-level `let` re-binding the same name across modules;
//   - `N.member` resolving to module N's export (not a later local rebind);
//   - PROGRAM-ORDER name resolution so a later module's `shadow map`/`foldl` doesn't
//     capture the prelude's own recursion (the cross-module infinite-loop "hang");
//   - the module-qualified collection ctor `[SD.string-dict: ...]`;
//   - not running imported modules' `check:` blocks at load.
//
// anf.arr also runs: `anf-program(<s-program>)` normalizes a hand-built program and
// round-trips through `.tosource().pretty(w)`, and raises a clean Pyret error on
// un-normalized input (it executes; it isn't a wasm trap).

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

// ===== front-end pass modules LOAD at init =====
// Previously KNOWN-FAIL tripwires (the modules crashed/hung at module init). The seed
// now loads the whole desugar/well-formed/resolve-scope dependency closure — `import X`
// runs its top-level init without crashing — so these are real "loads" assertions.
// Root causes fixed: a cross-module `shadow map`/`foldl` cycle (program-order name
// resolution), non-recursive-let collisions across modules, operator/method dispatch,
// and the module-qualified collection constructor `[SD.string-dict: ...]`.
test("desugar.arr loads at module init", async () => {
  expect(await firstLine(`import desugar as D\n1`)).toBe("1");
});

test("well-formed.arr loads at module init", async () => {
  expect(await firstLine(`import well-formed as W\n1`)).toBe("1");
});

test("resolve-scope.arr loads at module init", async () => {
  expect(await firstLine(`import resolve-scope as R\n1`)).toBe("1");
});

// The full front-end closure (compile-structs + ast-util + type-structs) also loads.
test("compile-structs.arr loads at module init", async () => {
  expect(await firstLine(`import compile-structs as C\n1`)).toBe("1");
});
