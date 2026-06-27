// Roughnum printing: roughnums render as Pyret's `~`-prefixed decimal (e.g. ~3.14,
// ~5, ~-2.5) via $render_rough in the seed runtime — previously they printed the
// placeholder "roughnum".  Fixed-precision (15 fractional digits, rounded, trailing
// zeros trimmed): exact for "nice" decimals, round-trip-ish for irrationals.
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function evalPyret(src: string): Promise<string> {
  const { output } = await run(await buildSource(src));
  return output.trimEnd();
}

test("roughnum literals print their value with a ~ prefix", async () => {
  expect(await evalPyret("~3.14")).toBe("~3.14");
  expect(await evalPyret("~0.5")).toBe("~0.5");
  expect(await evalPyret("~0.1")).toBe("~0.1");
  expect(await evalPyret("~2.5")).toBe("~2.5");
});

test("integral roughnums print without a decimal point", async () => {
  expect(await evalPyret("~5")).toBe("~5");
  expect(await evalPyret("~0")).toBe("~0");
  expect(await evalPyret("~42")).toBe("~42");
});

test("negative roughnums keep the sign after the ~", async () => {
  expect(await evalPyret("~-2.5")).toBe("~-2.5");
  expect(await evalPyret("~-3.14")).toBe("~-3.14");
});

test("roughnum results of operations print their value", async () => {
  // num-sqrt returns a roughnum; sqrt(4) is exactly 2
  expect(await evalPyret("num-sqrt(4)")).toBe("~2");
  // sqrt(2) is irrational -> round-trip-ish decimal (not the "roughnum" placeholder)
  const r = await evalPyret("num-sqrt(2)");
  expect(r.startsWith("~1.41421356237")).toBe(true);
  // rough contagion: a roughnum operand makes the result rough
  expect(await evalPyret("~1.5 + 1")).toBe("~2.5");
});

test("roughnums render inside compound values", async () => {
  expect(await evalPyret("[list: ~1.5, ~2.25]")).toBe("[list: ~1.5, ~2.25]");
});
