// Self-hosted BACKEND regression tests (self-host/wasm-of-pyret.arr), driven through the
// real driver via src/build-selfhosted.ts.
// - object `.{ ... }` extend + method dispatch (extend was doubly broken: the backend
//   passed the super as anyref where $obj_extend wants (ref $Object); the driver's s-extend
//   desugar read f.value, crashing on method fields). Both fixed.
// - method-as-value: `f = o.m` is a $Method wrapping a $Closure; a-app unwraps it before call.
import { test, expect } from "bun:test";
import { buildSourceSelfHosted, runSelfHostedModule, runSourceSelfHosted } from "../src/build-selfhosted.ts";

async function selfHosted(src: string): Promise<string> {
  return (await runSelfHostedModule(await buildSourceSelfHosted(src))).trim();
}

test("object extend with a DATA field validates + reads back (was: validation error)", async () => {
  expect(await selfHosted(`base = { x: 1 }\next = base.{ y: 2 }\nprint(ext.x)`)).toContain("1");
});

test("object extend with a METHOD: call the override", async () => {
  const out = await selfHosted(`base = { method m(self): 11 end }\next = base.{ method m(self): 100 end }\nprint(ext.m())`);
  expect(out).toContain("100");
});

test("object extend with a METHOD: call an inherited base method", async () => {
  const out = await selfHosted(`base = { method m(self): 11 end }\next = base.{ method k(self): 22 end }\nprint(ext.m())`);
  expect(out).toContain("11");
});

test("object extend with a METHOD: call the newly-added method", async () => {
  const out = await selfHosted(`base = { method m(self): 11 end }\next = base.{ method k(self): 22 end }\nprint(ext.k())`);
  expect(out).toContain("22");
});

// `f = o.m` takes a method off an object as a VALUE — a $Method wrapping a $Closure.
// Applying it (`f(o, 4)`) used to ref.cast-fail; a-app now unwraps a $Method callee first.
test("self-hosted backend: a method taken as a value is callable (o.m unwraps $Method)", async () => {
  await expect(runSourceSelfHosted(
    "o = { method m(self, k): k + 1 end }\n" +
    "f = o.m\n" +
    "if f(o, 4) == 5: 0 else: 1 / 0 end"
  )).resolves.toBeDefined();
});

// Constant-stack codegen: a long statement SPINE (hundreds of lets) used to overflow the
// WASM stack — the backend's byte-list concatenation (concat-bytes/code-entry) and the
// compile-aexpr spine recursion were non-tail. Now tail-recursive, so a big body compiles.
test("self-hosted backend: a long let-spine compiles + runs (constant stack)", async () => {
  const n = 400;
  let src = "x0 = 0\n";
  for (let i = 1; i <= n; i = i + 1) src = src + ("x" + i + " = x" + (i - 1) + " + 1\n");
  src = src + ("if x" + n + " == " + n + ": 0 else: 1 / 0 end");
  await expect(runSourceSelfHosted(src)).resolves.toBeDefined();
});

// Many nested if/else (mid-chain branch bodies) — exercised the a-if/compile-branches
// concat-bytes path that previously deep-appended onto the accumulated branch bytes.
test("self-hosted backend: deep nested-if chain compiles + runs", async () => {
  const n = 120;
  let expr = "0";
  for (let i = 0; i < n; i = i + 1) expr = "if true: " + expr + " else: 1 / 0 end";
  await expect(runSourceSelfHosted("if (" + expr + ") == 0: 0 else: 1 / 0 end")).resolves.toBeDefined();
});

// Roughnum LITERALS (~3.14, PI, …) used to compile to corrupt IEEE-754 bytes — the encoder's
// f64-bits did num-modulo/num-quotient on a ROUGHNUM, which ref.cast-traps DURING compilation.
// Now f64-bits emits faithful IEEE-754 bytes, so roughnum literals compile + run.
test("self-hosted backend: roughnum literals compile + run (faithful f64-bits, no encode trap)", async () => {
  for (const lit of ["~3.14", "~0.5", "~-2.5", "~5.0"]) {
    await expect(runSourceSelfHosted(`x = ${lit}\nprint("ok")`)).resolves.toBeDefined();
  }
});

// EXACT-RATIONAL LITERALS: `1/2`, `3.14`(=157/50) compile to a $Rational via $make_rat
// (num/den extracted by the minimal-denominator search in a-num) and render as "num/den".
// This was the LAST self-compile blocker for the merged compiler (compiler2 now builds).
test("self-hosted backend: exact-rational literals compile, run + render num/den", async () => {
  expect(await selfHosted("print(1/2)")).toBe("1/2");
  expect(await selfHosted("print(3.14)")).toBe("157/50");
});

// Rough number TOWER (self-host/runtime.arr): rendering ($render_rough) + arithmetic /
// comparison with Pyret contagion (any rough operand -> rough result). Previously
// $render_num printed the "roughnum" placeholder and rough ops ref.cast-trapped.
test("self-hosted: roughnums render as ~decimal ($render_rough)", async () => {
  expect(await selfHosted("print(~3.14)")).toBe("~3.14");
  expect(await selfHosted("print(~5.0)")).toBe("~5");
  expect(await selfHosted("print(~0.5)")).toBe("~0.5");
  expect(await selfHosted("print(0 - ~0.5)")).toBe("~-0.5"); // negative
});

test("self-hosted: rough arithmetic + contagion + comparison", async () => {
  expect(await selfHosted("print(~1.5 + ~2.0)")).toBe("~3.5");
  expect(await selfHosted("print(~1.5 + 2)")).toBe("~3.5");   // fix+rough = rough (contagion)
  await expect(runSourceSelfHosted("if ~1.5 < ~2.0: 0 else: 1 / 0 end")).resolves.toBeDefined();
  await expect(runSourceSelfHosted("if (~1.5 + 2) == ~3.5: 0 else: 1 / 0 end")).resolves.toBeDefined();
});

// Per-function declared-local count is now EXACT (was a fixed 512 cap). A function needing
// >512 locals (a long let-spine) used to fail WASM INSTANTIATION with "unknown local 512";
// the backend now declares (max local index used) + margin, so big functions validate. This
// was the last blocker for the self-hosted compiler to compile its OWN large functions.
test("self-hosted backend: a function with >512 locals instantiates (no fixed local cap)", async () => {
  let src = "x0 = 0\n";
  for (let i = 1; i <= 600; i = i + 1) src = src + ("x" + i + " = x" + (i - 1) + " + 1\n");
  src = src + ("if x600 == 600: 0 else: 1 / 0 end");
  await expect(runSourceSelfHosted(src)).resolves.toBeDefined();
});

// THE FIXPOINT BLOCKER (compiler2 runs): top-level FORWARD REFERENCES. The merged compiler's
// top-level value initializers reference funs/data-ctors defined LATER, so compiler2's main()
// null-refs at init (the global isn't set yet). Root cause is the DRIVER's desugar-stmts
// (self-host/compile-driver.arr), which only hoists CONSECUTIVE s-fun runs instead of hoisting
// ALL top-level fun/data defs into one outer s-letrec (as the seed / real Pyret desugar-scope
// do). Backend (wasm-of-pyret) is NOT at fault. Un-skip once the driver hoists.
test.skip("self-hosted: top-level value can forward-reference a later fun (driver hoist)", async () => {
  await expect(runSourceSelfHosted("x = f(5)\nfun f(n): n + 1 end\nif x == 6: 0 else: 1 / 0 end")).resolves.toBeDefined();
});
