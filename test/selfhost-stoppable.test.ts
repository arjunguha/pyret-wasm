// Self-hosted compiler STOPPABILITY (CPS) codegen tests.
//
// The deployable IDE runs user code through ONE path: the Pyret->Pyret CPS transform
// (self-host/cps.arr) composed BEFORE the self-hosted compiler, run on the single-thread
// trampoline (run-stoppable.ts). For that to work the self-hosted BACKEND must lower the
// stoppability primitives the CPS pass emits — previously only the TS seed could:
//   yield-check(thunk)        -- per-fn/loop interrupt point  -> runtime $yield (tail call)
//   finish-result(v)          -- the halt continuation        -> stash $result + print
//   cps-op-<op>(a, b, k)      -- overloadable binop threading k (num path or CPS method)
// plus the $do_pause host import + $gas/$paused-thunk/$result globals + the exported
// `resume` (run-stoppable calls it after each pause). These tests feed the backend the
// SAME shapes the CPS pass emits (hand-written here, no full pipeline) and run them on the
// real trampoline, asserting values, the gas/pause/resume cycle, and the cooperative stop.
import { test, expect } from "bun:test";
import { buildSourceSelfHosted } from "../src/build-selfhosted.ts";
import { runStoppable } from "../src/runtime/run-stoppable.ts";

async function stop(src: string, opts: Parameters<typeof runStoppable>[1] = {}) {
  return runStoppable(await buildSourceSelfHosted(src), opts).promise;
}

// finish-result(v): renders + prints v (the non-stoppable last-expression printing) and
// stashes it in $result. Works at top level and INSIDE a (called) lambda continuation —
// the latter regressed first because the intrinsic was captured as a null lambda free var
// (it must be excluded from captures, like every other call-only intrinsic).
test("self-hosted stoppable: finish-result prints the value (top level)", async () => {
  const r = await stop("finish-result(1 + 2)");
  expect(r.output).toBe("3\n");
  expect(r.error).toBeUndefined();
});

test("self-hosted stoppable: finish-result inside a continuation lambda", async () => {
  const r = await stop("k = lam(v): finish-result(v) end\nk(7)");
  expect(r.output).toBe("7\n");
});

// cps-op-<op>(a, b, k): for a numeric/string a, feed the primitive result to k.
test("self-hosted stoppable: cps-op-* numeric path threads the continuation", async () => {
  expect((await stop("cps-op-plus(1, 2, lam(v): finish-result(v) end)")).output).toBe("3\n");
  expect((await stop("cps-op-times(6, 7, lam(v): finish-result(v) end)")).output).toBe("42\n");
  expect((await stop("cps-op-minus(10, 4, lam(v): finish-result(v) end)")).output).toBe("6\n");
  expect((await stop("cps-op-lessthan(1, 2, lam(v): finish-result(v) end)")).output).toBe("true\n");
  expect((await stop("cps-op-greaterequal(2, 5, lam(v): finish-result(v) end)")).output).toBe("false\n");
});

// cps-op-<op> on a DATA value tail-dispatches the overload method a._op(b, k) — a CPS'd
// operator method (trailing continuation), unreachable via the plain (no-continuation)
// operator dispatch. This keeps operator overloads interruptible.
test("self-hosted stoppable: cps-op-* dispatches a CPS'd data _plus method", async () => {
  const r = await stop(
    "data Box:\n  | box(n)\nsharing:\n  method _plus(self, o, k): k(box(self.n + o.n)) end\nend\n" +
    "cps-op-plus(box(1), box(2), lam(r): finish-result(r.n) end)");
  expect(r.output).toBe("3\n");
});

// yield-check(thunk): burns a gas tick then tail-calls the thunk. A finite CPS countdown
// (well under GAS_RESET ticks) runs to completion with no pause.
test("self-hosted stoppable: yield-check drives a finite CPS loop (no pause)", async () => {
  const r = await stop(
    "fun loop(n, k):\n" +
    "  yield-check(lam():\n" +
    "    if n <= 0: k(n) else: loop(n - 1, k) end\n" +
    "  end)\n" +
    "end\n" +
    "loop(5, lam(v): finish-result(v) end)");
  expect(r.output).toBe("0\n");
  expect(r.pauses).toBe(0);
});

// The whole point: an INFINITE CPS loop pauses every GAS_RESET ticks (capturing its
// continuation in $paused-thunk + host-throwing via do_pause), and the trampoline resumes
// it via the exported `resume`. A cooperative Stop (decline to resume) abandons it — this
// is the IDE's stop button. Constant-stack throughout (native tail calls).
test("self-hosted stoppable: infinite CPS loop pauses, resumes, and is stoppable", async () => {
  const wasm = await buildSourceSelfHosted(
    "fun spin(k):\n  yield-check(lam(): spin(k) end)\nend\n" +
    "spin(lam(v): finish-result(v) end)");
  const h = runStoppable(wasm, { onPause: (n) => { if (n >= 3) h.stop(); } });
  const r = await h.promise;
  expect(r.stopped).toBe(true);   // the Stop was serviced (it never finishes on its own)
  expect(r.pauses).toBe(3);       // it paused (gas) and was resumed twice before stopping
});
