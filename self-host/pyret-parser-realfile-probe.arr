### Probe: parse a REAL Pyret source file with the pure-Pyret parser.
### The host supplies the file's text via `read-source()` (state.sourceBytes);
### test/pyret-parser.test.ts instantiates this with a real file's bytes and
### asserts the printed summary.  No JS in the parse itself.
import file("./pyret-parser.arr") as P
import ast as A

fun lbls(l):
  cases(List) l:
    | empty => ""
    | link(f, r) => f.label() + " " + lbls(r)
  end
end

src = read-source()
prog = P.parse(src)
stmts = prog.block.stmts
print("ok stmts=" + to-string(stmts.length()))
print("first=" + cases(List) stmts: | empty => "<none>" | link(f, _) => f.label() end)
print("labels=" + lbls(stmts))
