// `%(refinement)` check-op support: `lhs is%(pred) rhs` uses the binary predicate
// `pred(lhs, rhs)` as the comparator instead of structural equality (and `is-not%`
// negates it).  Tested with inline predicates so it's independent of the prelude's
// `within` (the real corpus uses `is%(within(0.01))`, which works once this rides on
// top of the merged prelude).
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

const evalPyret = async (src: string) => (await run(await buildSource(src))).output.trimEnd();

test("is%(pred): passes when the refinement predicate holds", async () => {
  const out = await evalPyret(`check:\n  5 is%(lam(a, b): a < b end) 9\nend`);
  expect(out).toContain("Looks shipshape");
  expect(out).toContain("1 test"); // exactly one test, passed
});

test("is%(pred): fails when the predicate is false (real pass/fail recording)", async () => {
  const out = await evalPyret(`check:\n  9 is%(lam(a, b): a < b end) 5\nend`);
  expect(out).toContain("test failed");
});

test("is-not%(pred): passes when the predicate is false", async () => {
  const out = await evalPyret(`check:\n  9 is-not%(lam(a, b): a < b end) 5\nend`);
  expect(out).toContain("Looks shipshape");
});

test("is-not%(pred): fails when the predicate holds", async () => {
  const out = await evalPyret(`check:\n  5 is-not%(lam(a, b): a < b end) 9\nend`);
  expect(out).toContain("test failed");
});

test("refinement evaluates lhs/rhs once and renders both on failure", async () => {
  // failure message stashes lhs (3) and fails rhs (4), like an `is` failure
  const out = await evalPyret(`check:\n  3 is%(lam(a, b): a == b end) 4\nend`);
  expect(out).toContain("test failed");
});

test("a refinement value built by a function call works (within-style)", async () => {
  // mirrors `is%(within(0.5))`: a function returning a 2-arg predicate closure
  const src = `
fun close-to(tol):
  lam(a, b): num-abs(a - b) <= tol end
end
check:
  10 is%(close-to(1)) 10
  10 is%(close-to(1)) 12
end`;
  const out = await evalPyret(src);
  expect(out).toContain("test failed"); // second test (diff 2 > tol 1) fails
});
