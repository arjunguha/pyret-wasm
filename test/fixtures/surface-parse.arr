import file("../../self-compiler/compiler/parse-pyret.arr") as P
import ast as A

# surface-parse reads the runtime source (host-delivered) and returns ast.arr AST.
prog = P.surface-parse("5", "test")
print("prog=" + tostring(A.is-s-program(prog)))
blk = prog.block
print("blk=" + tostring(A.is-s-block(blk)))
stmt = blk.stmts.first
print("num=" + tostring(A.is-s-num(stmt)))
print("n=" + tostring(stmt.n))
