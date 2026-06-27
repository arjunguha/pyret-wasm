// Multi-list prelude family: map3/map4/each2/each3 (used by the real front-end).
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function out(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

test("map3 / map4 (lockstep)", async () => {
  expect(await out(
    "foldl(lam(s, x): s + x end, 0, map3(lam(a, b, c): (a + b) + c end, [list: 1, 2], [list: 10, 20], [list: 100, 200]))"
  )).toBe("333");
  expect(await out(
    "foldl(lam(s, x): s + x end, 0, map4(lam(a, b, c, d): ((a + b) + c) + d end, [list: 1], [list: 2], [list: 3], [list: 4]))"
  )).toBe("10");
});

test("each2 / each3 (side-effecting, lockstep)", async () => {
  expect(await out(
    "fun go():\n  var s = 0\n  each2(lam(a, b): s := s + (a * b) end, [list: 1, 2, 3], [list: 4, 5, 6])\n  s\nend\ngo()"
  )).toBe("32");
  expect(await out(
    "fun go():\n  var t = 0\n  each3(lam(a, b, c): t := t + ((a + b) + c) end, [list: 1, 2], [list: 10, 20], [list: 100, 200])\n  t\nend\ngo()"
  )).toBe("333");
});
