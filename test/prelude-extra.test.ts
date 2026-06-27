// Prelude-ahead completeness: Option .or-else/.and-then methods + List .push/.map2.
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function out(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

test("Option .or-else returns value or default", async () => {
  expect(await out("some(5).or-else(0)")).toBe("5");
  expect(await out("none.or-else(7)")).toBe("7");
});

test("Option .and-then maps the value, none passes through", async () => {
  expect(await out("cases(Option) some(5).and-then(lam(x): x + 1 end): | some(v) => v | none => 0 end")).toBe("6");
  expect(await out("cases(Option) none.and-then(lam(x): x + 1 end): | some(v) => v | none => 0 end")).toBe("0");
});

test("List .push prepends an element", async () => {
  expect(await out("[list: 1, 2, 3].push(0).get(0)")).toBe("0");
  expect(await out("[list: 1, 2, 3].push(0).length()")).toBe("4");
});

test("List .map2 zips with a function", async () => {
  expect(await out("[list: 1, 2, 3].map2([list: 10, 20, 30], lam(a, b): a + b end).foldl(lam(acc, x): acc + x end, 0)")).toBe("66");
});

// --- numeric tolerance family (within / num-within*), num-truncate, join-str ---
test("num-truncate truncates toward zero", async () => {
  // exact-rational inputs (7/2 = 3.5 exact) avoid the roughnum-printing gap
  expect(await out("num-truncate(7 / 2)")).toBe("3");
  expect(await out("num-truncate(0 - (7 / 2))")).toBe("-3");
  expect(await out("num-truncate(5)")).toBe("5");
});

test("num-within-abs / within-abs (absolute tolerance, 2-arg predicate)", async () => {
  expect(await out("num-within-abs(0.2)(1, 1)")).toBe("true");
  expect(await out("num-within-abs(0.2)(1, 2)")).toBe("false");
  expect(await out("within-abs(0.5)(10, 10)")).toBe("true");
  expect(await out("within-abs(0.5)(10, 20)")).toBe("false");
});

test("num-within / within (relative tolerance) — bare form is relative", async () => {
  expect(await out("num-within(0.001)(1, 1)")).toBe("true");
  expect(await out("num-within(0.001)(1, 2)")).toBe("false");
  expect(await out("num-within-rel(0.5)(10, 11)")).toBe("true"); // err 1 <= 0.5*min(10,11)=5
  expect(await out("within-rel(0.001)(100, 100)")).toBe("true");
});

test("join-str tostrings elements then joins", async () => {
  expect(await out('join-str([list: 1, 2, 3], "+")')).toBe("1+2+3");
  expect(await out('join-str([list: ], ",")')).toBe("");
  expect(await out('join-str([list: 5], "+")')).toBe("5");
});
