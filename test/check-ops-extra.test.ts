// Remaining seed check operators: `is<=>` (spaceship equality), `raises-satisfies`
// / `raises-violates` (the raised exception VALUE applied to a predicate), and the
// parse side of `is-not-roughly`.  Modelled on check-refine.test.ts.
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

const evalPyret = async (src: string) => (await run(await buildSource(src))).output.trimEnd();

// --- is<=> / is-not<=> (spaceship) ---
test("is<=>: passes when values compare equal", async () => {
  const out = await evalPyret(`check:\n  3 is<=> 3\nend`);
  expect(out).toContain("Looks shipshape");
});

test("is<=>: fails when values differ (real pass/fail recording)", async () => {
  const out = await evalPyret(`check:\n  3 is<=> 4\nend`);
  expect(out).toContain("test failed");
});

test("is-not<=>: passes when values differ", async () => {
  const out = await evalPyret(`check:\n  3 is-not<=> 4\nend`);
  expect(out).toContain("Looks shipshape");
});

// --- raises-satisfies / raises-violates ---
test("raises-satisfies: passes when it raises and the predicate holds on the value", async () => {
  const out = await evalPyret(`check:\n  raise(42) raises-satisfies lam(e): e == 42 end\nend`);
  expect(out).toContain("Looks shipshape");
});

test("raises-satisfies: fails when it raises but the predicate is false", async () => {
  const out = await evalPyret(`check:\n  raise(42) raises-satisfies lam(e): e == 7 end\nend`);
  expect(out).toContain("test failed");
});

test("raises-satisfies: fails when it does not raise", async () => {
  const out = await evalPyret(`check:\n  5 raises-satisfies lam(e): true end\nend`);
  expect(out).toContain("test failed");
});

test("raises-violates: passes when it raises and the predicate is false", async () => {
  const out = await evalPyret(`check:\n  raise(42) raises-violates lam(e): e == 7 end\nend`);
  expect(out).toContain("Looks shipshape");
});

test("raises-violates: fails when it raises and the predicate holds", async () => {
  const out = await evalPyret(`check:\n  raise(42) raises-violates lam(e): e == 42 end\nend`);
  expect(out).toContain("test failed");
});

// --- is-roughly (the roughly family; compile + run end to end) ---
test("is-roughly: passes within the default tolerance", async () => {
  const out = await evalPyret(`check:\n  num-sqrt(4) is-roughly 2\nend`);
  expect(out).toContain("Looks shipshape");
});

// NOTE: `is-not-roughly` is wired through the self-hosted surface-parse bridge
// (parse-bridge.ts -> "is-not-roughly" -> parse-from-tree s-op-is-not-roughly) and the
// seed's compileCheckTest handles ISNOTROUGHLY — BUT the seed's vendored GLR tokenizer
// (src/parser/, not owned here) lexes the literal `is-not-roughly` as an identifier
// rather than the ISNOTROUGHLY terminal, so the seed end-to-end path can't reach it yet.
// (is-roughly lexes fine; the is-not- variant is the upstream-tokenizer gap.)
