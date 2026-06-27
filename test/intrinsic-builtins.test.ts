// Primitive builtins added as intrinsics (runtime/compileApp territory):
// equal-always/equal-now, string-to-code-point, num-to-rational, num-to-string-digits.
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function out(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

test("equal-always: structural equality", async () => {
  expect(await out("equal-always(2, 1 + 1)")).toBe("true");
  expect(await out("equal-always([list: 1, 2, 3], [list: 1, 2, 3])")).toBe("true");
  expect(await out("equal-always([list: 1, 2], [list: 1, 3])")).toBe("false");
});

test("equal-now: structural equality", async () => {
  expect(await out('equal-now("ab", "ab")')).toBe("true");
  expect(await out('equal-now("ab", "ac")')).toBe("false");
});

test("string-to-code-point", async () => {
  expect(await out('string-to-code-point("A")')).toBe("65");
  expect(await out('string-to-code-point("z")')).toBe("122");
});

test("num-to-rational: exact passthrough, roughnum -> exact", async () => {
  expect(await out("num-to-rational(num-to-roughnum(4))")).toBe("4");
  expect(await out("num-to-rational(1/2)")).toBe("1/2");
});

test("num-to-string-digits (stub): returns a numeric string", async () => {
  expect(await out("num-to-string-digits(7, 2)")).toBe("7");
});
