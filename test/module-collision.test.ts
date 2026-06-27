// Cross-module top-level NAME collisions under whole-program flattening.
//
// The seed merges every imported module into ONE global namespace (src/build.ts).
// Two modules can therefore export the SAME top-level name — e.g. a `data` variant
// constructor `wrap` in one module and a `fun wrap` in another. Historically this
// aliased destructively (last-wins for variants / a first-global guess for funs),
// a latent source of OOB/null-ref as the module set grew.
//
// Fix (src/build.ts + src/compiler/compile.ts): module-AWARE qualified access. Each
// `import X as N` records which module N names; `N.member` resolves to THAT module's
// export. So both same-named bindings stay reachable through their own alias. (A BARE
// reference to such a name is still arity/program-order resolved — the flat namespace
// has no per-reference scope; qualified access is the exact disambiguator.)

import { test, expect } from "bun:test";
import { resolve } from "path";
import { buildSourceFile, collisionsFor } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

const fx = (n: string) => resolve(import.meta.dir, "fixtures", n);

test("qualified access disambiguates a variant vs a function with the same name", async () => {
  // collide-entry imports a module exporting `data ... | wrap(x)` as MA and a module
  // exporting `fun wrap(x): x + 100` as MB, then uses MB.wrap(5) and MA.wrap(7).
  const wasm = await buildSourceFile(fx("collide-entry.arr"));
  const r = await run(wasm);
  expect(r.error).toBeUndefined();
  expect(r.output).toContain("105");      // MB.wrap(5) -> the FUNCTION
  expect(r.output).toContain("wrap(7)");  // MA.wrap(7) -> the VARIANT constructor
});

test("the collision detector reports the cross-module duplicate name", async () => {
  const cols = await collisionsFor(fx("collide-entry.arr"));
  expect(cols.has("wrap")).toBe(true);
  // `wrap` is defined in (at least) the two fixture modules.
  expect((cols.get("wrap") ?? []).length).toBeGreaterThanOrEqual(2);
});

test("co-importing ast.arr + encoder.arr compiles to a valid module (was an OOB)", async () => {
  // Two large real modules whose top-level names previously collided destructively
  // (encoder's `concat` fn vs pprint's `concat` variant) — must now build cleanly.
  const wasm = await buildSourceFile(fx("collide-astenc.arr"));
  expect(Array.from(wasm.slice(0, 4))).toEqual([0, 0x61, 0x73, 0x6d]); // \0asm
  const r = await run(wasm);
  expect(r.error).toBeUndefined();
});
