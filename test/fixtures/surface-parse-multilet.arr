import file("../../self-compiler/compiler/parse-pyret.arr") as P
import ast as A

# multi-binding let: `let a = 1, var b = 2: a end` -> s-let-expr with two binds
# (a s-let-bind and a s-var-bind). NOTE: s-let-expr.label() is "s-let" in ast.arr,
# and LetBind variants have no label(), so assert variant identity via predicates.
prog = P.surface-parse("", "test")
e = prog.block.stmts.first
print("is-let-expr=" + tostring(A.is-s-let-expr(e)))
print("nbinds=" + tostring(e.binds.length()))
print("b0-let=" + tostring(A.is-s-let-bind(e.binds.first)))
print("b1-var=" + tostring(A.is-s-var-bind(e.binds.rest.first)))
