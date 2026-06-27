# Drives Pyret's REAL ast.arr visitor machinery: build `1 + 2` as an AST and
# traverse it with a visitor that extends default-map-visitor.  Exercises the
# auto-generated `_match` (the basis of `.visit()`) on real compiler data.
import ast as A

n1 = A.s-num(A.dummy-loc, 1)
n2 = A.s-num(A.dummy-loc, 2)
expr = A.s-op(A.dummy-loc, A.dummy-loc, "op+", n1, n2)

var count = 0
counter = A.default-map-visitor.{
  method s-num(self, l, n):
    count := count + 1
    A.s-num(l, n)
  end
}
result = expr.visit(counter)
print(count)                               # 2 s-num nodes visited
print(result.tosource().pretty(40).first)  # round-trips to "1 + 2"
