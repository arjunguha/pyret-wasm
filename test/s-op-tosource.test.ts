// Root cause of `s-op(...).tosource()` "object does not have the requested field":
// (1) Pyret `and`/`or` MUST short-circuit (the front-end's `is-s-op(x) and x.op`
//     touched x.op on non-s-op nodes); the seed evaluated both operands eagerly.
// (2) `list + list` dispatches to List._plus, which the prelude's List lacked.
// (s-op.tosource fully succeeds once the sibling pprint `.pretty` OOB fix lands too.)
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";
const out = async (src: string) => (await run(await buildSource(src))).output.trim();

test("and short-circuits: right operand not evaluated when left is false", async () => {
  expect(await out(`false and raise("boom")`)).toBe("false");
});
test("or short-circuits: right operand not evaluated when left is true", async () => {
  expect(await out(`true or raise("boom")`)).toBe("true");
});
test("and/or truth tables + right evaluated when needed", async () => {
  expect(await out("true and true")).toBe("true");
  expect(await out("true and false")).toBe("false");
  expect(await out("false or true")).toBe("true");
  expect(await out("(1 < 2) and (3 < 4)")).toBe("true");
});
test("List._plus: list + list appends", async () => {
  expect(await out("[list: 1, 2] + [list: 3]")).toBe("[list: 1, 2, 3]");
});
