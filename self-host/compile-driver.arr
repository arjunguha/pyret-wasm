provide *
# End-to-end SELF-HOSTED compile driver: source String -> WASM bytes, emitted via
# `emit-byte`. Chains the self-hosted front-end (surface-parse -> [desugar-scope ->
# resolve -> desugar] -> anf) into the wasm-of-pyret backend. Compiled by the seed;
# the bytes it emits ARE the target program's module (produced by Pyret-in-WASM).
#
# Run via src/build-selfhost.ts compileWithModule (sets sourceBytes + parseNodes),
# collecting state.emitted. surface-parse reads the host parse-node stream, so the
# target program is whatever the host primed (read-source / parseNodes), not `src`.

import file("../self-compiler/compiler/parse-pyret.arr") as P
import ast as A
import anf as ANF
import file("./wasm-of-pyret.arr") as W

# anf-program reads `provides.first`; surface-parse leaves that field `empty`, and
# the backend ignores provides anyway — so patch in a singleton placeholder.
fun fix-provides(prog :: A.Program) -> A.Program:
  cases(A.Program) prog:
    | s-program(l, u, p, pt, _, imports, blk) =>
      A.s-program(l, u, p, pt, [list: A.s-provide-none(l)], imports, blk)
  end
end

fun compile-source(src) -> List<Number>:
  ast = P.surface-parse(src, "test")
  # NOTE: desugar/resolve-scope need a C.CompileEnvironment (heavy) and `desugar`
  # null-refs standalone — so this minimal driver only handles already-core forms
  # (literals/blocks that anf accepts directly). Operators/`if`/etc. need desugar.
  fixed = fix-provides(ast)
  aprog = ANF.anf-program(fixed)
  W.compile-prog(aprog)
end

fun do-emit(bytes) block:
  each(lam(b): emit-byte(b) end, bytes)
end

do-emit(compile-source(read-source()))
