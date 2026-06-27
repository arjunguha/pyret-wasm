provide *
# Skeleton deserializer: a serialized (host-produced) parse tree -> ast.arr AST.
# This is the Pyret side of Option B in parser-plan.md. SKETCH: the host import that
# produces the serial stream and the full 225-constructor table are TODO(port); this
# shows the tag-dispatch + recursive child-building shape for the core forms.
import ast as A

# One node of the serialized tree the host hands us: a tag, child nodes, and leaf
# payloads (string + number). A real stream would be flat u32s + a string table
# (see parser-plan.md); this nested form is the in-Pyret shape after reading it.
data SNode:
  | snode(tag :: String, kids, str :: String, num :: Number)
end

fun mk-loc(n :: SNode):
  # TODO(port): decode the real srcloc carried in the stream; dummy for the skeleton.
  A.dummy-loc
end

# tag -> ast.arr constructor dispatch (core forms; grow to the full table).
fun from-tree(n :: SNode):
  l = mk-loc(n)
  k = n.kids
  if n.tag == "s-num": A.s-num(l, n.num)
  else if n.tag == "s-str": A.s-str(l, n.str)
  else if n.tag == "s-bool": A.s-bool(l, n.str == "true")
  else if n.tag == "s-id": A.s-id(l, A.s-name(l, n.str))
  else if n.tag == "s-op":
    A.s-op(l, l, n.str, from-tree(k.get(0)), from-tree(k.get(1)))
  else if n.tag == "s-app":
    A.s-app(l, from-tree(k.get(0)), map(from-tree, k.drop(1)))
  else if n.tag == "s-block":
    A.s-block(l, map(from-tree, k))
  else if n.tag == "s-let":
    A.s-let(l, A.s-bind(l, false, A.s-name(l, n.str), A.a-blank), from-tree(k.get(0)), false)
  else if n.tag == "s-if-else":
    A.s-if-else(l, map(from-tree, k.drop(1)), from-tree(k.get(0)))
  else if n.tag == "s-program":
    # minimal program shell; real provides/imports decode TODO(port)
    A.s-program(l, none, A.s-provide-none(l), A.s-provide-types-none(l), empty, empty,
      from-tree(k.get(k.length() - 1)))
  else:
    raise("from-tree: unhandled tag " + n.tag)
  end
end

# Entry the parse-pyret stub should call: surface-parse(src, uri) =
#   from-tree(read-parse-tree(src, uri))  where read-parse-tree is the host import
#   (TODO) that runs the JS tokenizer+GLR parser + retargeted parse-pyret builder.
fun from-serialized(root :: SNode):
  from-tree(root)
end
