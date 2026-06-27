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

# --- program 3:  cases(List) x: | empty => 1 | else => 2 end  (else-branch kept) ---
cases-prog = cst("program", none, [list:
  cst("block", none, [list:
    cst("stmt", none, [list:
      cst("cases-expr", none, [list:
        cst("ann", none, [list: cst("NAME", some("List"), empty)]),
        cst("binop-expr", none, [list:
          cst("id-expr", none, [list: cst("NAME", some("x"), empty)])]),
        cst("cases-branch", none, [list:
          cst("NAME", some("empty"), empty),
          cst("block", none, [list:
            cst("stmt", none, [list:
              cst("num-expr", none, [list: cst("NUMBER", some("1"), empty)])])])]),
        cst("ELSE", none, empty),
        cst("block", none, [list:
          cst("stmt", none, [list:
            cst("num-expr", none, [list: cst("NUMBER", some("2"), empty)])])])])])])])

# --- program 4:  when x: g(x) end   (yields nothing; body stays interruptible) ---
when-prog = cst("program", none, [list:
  cst("block", none, [list:
    cst("stmt", none, [list:
      cst("when-expr", none, [list:
        cst("binop-expr", none, [list:
          cst("id-expr", none, [list: cst("NAME", some("x"), empty)])]),
        cst("block", none, [list:
          cst("stmt", none, [list:
            cst("app-expr", none, [list:
              cst("id-expr", none, [list: cst("NAME", some("g"), empty)]),
              cst("app-args", none, [list:
                cst("opt-comma-binops", none, [list:
                  cst("comma-binops", none, [list:
                    cst("binop-expr", none, [list:
                      cst("id-expr", none, [list: cst("NAME", some("x"), empty)])])])])])])])])])])])])

# --- program 5:  ask: | x then: 1 | otherwise: 2 end   (lowers to nested if) ---
ask-prog = cst("program", none, [list:
  cst("block", none, [list:
    cst("stmt", none, [list:
      cst("if-pipe-expr", none, [list:
        cst("if-pipe-branch", none, [list:
          cst("binop-expr", none, [list:
            cst("id-expr", none, [list: cst("NAME", some("x"), empty)])]),
          cst("block", none, [list:
            cst("stmt", none, [list:
              cst("num-expr", none, [list: cst("NUMBER", some("1"), empty)])])])]),
        cst("block", none, [list:
          cst("stmt", none, [list:
            cst("num-expr", none, [list: cst("NUMBER", some("2"), empty)])])])])])])])

print("===P1===")
print(cps-transform(fun-call-prog))
print("===P2===")
print(cps-transform(lit-prog))
print("===P3===")
print(cps-transform(cases-prog))
print("===P4===")
print(cps-transform(when-prog))
print("===P5===")
print(cps-transform(ask-prog))
print("===END===")
