provide *
# Pyret side of the self-hosted parser (Option B in parser-plan.md). The seed's
# JS GLR parser produces a CST; the host (src/runtime/parse-bridge.ts) lowers it
# to a FLAT pre-order array of tagged nodes and exposes it via four intrinsics:
#   parse-num-nodes()    -> node count (also triggers the host-side parse)
#   parse-node-tag(i)    -> tag code (must match parse-bridge.ts TAGS)
#   parse-node-nkids(i)  -> child count (children follow immediately, pre-order)
#   parse-node-str(i)    -> the node's string payload
# We walk the array with a shared cursor and build real ast.arr AST values. Core
# forms plus app/dot/if/let/var/fun/lam/construct/check-test are handled here;
# growing the table is matched by growing the lowering in parse-bridge.ts.
import ast as A

# Tag codes — keep in sync with src/runtime/parse-bridge.ts TAGS.
PROGRAM = 0
BLOCK = 1
NUM = 2
STR = 3
BOOL = 4
ID = 5
OP = 6
APP = 7
DOT = 8
IF = 9
LET = 10
VAR = 11
FUN = 12
LAM = 13
CONSTRUCT = 14
CHECKTEST = 15
EXPRS = 16
BINDS = 17
BIND = 18

# Shared read cursor into the flat pre-order stream.
var cursor = 0

# A bare s-name binding with no annotation.
fun mk-bind(l, s):
  A.s-bind(l, false, A.s-name(l, s), A.a-blank)
end

# The check-op kind string (from parse-bridge) -> an ast.arr CheckOp value.
fun check-op(l, s):
  if s == "is": A.s-op-is(l)
  else if s == "is-not": A.s-op-is-not(l)
  else if s == "is==": A.s-op-is-op(l, "op==")
  else: A.s-op-is(l)
  end
end

fun build-node(tag, s, kids):
  l = A.dummy-loc
  if tag == NUM: A.s-num(l, string-to-number(s).value)
  else if tag == STR: A.s-str(l, s)
  else if tag == BOOL: A.s-bool(l, s == "true")
  else if tag == ID: A.s-id(l, A.s-name(l, s))
  else if tag == OP: A.s-op(l, l, s, kids.get(0), kids.get(1))
  else if tag == BLOCK: A.s-block(l, kids)
  else if tag == DOT: A.s-dot(l, kids.get(0), s)
  else if tag == APP: A.s-app(l, kids.get(0), kids.get(1))
  else if tag == CONSTRUCT:
    A.s-construct(l, A.s-construct-normal, kids.get(0), kids.get(1))
  else if tag == LET: A.s-let(l, mk-bind(l, s), kids.get(0), false)
  else if tag == VAR: A.s-var(l, mk-bind(l, s), kids.get(0))
  else if tag == FUN:
    A.s-fun(l, s, empty, kids.get(0), A.a-blank, "", kids.get(1), none, none, false)
  else if tag == LAM:
    A.s-lam(l, "", empty, kids.get(0), A.a-blank, "", kids.get(1), none, none, false)
  else if tag == IF:
    branches = [list: A.s-if-branch(l, kids.get(0), kids.get(1))]
    if kids.length() >= 3: A.s-if-else(l, branches, kids.get(2), false)
    else: A.s-if(l, branches, false)
    end
  else if tag == CHECKTEST:
    A.s-check-test(l, check-op(l, s), none, kids.get(0), some(kids.get(1)), none)
  else if tag == BIND: mk-bind(l, s)
  else if tag == BINDS: kids   # a List<Bind>
  else if tag == EXPRS: kids   # a List<Expr>
  else if tag == PROGRAM:
    # Minimal program shell: provides/imports decoding is TODO(port).
    A.s-program(l, none, A.s-provide-none(l), A.s-provide-types-none(l),
      empty, empty, kids.get(0))
  else: raise("from-tree: unhandled tag " + tostring(tag))
  end
end

# Read `n` sibling nodes left-to-right (each call advances the shared cursor).
fun read-kids(n):
  if n == 0: empty
  else:
    first = read-node()        # must be forced before reading the rest
    link(first, read-kids(n - 1))
  end
end

# Read one node (and its subtree) at the current cursor.
fun read-node():
  i = cursor
  cursor := cursor + 1
  tag = parse-node-tag(i)
  nk = parse-node-nkids(i)
  s = parse-node-str(i)
  kids = read-kids(nk)
  build-node(tag, s, kids)
end

# Entry point: parse the runtime source (delivered host-side) into an ast.arr AST.
fun from-tree():
  cursor := 0
  _ = parse-num-nodes()        # triggers the host-side parse; root drives the walk
  read-node()
end
