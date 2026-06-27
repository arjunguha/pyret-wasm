// `.visit(visitor)` support — the basis of Pyret's real compiler passes.
//
// Each data variant's `visit` method is `self._match(visitor, lam(v): raise(...) end)`.
// `_match` is Pyret's auto-generated dispatcher (runtime.js makeMatch): it looks up a
// field on the visitor named after the variant and calls it with the variant's fields,
// else calls the else-clause with self.  The seed didn't implement `_match`, so any
// `.visit()` (and thus every visitor-based pass: desugar/resolve-scope/anf) crashed
// with "object does not have the requested field".  The seed now routes `obj._match(h,e)`
// to the runtime `$variant_match`.  See src/compiler/compile.ts:emitVariantMatch.

import { test, expect } from "bun:test";
import { buildSource, buildSourceFile } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";
import { resolve } from "path";

async function evalPyret(src: string): Promise<string> {
  const { output } = await run(await buildSource(src));
  return output.trimEnd();
}

// A hand-rolled data type whose `visit` method uses `_match`, with a visitor whose
// handlers are METHODS (self-bound) — exactly the ast.arr shape.  (The seed echoes
// the value of the final top-level expression, so we end on the value under test.)
test(".visit() dispatches through _match (method handlers)", async () => {
  const out = await evalPyret(`
    data Tree:
      | leaf(v)
      | node(l, r)
    sharing:
      method visit(self, visitor):
        self._match(visitor, lam(x): raise("no field for " + tostring(x)) end)
      end
    end
    doubler = {
      method leaf(self, v): leaf(v * 2) end,
      method node(self, l, r): node(l.visit(self), r.visit(self)) end
    }
    t = node(leaf(1), leaf(20)).visit(doubler)
    cases(Tree) t:
      | leaf(v) => 0
      | node(l, r) => cases(Tree) l: | leaf(v) => v | node(_, _) => 0 - 1 end
    end
  `);
  expect(out).toBe("2"); // leaf(1) doubled, read back through the rebuilt tree
});

// _match's else-clause fires when the visitor lacks a handler for the variant.
test("_match falls back to the else-clause for an unhandled variant", async () => {
  const out = await evalPyret(`
    data T: | a(x) | b(y) end
    handlers = { method a(self, x): "got-a" end }
    fun visit(v): v._match(handlers, lam(s): "ELSE" end) end
    visit(a(1)) + "," + visit(b(2))
  `);
  expect(out).toBe("got-a,ELSE");
});

// THE PAYOFF: Pyret's real ast.arr default-map-visitor traverses a real AST.
test("real ast.arr default-map-visitor traverses an AST via .visit()", async () => {
  const wasm = await buildSourceFile(resolve(import.meta.dir, "fixtures/visitor-ast.arr"));
  const { output } = await run(wasm);
  const lines = output.trim().split("\n");
  expect(lines[0]).toBe("2");        // both s-num nodes were visited
  expect(lines[1]).toBe("1 + 2");    // and the tree round-trips to source
});
