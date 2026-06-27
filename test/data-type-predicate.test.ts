// Data-TYPE predicate `is-<TypeName>` — true for ANY variant of a `data` type
// (distinct from the per-variant `is-<variant>`). The real front-end uses
// `J.is-JStmt(...)` etc. Implemented as a variant-id range check.
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function result(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

const D = "data T: | a | b(x) end\ndata U: | c | d(y) end\n";

test("is-<TypeName> is true for any variant of that type", async () => {
  expect(await result(D + "is-T(a)")).toBe("true");
  expect(await result(D + "is-T(b(5))")).toBe("true");
});

test("is-<TypeName> is false for other types and non-variants", async () => {
  expect(await result(D + "is-T(c)")).toBe("false");      // c is U, not T
  expect(await result(D + "is-T(d(1))")).toBe("false");   // d is U
  expect(await result(D + "is-T(5)")).toBe("false");      // a number
  expect(await result(D + "is-U(d(9))")).toBe("true");    // the other type works too
});

test("is-<TypeName> works as a first-class value (map)", async () => {
  expect(await result(D + "map(is-T, [list: a, c, b(1), d(2)])"))
    .toBe("[list: true, false, true, false]");
});
