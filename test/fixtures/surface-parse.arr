import file("../../self-compiler/compiler/parse-pyret.arr") as P
import ast as A

# surface-parse reads the runtime source (host-delivered) and returns ast.arr AST.
# We print the program/block shape and the first statement's label so the e2e test
# can assert which ast.arr ctor was rebuilt for whatever source the host parsed.
prog = P.surface-parse("", "test")
print("prog=" + tostring(A.is-s-program(prog)))
blk = prog.block
print("blk=" + tostring(A.is-s-block(blk)))
stmt = blk.stmts.first
print("label=" + stmt.label())
