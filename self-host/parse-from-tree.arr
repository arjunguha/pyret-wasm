provide *
# Pyret side of the self-hosted parser (Option B in parser-plan.md). The seed's
# JS GLR parser produces a CST; the host (src/runtime/parse-bridge.ts) lowers it
# to a FLAT pre-order array of tagged nodes and exposes it via four intrinsics:
#   parse-num-nodes()    -> node count (also triggers the host-side parse)
#   parse-node-tag(i)    -> tag code (must match parse-bridge.ts TAGS)
#   parse-node-nkids(i)  -> child count (children follow immediately, pre-order)
#   parse-node-str(i)    -> the node's string payload
# We walk the array with a shared cursor and build real ast.arr AST values. Core
# forms plus app/dot/if/let/var/fun/lam/construct/check-test/data/cases/when/
# for/tuple/obj, `ask:` (if-pipe), fraction literals, arrow/app/dot/tuple
# annotations, data with:/sharing: methods + ref members, import file("…"), and
# provide */provide {…}/import/include are handled here; growing the table is
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
ANAME = 19
ABLANK = 20
DATA = 21
VARIANT = 22
SINGLEVARIANT = 23
VARIANTS = 24
VMEMBERS = 25
CASES = 26
CASESELSE = 27
CBRANCH = 28
CBINDS = 29
BRANCHES = 30
TUPLE = 31
WHEN = 32
FOR = 33
FORBIND = 34
FORBINDS = 35
IFBRANCH = 36
IFBRANCHES = 37
IMPORT = 38
INCLUDE = 39
IMPORTS = 40
NAMESTR = 41
FRAC = 42
IFPIPE = 43
IFPIPEELSE = 44
PIPEBRANCH = 45
PIPEBRANCHES = 46
AARROW = 47
AAPP = 48
ADOT = 49
ATUPLE = 50
ANNS = 51
IMPORTFILE = 52
VMEMBER = 53
METHODFIELD = 54
MEMBERS = 55
DATAFIELD = 56
OBJ = 57

# Shared read cursor into the flat pre-order stream.
var cursor = 0

# A bare s-name binding with no annotation.
fun mk-bind(l, s):
  A.s-bind(l, false, A.s-name(l, s), A.a-blank)
end

# Parse a "num/den" rational literal into its two integer parts.
fun frac-parts(s):
  parts = string-split(s, "/")
  { num: string-to-number(parts.get(0)).value,
    den: string-to-number(parts.get(1)).value }
end

# The check-op kind string (from parse-bridge) -> an ast.arr CheckOp value.
fun check-op(l, s):
  if s == "is": A.s-op-is(l)
  else if s == "is-not": A.s-op-is-not(l)
  else if s == "is==": A.s-op-is-op(l, "op==")
  else if s == "satisfies": A.s-op-satisfies(l)
  else if s == "satisfies-not": A.s-op-satisfies-not(l)
  else if s == "raises": A.s-op-raises(l)
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
    branches = kids.get(0)
    if kids.length() >= 2: A.s-if-else(l, branches, kids.get(1), false)
    else: A.s-if(l, branches, false)
    end
  else if tag == IFBRANCH: A.s-if-branch(l, kids.get(0), kids.get(1))
  else if tag == IFBRANCHES: kids   # a List<IfBranch>
  else if tag == CHECKTEST:
    A.s-check-test(l, check-op(l, s), none, kids.get(0), some(kids.get(1)), none)
  else if tag == ANAME: A.a-name(l, A.s-name(l, s))
  else if tag == ABLANK: A.a-blank
  else if tag == BIND:
    ann = if is-empty(kids): A.a-blank else: kids.get(0) end
    A.s-bind(l, false, A.s-name(l, s), ann)
  else if tag == BINDS: kids   # a List<Bind>
  else if tag == EXPRS: kids   # a List<Expr>
  else if tag == DATA:
    shared = if kids.length() >= 2: kids.get(1) else: empty end
    A.s-data(l, s, empty, empty, kids.get(0), shared, none, none)
  else if tag == VARIANTS: kids   # a List<Variant>
  else if tag == VARIANT:
    with-members = if kids.length() >= 2: kids.get(1) else: empty end
    A.s-variant(l, l, s, kids.get(0), with-members)
  else if tag == SINGLEVARIANT:
    with-members = if is-empty(kids): empty else: kids.get(0) end
    A.s-singleton-variant(l, s, with-members)
  else if tag == VMEMBER:
    mt = if s == "ref": A.s-mutable else: A.s-normal end
    A.s-variant-member(l, mt, kids.get(0))
  else if tag == VMEMBERS: kids   # a List<VariantMember>
  else if tag == CASES:
    A.s-cases(l, kids.get(0), kids.get(1), kids.get(2), false)
  else if tag == CASESELSE:
    A.s-cases-else(l, kids.get(0), kids.get(1), kids.get(2), kids.get(3), false)
  else if tag == BRANCHES: kids   # a List<CasesBranch>
  else if tag == CBRANCH:
    A.s-cases-branch(l, l, s, kids.get(0), kids.get(1))
  else if tag == CBINDS:
    kids.map(lam(b): A.s-cases-bind(l, A.s-cases-bind-normal, b) end)
  else if tag == TUPLE: A.s-tuple(l, kids.get(0))
  else if tag == WHEN: A.s-when(l, kids.get(0), kids.get(1), false)
  else if tag == FOR:
    A.s-for(l, kids.get(0), kids.get(1), A.a-blank, kids.get(2), false)
  else if tag == FORBIND: A.s-for-bind(l, kids.get(0), kids.get(1))
  else if tag == FORBINDS: kids   # a List<ForBind>
  else if tag == IMPORT:
    A.s-import(l, A.s-const-import(l, s), A.s-name(l, kids.get(0)))
  else if tag == INCLUDE: A.s-include(l, A.s-const-import(l, s))
  else if tag == IMPORTS: kids   # a List<Import>
  else if tag == NAMESTR: s      # a raw String (e.g. an import alias / a-dot field)
  else if tag == FRAC:
    fp = frac-parts(s)
    A.s-frac(l, fp.num, fp.den)
  else if tag == IFPIPE: A.s-if-pipe(l, kids.get(0), false)
  else if tag == IFPIPEELSE:
    A.s-if-pipe-else(l, kids.get(0), kids.get(1), false)
  else if tag == PIPEBRANCH:
    A.s-if-pipe-branch(l, kids.get(0), kids.get(1))
  else if tag == PIPEBRANCHES: kids   # a List<IfPipeBranch>
  else if tag == AARROW:
    A.a-arrow(l, kids.get(0), kids.get(1), true)
  else if tag == AAPP:
    A.a-app(l, kids.get(0), kids.get(1))
  else if tag == ADOT:
    A.a-dot(l, A.s-name(l, s), kids.get(0))
  else if tag == ATUPLE: A.a-tuple(l, kids.get(0))
  else if tag == ANNS: kids   # a List<Ann>
  else if tag == IMPORTFILE:
    A.s-import(l, A.s-special-import(l, "file", [list: s]), A.s-name(l, kids.get(0)))
  else if tag == METHODFIELD:
    A.s-method-field(l, s, empty, kids.get(0), A.a-blank, "", kids.get(1), none, none, false)
  else if tag == MEMBERS: kids   # a List<Member>
  else if tag == DATAFIELD: A.s-data-field(l, s, kids.get(0))
  else if tag == OBJ: A.s-obj(l, kids.get(0))
  else if tag == BIND: mk-bind(l, s)
  else if tag == PROGRAM:
    # `provide { ... }` (flag "block") prepends the provide expr as a leading kid,
    # so imports/block shift by one; provide-all/none keep the 2-kid layout.
    has-prov-expr = kids.length() >= 3
    prov =
      if s == "all": A.s-provide-all(l)
      else if s == "block": A.s-provide(l, kids.get(0))
      else: A.s-provide-none(l)
      end
    imports = if has-prov-expr: kids.get(1) else: kids.get(0) end
    blk = if has-prov-expr: kids.get(2) else: kids.get(1) end
    A.s-program(l, none, prov, A.s-provide-types-none(l),
      empty, imports, blk)
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
