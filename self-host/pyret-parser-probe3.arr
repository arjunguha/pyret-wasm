### Probe asserting the pure-Pyret parser produces REAL source locations (not
### dummy-loc): line/column/char offsets and the source name flow through.
import file("./pyret-parser.arr") as P
import ast as A
import srcloc as S

prog = P.parse-named("fun f(x): x + 1 end\nf(2)", "test.arr")

# second statement `f(2)` is on line 2 (1-based), columns 0-based.
app = prog.block.stmts.rest.first
al = app.l
print("app: " + al.source + " " + tostring(al.start-line) + ":" + tostring(al.start-column)
    + "-" + tostring(al.end-line) + ":" + tostring(al.end-column)
    + " char " + tostring(al.start-char) + "-" + tostring(al.end-char))

# the body `x + 1` is an s-op on line 1 starting at column 10 (after "fun f(x): ").
op = prog.block.stmts.first.body.stmts.first
ol = op.l
print("op: line " + tostring(ol.start-line) + " col " + tostring(ol.start-column)
    + " char " + tostring(ol.start-char))
print("is-srcloc: " + tostring(S.is-srcloc(al)))
