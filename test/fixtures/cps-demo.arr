#lang pyret
# Drives the Pyret->Pyret CPS transform (self-host/cps.arr) on hand-built CstNodes
# and prints the emitted (stoppable) source, so test/cps.test.ts can assert the shape:
# a continuation param is threaded, function entry is wrapped in yield-check, and
# general calls become tail calls passing the continuation along.
include file("../../self-host/cps.arr")

# --- program 1:  fun f(n): g(n) end   (g is a general, non-primitive call) ---
fun-call-prog = cst("program", none, [list:
  cst("block", none, [list:
    cst("stmt", none, [list:
      cst("fun-expr", none, [list:
        cst("NAME", some("f"), empty),
        cst("fun-header", none, [list:
          cst("args", none, [list:
            cst("binding", none, [list: cst("NAME", some("n"), empty)])])]),
        cst("block", none, [list:
          cst("stmt", none, [list:
            cst("app-expr", none, [list:
              cst("id-expr", none, [list: cst("NAME", some("g"), empty)]),
              cst("app-args", none, [list:
                cst("opt-comma-binops", none, [list:
                  cst("comma-binops", none, [list:
                    cst("binop-expr", none, [list:
                      cst("id-expr", none, [list: cst("NAME", some("n"), empty)])])])])])])])])])])])])

# --- program 2:  5   (a bare literal -> fed to the final continuation) ---
lit-prog = cst("program", none, [list:
  cst("block", none, [list:
    cst("stmt", none, [list:
      cst("num-expr", none, [list: cst("NUMBER", some("5"), empty)])])])])

print("===P1===")
print(cps-transform(fun-call-prog))
print("===P2===")
print(cps-transform(lit-prog))
print("===END===")
