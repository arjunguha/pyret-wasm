// Backend regression tests for the SELF-HOSTED compiler (self-host/wasm-of-pyret.arr),
// driven through the real driver via src/build-selfhosted.ts.
//
// Style: trap-on-wrong-value — the program does `1 / 0` when the computed value is wrong,
// so "compiles + runs without error" means the backend computed the right value.

import { test, expect } from "bun:test";
import { runSourceSelfHosted } from "../src/build-selfhosted.ts";

// `f = o.m` takes a method off an object as a VALUE — that value is a $Method wrapping a
// $Closure. Applying it (`f(o, 4)`) used to `ref.cast T-CLOSURE`-fail; a-app now unwraps a
// $Method callee to its $Closure before the call_indirect.
test("self-hosted backend: a method taken as a value is callable (o.m unwraps $Method)", async () => {
  await expect(runSourceSelfHosted(
    "o = { method m(self, k): k + 1 end }\n" +
    "f = o.m\n" +
    "if f(o, 4) == 5: 0 else: 1 / 0 end"
  )).resolves.toBeDefined();
});
