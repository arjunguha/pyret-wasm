// Seed number gaps: (1) bare decimal literals are EXACT rationals (Pyret semantics:
// 0.1 = 1/10, NOT a float) — they previously compiled to roughnums / rendered the
// "roughnum" placeholder; (2) transcendental builtins (num-exp/log/sin/... ) via the
// host $math1/$math2 imports return roughnums; (3) is-roughly with a default tolerance.
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function evalPyret(src: string): Promise<string> {
  const { output } = await run(await buildSource(src));
  return output.trimEnd();
}

test("decimal literals are exact rationals (render as n/d like Pyret's toString)", async () => {
  expect(await evalPyret("0.1")).toBe("1/10");
  expect(await evalPyret("3.14")).toBe("157/50");
  expect(await evalPyret("0.001")).toBe("1/1000");
  expect(await evalPyret("-2.5")).toBe("-5/2");
  expect(await evalPyret("2.0")).toBe("2");        // reduces to an integer
});

test("decimal arithmetic is EXACT (no float error)", async () => {
  expect(await evalPyret("0.1 + 0.2")).toBe("3/10"); // not 0.30000000000000004
  expect(await evalPyret("0.1 * 0.1")).toBe("1/100");
});

test("scientific notation is exact", async () => {
  expect(await evalPyret("1.5e2")).toBe("150");
  expect(await evalPyret("1.0e-3")).toBe("1/1000");
});

test("~-prefixed decimals stay roughnums (not rationals)", async () => {
  expect(await evalPyret("~0.1")).toBe("~0.1");
  expect(await evalPyret("~3.14")).toBe("~3.14");
});

test("transcendental builtins compute (roughnum results)", async () => {
  expect(await evalPyret("num-exp(0)")).toBe("~1");
  expect(await evalPyret("num-log(1)")).toBe("~0");
  expect(await evalPyret("num-sin(0)")).toBe("~0");
  expect(await evalPyret("num-cos(0)")).toBe("~1");
  expect(await evalPyret("num-tan(0)")).toBe("~0");
  expect(await evalPyret("num-atan(0)")).toBe("~0");
  expect(await evalPyret("num-asin(0)")).toBe("~0");
  expect(await evalPyret("num-acos(1)")).toBe("~0");
  expect(await evalPyret("num-atan2(0, 1)")).toBe("~0");
});

test("transcendentals reach reasonable values", async () => {
  expect(await evalPyret("num-exp(1)")).toBe("~2.718281828459045");
  expect(await evalPyret("num-atan2(1, 1)")).toBe("~0.785398163397448");
});

test("is-roughly uses a default tolerance", async () => {
  expect(await evalPyret("check:\n  ~3.14 is-roughly ~3.140000001\n  3.0 is-roughly 3.0\nend"))
    .toContain("Looks shipshape");
  expect(await evalPyret("check:\n  ~1.0 is-roughly ~2.0\nend"))
    .toContain("test failed");
});
