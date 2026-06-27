// Value-model: general construct-expr ([C: ...] = C.make([raw-array: ...])), raw
// arrays, string-dict, and sets. Needed by Pyret's real compiler passes.
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function result(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

test("raw arrays: literal, get, length, to-list, fold", async () => {
  expect(await result(`ra = [raw-array: 10, 20, 30]\nraw-array-get(ra, 1) + raw-array-length(ra)`)).toBe("23");
  expect(await result(`sum(raw-array-to-list([raw-array: 1, 2, 3, 4]))`)).toBe("10");
  expect(await result(`raw-array-fold(lam(acc, e, i): acc + e end, 0, [raw-array: 5, 6, 7], 0)`)).toBe("18");
  expect(await result(`raw-array-length([raw-array: ])`)).toBe("0");
});

test("general construct: [C: ...] calls C.make([raw-array: ...])", async () => {
  // a custom constructor object whose make returns the element count
  expect(await result(`box = { make: lam(arr): raw-array-length(arr) end }\n[box: 7, 8, 9, 10]`)).toBe("4");
});

test("string-dict: get-value / has-key / count / set / remove / keys-list", async () => {
  expect(await result(`sd = [string-dict: "a", 1, "b", 2]\nsd.get-value("a") + sd.get-value("b") + sd.count()`)).toBe("5");
  expect(await result(`if [string-dict: "a", 1].has-key("a"): 1 else: 0 end`)).toBe("1");
  expect(await result(`if [string-dict: "a", 1].has-key("z"): 1 else: 0 end`)).toBe("0");
  expect(await result(`[string-dict: "a", 1].set("b", 9).get-value("b")`)).toBe("9");
  expect(await result(`[string-dict: "a", 1, "b", 2].set("a", 5).get-value("a")`)).toBe("5"); // latest wins
  expect(await result(`[string-dict: "a", 1, "b", 2].remove("a").count()`)).toBe("1");
  expect(await result(`length([string-dict: "a", 1, "b", 2, "c", 3].keys-list())`)).toBe("3");
});

test("sets: member / size (dedup) / add / union", async () => {
  expect(await result(`[set: 1, 2, 2, 3].size()`)).toBe("3");
  expect(await result(`if [set: 1, 2, 3].member(2): 1 else: 0 end`)).toBe("1");
  expect(await result(`[set: 1, 2].add(3).add(2).size()`)).toBe("3");
  expect(await result(`[set: 1, 2, 3].union([set: 3, 4, 5]).size()`)).toBe("5");
  expect(await result(`[set: ].size()`)).toBe("0");
});

test("field access by name dispatches on the value's actual variant (shared name, different index)", async () => {
  // `x` is index 0 in circ but index 2 in rect; reading `.x` through a common-typed
  // binding must resolve at runtime, not pick one compile-time index.
  const prog = `
data Shape:
  | circ(x, y, r)
  | rect(w, h, x, y)
end
fun get-x(s): s.x end
get-x(circ(1, 2, 3)) + get-x(rect(10, 20, 7, 8))`;
  expect(await result(prog)).toBe("8"); // 1 + 7
});

test("field access by name: same field across all variants", async () => {
  const prog = `
data Tree:
  | leaf(value)
  | node(value, left, right)
end
fun val(t): t.value end
val(leaf(5)) + val(node(9, leaf(1), leaf(2)))`;
  expect(await result(prog)).toBe("14"); // 5 + 9
});

test("raw-array builders: raw-array-of / from-list / map", async () => {
  expect(await result(`raw-array-length(raw-array-of(7, 5))`)).toBe("5");
  expect(await result(`raw-array-get(raw-array-of(7, 5), 3)`)).toBe("7");
  expect(await result(`sum(raw-array-to-list(raw-array-from-list([list: 4, 5, 6])))`)).toBe("15");
  expect(await result(`sum(raw-array-to-list(raw-array-map(lam(x): x * x end, [raw-array: 2, 3, 4])))`)).toBe("29");
});

test("immutable string-dict: literal, get-value, fold-keys", async () => {
  expect(await result(`[string-dict: "a", 1, "b", 2].get-value("b")`)).toBe("2");
  expect(await result(`make-string-dict().has-key("x")`)).toBe("false");
  expect(await result(`
    d = [string-dict: "a", 10, "b", 20, "c", 30]
    fold-keys(lam(acc, k): acc + d.get-value(k) end, 0, d)`)).toBe("60");
});

test("mutable string-dict: set-now mutates a shared cell; each-key-now", async () => {
  expect(await result(`
    d = make-mutable-string-dict()
    d.set-now("x", 5)
    d.set-now("y", 7)
    d.set-now("x", 9)
    d.get-value-now("x") + d.get-value-now("y")`)).toBe("16");
  expect(await result(`
    d = [mutable-string-dict: "a", 1, "b", 2]
    var s = 0
    d.each-key-now(lam(k): s := s + d.get-value-now(k) end)
    s`)).toBe("3");
  expect(await result(`[mutable-string-dict: "a", 1].has-key-now("a")`)).toBe("true");
});
