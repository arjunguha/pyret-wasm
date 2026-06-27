import file("../../self-compiler/compiler/parse-pyret.arr") as P
import ast as A

# Deeper structural check: parse `5 + x` and walk into the s-op's operands so the
# e2e test can confirm the rebuilt AST carries real payloads (op name, operands).
prog = P.surface-parse("", "test")
op = prog.block.stmts.first
print("label=" + op.label())
print("op=" + op.op)
print("left=" + op.left.label())
print("ln=" + tostring(op.left.n))
print("right=" + op.right.label())
print("rid=" + tostring(op.right.id.s))
