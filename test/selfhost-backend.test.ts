// Self-hosted BACKEND regression tests (self-host/wasm-of-pyret.arr), driven through the
// real driver via src/build-selfhosted.ts.
// - object `.{ ... }` extend + method dispatch (extend was doubly broken: the backend
//   passed the super as anyref where $obj_extend wants (ref $Object); the driver's s-extend
//   desugar read f.value, crashing on method fields). Both fixed.
// - method-as-value: `f = o.m` is a $Method wrapping a $Closure; a-app unwraps it before call.
import { test, expect } from "bun:test";
import { buildSourceSelfHosted, runSelfHostedModule, runSourceSelfHosted } from "../src/build-selfhosted.ts";

async function selfHosted(src: string): Promise<string> {
  return (await runSelfHostedModule(await buildSourceSelfHosted(src))).trim();
}

test("object extend with a DATA field validates + reads back (was: validation error)", async () => {
  expect(await selfHosted(`base = { x: 1 }\next = base.{ y: 2 }\nprint(ext.x)`)).toContain("1");
});

test("object extend with a METHOD: call the override", async () => {
  const out = await selfHosted(`base = { method m(self): 11 end }\next = base.{ method m(self): 100 end }\nprint(ext.m())`);
  expect(out).toContain("100");
});

test("object extend with a METHOD: call an inherited base method", async () => {
  const out = await selfHosted(`base = { method m(self): 11 end }\next = base.{ method k(self): 22 end }\nprint(ext.m())`);
  expect(out).toContain("11");
});

test("object extend with a METHOD: call the newly-added method", async () => {
  const out = await selfHosted(`base = { method m(self): 11 end }\next = base.{ method k(self): 22 end }\nprint(ext.k())`);
  expect(out).toContain("22");
});

// `f = o.m` takes a method off an object as a VALUE — a $Method wrapping a $Closure.
// Applying it (`f(o, 4)`) used to ref.cast-fail; a-app now unwraps a $Method callee first.
test("self-hosted backend: a method taken as a value is callable (o.m unwraps $Method)", async () => {
  await expect(runSourceSelfHosted(
    "o = { method m(self, k): k + 1 end }\n" +
    "f = o.m\n" +
    "if f(o, 4) == 5: 0 else: 1 / 0 end"
  )).resolves.toBeDefined();
});
