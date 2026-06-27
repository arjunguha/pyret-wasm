#lang pyret
# CPS DRIVER: glue that lets the TS stoppable build run the Pyret CPS transform.
# It reads a length-prefixed serialization of the user program's CST (delivered via
# `read-source`, produced by serializeCstNode in src/build-stoppable-core.ts —
# the two MUST stay in sync), rebuilds the `cst(name, value, kids)` tree that
# `cps-transform` consumes, runs the transform, and prints the resulting
# (continuation-passing) Pyret source for the seed to compile with {stoppable:true}.
import file("./cps.arr") as CPS

# read a base-10 int terminated by a single space (which is consumed); returns
# {value; rest-of-codepoints}.
fun read-int(cps):
  fun go(l, acc):
    cases(List) l:
      | empty => {acc; empty}
      | link(c, r) =>
        if (c >= 48) and (c <= 57): go(r, (acc * 10) + (c - 48))
        else: {acc; r}        # c is the space separator -> consume it
        end
    end
  end
  go(cps, 0)
end

# take exactly k code points -> {string; rest}.
fun read-chars(cps, k):
  {string-from-code-points(list-take(cps, k)); list-drop(cps, k)}
end

# parse one serialized node -> {CstNode; rest}.
fun read-node(cps):
  ni = read-int(cps)
  nkids = ni.{0}
  nl = read-int(ni.{1})
  nc = read-chars(nl.{1}, nl.{0})
  name = nc.{0}
  after-name = nc.{1}
  flag = after-name.first
  after-flag = after-name.rest
  vres = if flag == 49:                       # '1' -> has value
    vl = read-int(after-flag)
    vc = read-chars(vl.{1}, vl.{0})
    {some(vc.{0}); vc.{1}}
  else:
    {none; after-flag}                        # '0' -> no value
  end
  kres = read-nodes(vres.{1}, nkids, empty)
  {cst(name, vres.{0}, kres.{0}); kres.{1}}
end

# parse n nodes in sequence (order preserved) -> {List<CstNode>; rest}.
fun read-nodes(cps, n, acc):
  if n == 0: {acc; cps}
  else:
    nr = read-node(cps)
    read-nodes(nr.{1}, n - 1, acc + [list: nr.{0}])
  end
end

src = read-source()
root = read-node(string-to-code-points(src)).{0}
result = cps-transform(root)
print(result)
nothing       # keep print off the trailing-expression position (avoids double-eval)
