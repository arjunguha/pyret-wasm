import file("../../self-compiler/compiler/parse-pyret.arr") as P
import ast as A

# data with a `ref` member, a variant `with:` method, and a `sharing:` method.
prog = P.surface-parse("", "test")
d = prog.block.stmts.first
v = d.variants.first
m = v.members.first
print("mtype=" + m.member-type.label())          # s-mutable for `ref x`
print("nwith=" + tostring(v.with-members.length()))
print("wmlabel=" + v.with-members.first.label())  # s-method-field
print("nshared=" + tostring(d.shared-members.length()))
print("shlabel=" + d.shared-members.first.label())
