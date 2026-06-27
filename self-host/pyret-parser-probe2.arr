### End-to-end probe for the pure-Pyret parser's richer grammar: full annotations
### (name / app / arrow), a `type` alias, and a tuple-binding argument.  Run by the
### seed; printed lines are asserted by test/pyret-parser.test.ts.
import file("./pyret-parser.arr") as P
import ast as A

fun lbls(l):
  cases(List) l:
    | empty => ""
    | link(f, r) => f.label() + " " + lbls(r)
  end
end

prog = P.parse(
  "type Nums = List<Number>\n"
  + "fun f(x :: Number, g :: (Number -> String)) -> String:\n"
  + "  g(x)\n"
  + "end\n"
  + "fun h({a; b}): a end")

stmts = prog.block.stmts
print("stmts: " + lbls(stmts))

f-stmt = stmts.rest.first              # the `f` function
print("ret: " + f-stmt.ann.label())   # a-name (String)
arg0 = f-stmt.args.first              # x :: Number
print("arg0: " + arg0.ann.label())   # a-name
arg1 = f-stmt.args.rest.first        # g :: (Number -> String)
print("arg1: " + arg1.ann.label())   # a-arrow

talias = stmts.first                 # type Nums = List<Number>
print("talias: " + talias.label() + " " + talias.ann.label())  # s-type a-app

h-stmt = stmts.rest.rest.first       # fun h({a; b}): a end
print("hbind: " + h-stmt.args.first.label())  # s-tuple-bind
