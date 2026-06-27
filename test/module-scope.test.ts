// MODULE-SCOPED bare variant references under whole-program flattening.
//
// The seed merges every imported module into one global namespace. Two modules can
// legitimately define the SAME variant name (the real case: `a-app` is a variant in
// BOTH ast.arr (a type-application annotation) and ast-anf.arr (an ANF app)). Bare
// references to such a variant inside a module M must resolve to M's OWN variant — its
// own variant id — so construction/`cases`/predicate dispatch is correct. Without this,
// last-wins aliasing made a bare `cases` branch in one module test against the OTHER
// module's variant id → no match → spurious `cases: no branch matched` (and the
// module-init null-refs that blocked self-compile).
//
// Fix: src/compiler/compile.ts `variantFor(name)` resolves a bare variant ref to the
// referrer module's own variant (ctor/predicate fn caches keyed by variant id).

import { test, expect } from "bun:test";
import { resolve } from "path";
import { buildSourceFile } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

const fx = (n: string) => resolve(import.meta.dir, "fixtures", n);

test("bare variant refs are module-scoped (same variant name in two modules)", async () => {
  // Module A and B each define a variant `av`. `A.av(7)` builds A's variant (qualified,
  // module-aware); `A.a-read` does a BARE `cases ... | av` — which must use A's OWN
  // variant id to match. Without module-scoping the bare branch used the last-wins
  // (B's) id and `A.a-read(A.av(7))` raised "cases: no branch matched".
  const wasm = await buildSourceFile(fx("modscope-entry.arr"));
  const r = await run(wasm);
  expect(r.error).toBeUndefined();
  expect(r.output).toContain("7"); // A.a-read(A.av(7))
  expect(r.output).toContain("9"); // B.b-read(B.av(9))
});
