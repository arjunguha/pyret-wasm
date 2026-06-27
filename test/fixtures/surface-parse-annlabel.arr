import file("../../self-compiler/compiler/parse-pyret.arr") as P
import ast as A

# Prints just the first fun arg's annotation label, for the richer annotation
# forms (a-arrow / a-app / a-dot / a-tuple) that have no `.id` field.
prog = P.surface-parse("", "test")
arg0 = prog.block.stmts.first.args.first
print("annlabel=" + arg0.ann.label())
