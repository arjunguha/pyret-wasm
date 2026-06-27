// `_` curry shorthand on a MODULE-QUALIFIED call: `N.f(_, b, c)` must desugar to
// `lam(x): N.f(x, b, c) end`. Previously the seed skipped the curry check entirely
// for module-alias calls, so `_` compiled as a bare (unbound) identifier — which
// blocked Pyret's real error.arr/equality.arr (`ED.highlight(_, binds, 3)`).

import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function out(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

test("_ curry on a module-qualified call (first of several args)", async () => {
  // L.foldl(_, 0, lst) -> lam(f): foldl(f, 0, lst); applied with a summing fn -> 6
  expect(await out(
    'import lists as L\n(L.foldl(_, 0, [list: 1, 2, 3]))(lam(acc, x): acc + x end)'
  )).toBe("6");
});

test("_ curry on a module-qualified call still works for a single arg", async () => {
  // L.length(_) -> lam(x): length(x); applied to a list -> 3
  expect(await out(
    'import lists as L\n(L.length(_))([list: 7, 8, 9])'
  )).toBe("3");
});
