import file("../../self-compiler/compiler/parse-pyret.arr") as P
import ast as A

# A fun/data with a `where:` clause should rebuild a populated `_check` (the where
# block) on the first statement.
prog = P.surface-parse("", "test")
f = prog.block.stmts.first
print("label=" + f.label())
print("haschk=" + tostring(is-some(f._check)))
print("chklabel=" + f._check.value.label())
