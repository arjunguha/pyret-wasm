// Self-hosted BACKEND regression tests: object `.{ ... }` extend + method dispatch.
// Object EXTEND was doubly broken: (1) the backend passed the super as anyref where
// $obj_extend wants (ref $Object) — data-field extend failed WASM validation; (2) the
// driver's s-extend desugar read f.value directly, crashing on method fields (they have
// .body, not .value) — the `default-map-visitor.{ method ... }` idiom every visitor
// module uses. Both fixed; these assert the result via the SELF-HOSTED compiler.
import { test, expect } from "bun:test";
import { buildSourceSelfHosted, runSelfHostedModule } from "../src/build-selfhosted.ts";

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
