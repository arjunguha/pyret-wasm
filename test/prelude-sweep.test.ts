// Prelude sweep: take-while / split-at / fold2 (front-end list gates).
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

const out = async (src: string) => (await run(await buildSource(src))).output.trim();

test("take-while returns {prefix; rest} tuple", async () => {
  // prefix = [1,2] (len 2), rest = [5,1] (len 2) -> 2 + 2*10 = 22
  expect(await out(
    "fun lt3(x): x < 3 end\n" +
    "tw = take-while(lt3, [list: 1, 2, 5, 1])\n" +
    "length(tw.{0}) + (length(tw.{1}) * 10)")).toBe("22");
});

test("split-at returns {prefix, suffix} record", async () => {
  // prefix=[10,20] (sum 30), suffix=[30,40] (sum 70) -> 30 + 70 = 100
  expect(await out(
    "s = split-at(2, [list: 10, 20, 30, 40])\n" +
    "sum(s.prefix) + sum(s.suffix)")).toBe("100");
});

test("fold2 folds two lists in lockstep", async () => {
  // 1*4 + 2*5 + 3*6 = 32
  expect(await out(
    "fold2(lam(acc, a, b): acc + (a * b) end, 0, [list: 1, 2, 3], [list: 4, 5, 6])")).toBe("32");
});
