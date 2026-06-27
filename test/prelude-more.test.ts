// Prelude additions: Either (left/right), fold-while, find-index.
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function out(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

test("Either left/right + cases", async () => {
  expect(await out(`cases(Either) right(7): | left(v) => 0 | right(v) => v end`)).toBe("7");
  expect(await out(`cases(Either) left(5): | left(v) => v | right(v) => 0 end`)).toBe("5");
});

test("fold-while stops on right()", async () => {
  // sums 1+2+3 = 6, then 4 > 3 -> right(6) stops
  expect(await out(
    `fold-while(lam(acc, x): if x > 3: right(acc) else: left(acc + x) end end, 0, [list: 1, 2, 3, 4, 5])`
  )).toBe("6");
  // never stops -> folds all
  expect(await out(
    `fold-while(lam(acc, x): left(acc + x) end, 0, [list: 1, 2, 3, 4])`
  )).toBe("10");
});

test("find-index", async () => {
  expect(await out(`find-index(lam(x): x == 3 end, [list: 1, 2, 3, 4])`)).toBe("2");
  expect(await out(`find-index(lam(x): x == 9 end, [list: 1, 2, 3])`)).toBe("-1");
});
