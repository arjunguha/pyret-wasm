import file("../../self-compiler/compiler/parse-pyret.arr") as P
import ast as A

# Program-level shape: provide flag, import count/first label, block statement
# count, and the first statement's ctor — drives the prelude / multi-stmt checks.
fun first-imp-label(p):
  if p.imports.length() > 0: p.imports.first.label() else: "none" end
end
prog = P.surface-parse("", "test")
print("prog=" + tostring(A.is-s-program(prog)))
print("provide=" + prog._provide.label())
print("nimports=" + tostring(prog.imports.length()))
print("imp0=" + first-imp-label(prog))
print("nstmts=" + tostring(prog.block.stmts.length()))
print("label=" + prog.block.stmts.first.label())
