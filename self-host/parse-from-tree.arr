provide *
# Pyret side of the self-hosted parser (Option B in parser-plan.md). The seed's
# JS GLR parser produces a CST; the host (src/runtime/parse-bridge.ts) lowers it
# to a FLAT pre-order array of tagged nodes and exposes it via four intrinsics:
#   parse-num-nodes()    -> node count (also triggers the host-side parse)
#   parse-node-tag(i)    -> tag code (must match parse-bridge.ts TAGS)
#   parse-node-nkids(i)  -> child count (children follow immediately, pre-order)
#   parse-node-str(i)    -> the node's string payload
# We walk the array with a shared cursor and build real ast.arr AST values. The
# core forms are handled here; growing the table (app/if/let/fun/data/cases/…) is
# matched by growing the lowering in parse-bridge.ts.
import ast as A

# Tag codes — keep in sync with src/runtime/parse-bridge.ts TAGS.
PROGRAM = 0
BLOCK = 1
NUM = 2
STR = 3
BOOL = 4
ID = 5
OP = 6

# Shared read cursor into the flat pre-order stream.
var cursor = 0

fun build-node(tag, s, kids):
  l = A.dummy-loc
  if tag == NUM: A.s-num(l, string-to-number(s).value)
  else if tag == STR: A.s-str(l, s)
  else if tag == BOOL: A.s-bool(l, s == "true")
  else if tag == ID: A.s-id(l, A.s-name(l, s))
  else if tag == OP: A.s-op(l, l, s, kids.get(0), kids.get(1))
  else if tag == BLOCK: A.s-block(l, kids)
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
