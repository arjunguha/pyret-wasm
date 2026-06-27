// Standalone first-class `method(self, ...): ... end` expressions (method values
// created outside an object literal). They compile to the same $Method as object/
// variant methods and round-trip through method dispatch (obj.m(args) binds self).

import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function runOut(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

test("method-expr as an object field value dispatches with self", async () => {
  expect(await runOut(`o = { mth: method(self, x): x + 1 end }\no.mth(10)`)).toBe("11");
});

test("method value bound to a name, placed in an object, self-binds on call", async () => {
  expect(await runOut(`mv = method(self, x): x * 2 end\no = { f: mv }\no.f(21)`)).toBe("42");
});

test("method-expr captures enclosing variables", async () => {
  expect(await runOut(`n = 100\no = { g: method(self, x): x + n end }\no.g(5)`)).toBe("105");
});

test("method-expr can reach self's other fields", async () => {
  expect(await runOut(`o = { v: 7, getv: method(self, k): self.v + k end }\no.getv(3)`)).toBe("10");
});
