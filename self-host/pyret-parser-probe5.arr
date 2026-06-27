### Probe: generic INSTANTIATION (`name<Ann,...>(...)`) vs comparison (`a < b`),
### parsed by the pure-Pyret parser.  Confirms the LANGLE-vs-LT disambiguation:
### no-ws `<` whose matching `>` is followed by `(` is a type application; a real
### `<` comparison stays an s-op.
import file("./pyret-parser.arr") as P
import ast as A

e1 = P.parse("f<Number>(3)").block.stmts.first
head1 = cases(A.Expr) e1: | s-app(_, f, _) => f.label() | else => "?" end
print("inst-expr=" + e1.label() + "/head=" + head1)
print("cmp=" + P.parse("a < b").block.stmts.first.label())
forit = P.parse("for raw-array-fold2<Number, Number, Number>(acc from 0, x from y): acc end").block.stmts.first
print("for-iter=" + forit.iterator.label())
