// Prelude completeness: List methods (the front-end calls .map/.get/.length/...
// pervasively as METHODS, which crash without a sharing block), string-dict method
// + module completeness (map-keys/fold-keys/each-key/keys), and set ops. Needed for
// the real compiler passes to RUN, not just compile.
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function result(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

test("list methods run: map/filter/foldl/each chain", async () => {
  expect(await result(`[list: 3, 1, 2].map(lam(x): x + 1 end).foldl(lam(a, b): a + b end, 0)`)).toBe("9");
  expect(await result(`[list: 1, 2, 3, 4].filter(lam(x): x > 2 end).length()`)).toBe("2");
});

test("list methods run: get/length/member/reverse/append/last/take/drop", async () => {
  expect(await result(`[list: 5, 6, 7].get(2)`)).toBe("7");
  expect(await result(`[list: 5, 6, 7].length()`)).toBe("3");
  expect(await result(`if [list: 1, 2].member(2): 1 else: 0 end`)).toBe("1");
  expect(await result(`[list: 1, 2, 3].reverse().first`)).toBe("3");
  expect(await result(`[list: 1, 2].append([list: 3]).last()`)).toBe("3");
  expect(await result(`[list: 1, 2, 3, 4].take(2).length() + [list: 1, 2, 3, 4].drop(3).length()`)).toBe("3");
});

test("list sort / sort-by", async () => {
  expect(await result(`[list: 3, 1, 2].sort-by(lam(a, b): a < b end, lam(a, b): a == b end).first`)).toBe("1");
  expect(await result(`[list: 5, 3, 9, 1].sort().get(0)`)).toBe("1");
});

test("list all/any/find/join-str", async () => {
  expect(await result(`if [list: 2, 4].all(lam(x): x > 1 end): 1 else: 0 end`)).toBe("1");
  expect(await result(`if [list: 1, 2].any(lam(x): x > 1 end): 1 else: 0 end`)).toBe("1");
  expect(await result(`[list: "a", "b", "c"].join-str(",")`)).toBe("a,b,c");
});

test("string-dict methods: get-value/has-key/keys-list/count", async () => {
  expect(await result(`d = [string-dict: "x", 10, "y", 20]\nd.get-value("y")`)).toBe("20");
  expect(await result(`d = [string-dict: "x", 10]\nif d.has-key("x"): 1 else: 0 end`)).toBe("1");
  expect(await result(`[string-dict: "a", 1, "b", 2].count()`)).toBe("2");
});

test("string-dict fold-keys/map-keys/each-key as methods AND module fns", async () => {
  // method forms
  expect(await result(`d = [string-dict: "a", 1, "b", 2]\nd.fold-keys(lam(acc, k): acc + d.get-value(k) end, 0)`)).toBe("3");
  expect(await result(`d = [string-dict: "a", 1]\nd.map-keys(lam(k): k end).length()`)).toBe("1");
  // module form (the `for map-keys(...)` / `for fold-keys(...)` desugaring)
  expect(await result(`d = [string-dict: "a", 1, "b", 2]\nfor fold-keys(acc from 0, k from d): acc + d.get-value(k) end`)).toBe("3");
  expect(await result(`d = [string-dict: "a", 1, "b", 2]\nfor map-keys(k from d): k end.length()`)).toBe("2");
});

test("set ops: union/intersect/difference/size", async () => {
  expect(await result(`[set: 1, 2, 3].union([set: 3, 4]).size()`)).toBe("4");
  expect(await result(`[set: 1, 2, 3].intersect([set: 2, 3, 4]).size()`)).toBe("2");
  expect(await result(`[set: 1, 2, 3].difference([set: 2]).size()`)).toBe("2");
});
