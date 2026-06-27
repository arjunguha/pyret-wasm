import file("../../self-compiler/compiler/parse-pyret.arr") as P
import ast as A

# Typed binding: the first fun arg should carry an a-name annotation.
prog = P.surface-parse("", "test")
f = prog.block.stmts.first
arg0 = f.args.first
print("argname=" + arg0.id.s)
print("annlabel=" + arg0.ann.label())
print("anntype=" + arg0.ann.id.s)
