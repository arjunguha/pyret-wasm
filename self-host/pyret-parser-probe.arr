# Fixture exercising the pure-Pyret parser (self-host/pyret-parser.arr) end to
# end: source text -> ast.arr AST.  Driven by test/pyret-parser.test.ts.
#
# NOTE: running this currently trips the SAME front-end module-init null-ref that
# affects every program importing ast.arr in the seed today (being fixed in a
# separate lane).  The parser itself COMPILES clean under the seed; the test file
# checks that now and keeps an end-to-end tripwire that flips green once the
# ast-load bug is fixed.
import file("./pyret-parser.arr") as P
import ast as A

fun labels(l):
  cases(List) l:
    | empty => ""
    | link(f, r) => f.label() + " " + labels(r)
  end
end

prog = P.parse("fun f(x): x + 1 end\nf(2)")
labels(prog.block.stmts)
