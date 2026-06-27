### End-to-end probe for round-3 grammar: full check-ops, multi-let / letrec /
### type-let, spy, exact decimals, and tuple-destructuring let.  Run by the seed;
### printed lines are asserted by test/pyret-parser.test.ts.
import file("./pyret-parser.arr") as P
import ast as A

fun lbls(l):
  cases(List) l:
    | empty => ""
    | link(f, r) => f.label() + " " + lbls(r)
  end
end

prog = P.parse(
  "x = 3.14\n"
  + "{a; b} = {1; 2}\n"
  + "let p = 1, q = 2: p + q end\n"
  + "letrec g = lam(): 1 end: g() end\n"
  + "type-let T = Number: 5 end\n"
  + "check:\n"
  + "  5 is 5\n"
  + "  6 is-not 7\n"
  + "  f() does-not-raise\n"
  + "  g(1) is%(within(1)) 2\n"
  + "end\n"
  + "spy \"lbl\": a end")

stmts = prog.block.stmts
print("stmts: " + lbls(stmts))

# x = 3.14  -> s-let, value an exact rational s-num 157/50
xlet = stmts.first
print("dec: " + num-to-string(xlet.value.n))

# ~5 (rough integer) -> s-num holding a roughnum (not an exact 5)
rough = P.parse-expr-string("~5")
print("rough: " + rough.label() + " " + to-string(num-is-roughnum(rough.n)))

# {a; b} = {1; 2}  -> s-let whose binding is a tuple-bind
tlet = stmts.rest.first
print("tuplelet: " + tlet.name.label())

# let p = 1, q = 2: ... end  -> s-let-expr (label "s-let") with 2 binds + a body
mlet = stmts.rest.rest.first
print("multilet: " + mlet.label() + " binds=" + to-string(mlet.binds.length())
  + " body=" + mlet.body.label())

# letrec g = ...: ... end  -> s-letrec with 1 bind
lr = stmts.rest.rest.rest.first
print("letrec: " + lr.label() + " binds=" + to-string(lr.binds.length()))

# type-let T = Number: 5 end  -> s-type-let-expr with s-type-bind binds
tl = stmts.rest.rest.rest.rest.first
print("typelet: " + tl.label() + " " + tl.binds.first.label())

# the check block: three+ check-tests with the right ops
chk = stmts.rest.rest.rest.rest.rest.first
tests = chk.body.stmts
print("checkops: " + to-string(tests.map(lam(t): t.op.label() end)))
# the postfix does-not-raise has no right-hand side
print("postfix-none: " + to-string(is-none(tests.rest.rest.first.right)))
# the refined `is%(...)` test carries a refinement
print("refine-some: " + to-string(is-some(tests.rest.rest.rest.first.refinement)))

# spy "lbl": a end  -> s-spy-block, message present, one implicit-label field
sp = stmts.rest.rest.rest.rest.rest.rest.first
print("spy: " + sp.label() + " msg=" + to-string(is-some(sp.message))
  + " implicit=" + to-string(sp.contents.first.implicit-label))
