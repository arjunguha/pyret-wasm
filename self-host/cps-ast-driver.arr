#lang pyret
# CPS-AST DRIVER: the no-JS-parser counterpart of cps-driver.arr.  It reads RAW Pyret
# source via `read-source()`, parses it with the pure-Pyret parser (pyret-parser.arr)
# into ast.arr nodes, runs the AST-to-AST CPS transform (cps-ast.arr), and prints the
# transformed AST back as source for the seed to compile with {stoppable:true}.
#
# NB: the `.tosource()` render here is a TEST/bootstrap shim ONLY.  cps-program returns
# an ast.arr AST; once the self-hosted backend lowers the stoppability intrinsics
# (yield-check / finish-result / cps-op-*) the AST feeds the backend DIRECTLY — no
# render, no re-parse, no JS parser anywhere on the round-trip.
import file("./pyret-parser.arr") as P
import file("./cps-ast.arr") as C

src = read-source()
prog = P.parse(src)
result-ast = C.cps-program(prog)
print(string-join(result-ast.tosource().pretty(80), "\n"))
nothing      # keep print off the trailing-expression position (avoids double-eval)
