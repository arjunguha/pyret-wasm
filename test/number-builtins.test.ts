// Number/string builtins added as intrinsics (num-expt/sqrt/floor/ceiling/round,
// num-is-*, num-exact, string-equal). Each program's printed value is checked.
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function out(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

test("num-expt (exact, integer exponent)", async () => {
  expect(await out("num-expt(2, 10)")).toBe("1024");
  expect(await out("num-expt(3, 0)")).toBe("1");
  expect(await out("num-expt(5, 3)")).toBe("125");
});

test("num-sqrt (roughnum), made exact for display", async () => {
  // num-floor of a roughnum stays rough (contagion), so go through num-exact.
  expect(await out("num-exact(num-sqrt(16))")).toBe("4");
  expect(await out("num-exact(num-sqrt(144))")).toBe("12");
});

test("num-floor / num-ceiling / num-round on an exact rational", async () => {
  expect(await out("num-floor(7 / 2)")).toBe("3");
  expect(await out("num-ceiling(7 / 2)")).toBe("4");
  expect(await out("num-round(7 / 2)")).toBe("4");
  expect(await out("num-floor(10)")).toBe("10"); // exact integer passthrough
});

test("number-kind predicates", async () => {
  expect(await out("num-is-integer(5)")).toBe("true");
  expect(await out("num-is-integer(5 / 2)")).toBe("false");
  expect(await out("num-is-fixnum(5)")).toBe("true");
  expect(await out("num-is-roughnum(num-sqrt(16))")).toBe("true");
  expect(await out("num-is-roughnum(5)")).toBe("false");
  expect(await out("num-is-rational(1 / 2)")).toBe("true");
});

test("num-exact: roughnum -> exact integer; exact passthrough", async () => {
  expect(await out("num-exact(5)")).toBe("5");
  expect(await out("num-is-integer(num-exact(num-sqrt(16)))")).toBe("true");
});

test("string-equal", async () => {
  expect(await out('string-equal("abc", "abc")')).toBe("true");
  expect(await out('string-equal("abc", "abd")')).toBe("false");
  expect(await out('string-equal("", "")')).toBe("true");
});
