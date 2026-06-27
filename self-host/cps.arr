#lang pyret
# PORT of src/compiler/cps.ts — the Pyret->Pyret CPS cps-transform for STOPPABLE codegen.
# Written in Pyret so the self-hosted compiler can produce stoppable code itself.
#
# SKETCH STATUS: faithful 1:1 port of cps.ts. Not yet run end-to-end (no parser
# binding here yet — `cps-transform` takes an already-parsed CstNode). Mirrors cps.ts
# function-for-function so a side-by-side diff is legible. TODO(port) marks the few
# spots that need wiring (gensym state, CstNode provider).
#
# A continuation is either a Pyret identifier naming a continuation function (so it
# can be passed along a tail call WITHOUT allocating a closure — constant-space tail
# recursion), or a meta-level function building the continuation body around a value.

provide *
# TODO(port): import the shared CstNode type; here we model it locally to match parse-core.ts.
data CstNode: cst(name :: String, value :: Option<String>, kids :: List<CstNode>) end
data Cont:
  | k-var(name :: String)
  | k-fn(apply :: (String -> String))
end

# ---- cps-transform state (mirrors the Cps class fields) ----
var g :: Number = 0
var ctors :: List<String> = empty           # data constructor names (primitive calls)
var fun-defs :: List<String> = empty         # names defined by `fun` (shadow ctors)

fun gensym(p :: String) -> String:
  s = p + "cps" + num-to-string(g)
  g := g + 1
  s
end

# OP token -> source operator (mirrors OP_SRC)
fun op-src(tok :: String) -> Option<String>:
  ask:
    | tok == "PLUS" then: some("+")   | tok == "DASH" then: some("-")
    | tok == "TIMES" then: some("*")  | tok == "SLASH" then: some("/")
    | tok == "LT" then: some("<")     | tok == "GT" then: some(">")
    | tok == "LEQ" then: some("<=")   | tok == "GEQ" then: some(">=")
    | tok == "EQUALEQUAL" then: some("==") | tok == "NEQ" then: some("<>")
    | tok == "AND" then: some("and")  | tok == "OR" then: some("or")
    | tok == "SPACESHIP" then: some("<=>")
    | otherwise: none
  end
end

# Compiler intrinsics: called DIRECTLY (no continuation), result feeds k.
# MUST match compileIntrinsic in compile.arr / compile.ts.
intrinsics :: List<String> = [list:
  "raise", "tostring", "to-string", "torepr", "to-repr",
  "string-length", "string-equal", "string-to-code-point", "string-to-code-points",
  "string-from-code-point",
  "num-modulo", "num-quotient", "num-ceiling", "num-floor", "num-round",
  "num-sqrt", "num-exact", "num-expt", "num-to-roughnum", "num-to-scientific",
  "num-is-fixnum", "num-is-integer", "num-is-rational", "num-is-roughnum",
  "is-boolean", "is-nothing", "is-tuple",
  "equal-always", "equal-now", "identical",
  "raw-array-get", "raw-array-length", "raw-array-set", "raw-array-of",
  "prim-raw-array-get", "prim-raw-array-length", "prim-raw-array-set", "prim-raw-array-of",
  "parse-num-nodes", "parse-node-tag", "parse-node-nkids", "parse-node-str",
  "read-source", "time-now", "emit-byte",
  "print", "display", "print-error" ]

# ---- CstNode helpers (mirror only/child) ----
# NB: the shared prelude's `find` returns the bare element (or `false`), NOT an
# Option like standard Pyret. cps.ts/cps.arr were written against an Option-returning
# find, so we provide local Option/raise variants here and route every find through them.
fun find-opt<a>(f :: (a -> Boolean), l :: List<a>) -> Option<a>:
  cases(List) l:
    | empty => none
    | link(fst, r) => if f(fst): some(fst) else: find-opt(f, r) end
  end
end
fun find-bang<a>(f :: (a -> Boolean), l :: List<a>) -> a:
  cases(Option) find-opt(f, l): | some(x) => x | none => raise("find-bang: not found") end
end

fun only(n :: CstNode) -> CstNode:
  cases(List) n.kids: | link(f, r) => f | empty => raise("expected single child of " + n.name) end
end
fun child(n :: CstNode, nm :: String) -> Option<CstNode>:
  find-opt(lam(k): k.name == nm end, n.kids)
end
fun child-bang(n :: CstNode, nm :: String) -> CstNode:
  cases(Option) child(n, nm): | some(c) => c | none => raise("missing child " + nm) end
end

fun binding-name(binding :: CstNode) -> String:
  fun loop(n :: CstNode):
    if (n.name == "toplevel-binding") or (n.name == "binding") or (n.name == "name-binding"):
      cases(Option) child(n, "NAME"):
        | some(nm) => nm.value.or-else("_")
        | none => loop(n.kids.first)
      end
    else: raise("could not extract binding name")
    end
  end
  loop(binding)
end

fun header-params(fn-like :: CstNode) -> List<String>:
  cases(Option) child(fn-like, "fun-header"):
    | none => empty
    | some(header) =>
      cases(Option) child(header, "args"):
        | none => empty
        | some(args) => map(binding-name, filter(lam(k): k.name == "binding" end, args.kids))
      end
  end
end

fun op-of(op-node :: CstNode) -> String:
  tok = if op-node.kids.length() == 1: op-node.kids.first else: op-node end
  cases(Option) op-src(tok.name):
    | some(s) => s
    | none => cases(Option) tok.value: | some(v) => v | none => raise("unsupported operator token: " + tok.name) end
  end
end

# Unwrap an expression to a bare identifier name, if it is one. (mirror simpleName)
fun simple-name(node :: CstNode) -> Option<String>:
  fun loop(cur :: CstNode):
    if cur.name == "id-expr": some(only(cur).value.or-else("_"))
    else if (cur.kids.length() == 1) and
        ((cur.name == "binop-expr") or (cur.name == "expr") or (cur.name == "prim-expr")):
      loop(cur.kids.first)
    else: none
    end
  end
  loop(node)
end

# data Dot result for asDot
data DotR: no-dot | a-dot(obj-node :: CstNode, name :: String) end
fun as-dot(node :: CstNode) -> DotR:
  fun loop(cur :: CstNode):
    if (cur.kids.length() == 1) and
        ((cur.name == "expr") or (cur.name == "binop-expr") or (cur.name == "prim-expr")):
      loop(cur.kids.first)
    else if cur.name == "dot-expr":
      a-dot(cur.kids.first, child-bang(cur, "NAME").value.or-else("_"))
    else: no-dot
    end
  end
  loop(node)
end

fun is-prim(name :: String) -> Boolean:
  # A program-defined `fun` shadows a same-named data constructor (image lib names).
  if fun-defs.member(name): false
  else:
    # NB: the `and` group MUST be parenthesized — the seed parses mixed and/or
    # left-associatively (no precedence), so without these parens the trailing
    # `and ctors.member(...)` would poison the whole disjunction (every ctor would
    # be misclassified as non-prim). cps.ts got this free from JS `&&` precedence.
    intrinsics.member(name) or ctors.member(name) or
      ((string-substring(name, 0, 3) == "is-") and ctors.member(string-substring(name, 3, string-length(name))))
  end
end

fun collect-fun-defs(node :: CstNode) -> Nothing block:
  when node.name == "fun-expr":
    cases(Option) child(node, "NAME"): | some(nm) => fun-defs := link(nm.value.or-else(""), fun-defs) | none => nothing end
  end
  each(collect-fun-defs, node.kids)
end

fun collect-data(node :: CstNode) -> Nothing block:
  when node.name == "data-expr":
    for each(v from node.kids):
      when (v.name == "data-variant") or (v.name == "first-data-variant"):
        cases(Option) child(v, "variant-constructor"):
          | some(ctor) => cases(Option) child(ctor, "NAME"): | some(nm) => ctors := link(nm.value.or-else(""), ctors) | none => nothing end
          | none => cases(Option) child(v, "NAME"): | some(nm) => ctors := link(nm.value.or-else(""), ctors) | none => nothing end
        end
      end
    end
  end
  each(collect-data, node.kids)
end

# ---- continuation helpers ----
fun applyk(k :: Cont, v :: String) -> String:
  cases(Cont) k: | k-var(nm) => nm + "(" + v + ")" | k-fn(ap) => ap(v) end
end
fun reifyk(k :: Cont) -> String:
  cases(Cont) k:
    | k-var(nm) => nm
    | k-fn(ap) => x = gensym("v")  "lam(" + x + "): " + ap(x) + " end"
  end
end

# ---- the core cps-transform: emit source that computes `node` and feeds it to k ----
fun t(node :: CstNode, k :: Cont) -> String:
  ask:
    | (node.name == "expr") or (node.name == "prim-expr") then: t(only(node), k)
    | node.name == "check-test" then:
      if node.kids.length() == 1: t(node.kids.first, k) else: raise("check-test not supported in CPS") end
    | node.name == "binop-expr" then:
      if node.kids.length() == 1: t(node.kids.first, k) else: t-binop(node, k) end
    | node.name == "paren-expr" then: t(child-bang(node, "binop-expr"), k)
    | (node.name == "num-expr") or (node.name == "frac-expr") or (node.name == "rfrac-expr") then:
      applyk(k, only(node).value.or-else("0"))
    | node.name == "string-expr" then: applyk(k, only(node).value.or-else(""))
    | node.name == "bool-expr" then: applyk(k, if only(node).name == "TRUE": "true" else: "false" end)
    | node.name == "id-expr" then: applyk(k, only(node).value.or-else("_"))
    | node.name == "app-expr" then: t-app(node, k)
    | node.name == "if-expr" then: t-if(node, k)
    | node.name == "cases-expr" then: t-cases(node, k)
    | node.name == "for-expr" then: t-for(node, k)
    | node.name == "when-expr" then: t-when(node, k)
    | node.name == "if-pipe-expr" then: t-ask(node, k)
    | node.name == "construct-expr" then: t-construct(node, k)
    | node.name == "tuple-expr" then: t-tuple(node, k)
    | node.name == "tuple-get" then:
      idx = child-bang(node, "NUMBER").value.or-else("0")
      t(find-bang(lam(x): x.name == "expr" end, node.kids),
        k-fn(lam(v): applyk(k, "(" + v + ").{" + idx + "}") end))
    | node.name == "obj-expr" then: t-obj(node, k)
    | node.name == "dot-expr" then:
      t(node.kids.first, k-fn(lam(vo): applyk(k, vo + "." + child-bang(node, "NAME").value.or-else("_")) end))
    | node.name == "lambda-expr" then: applyk(k, cps-lambda(node))
    | node.name == "user-block-expr" then: t-block(child-bang(node, "block"), k)
    | otherwise: raise("unsupported expression in CPS: " + node.name)
  end
end

# CPS-evaluate a list of nodes left-to-right, collecting value-sources, then k.
fun t-seq(nodes :: List<CstNode>, acc :: List<String>, k :: (List<String> -> String)) -> String:
  cases(List) nodes:
    | empty => k(acc)
    | link(n, rest) => t(n, k-fn(lam(v): t-seq(rest, acc + [list: v], k) end))
  end
end

fun t-binop(node :: CstNode, k :: Cont) -> String:
  # split kids into operands (even idx) and ops (odd idx) — mirror tBinop
  fun split(kids, i, operands, ops):
    cases(List) kids:
      | empty => {operands; ops}
      | link(x, rest) =>
        if num-modulo(i, 2) == 0: split(rest, i + 1, operands + [list: x], ops)
        else: split(rest, i + 1, operands, ops + [list: op-of(x)]) end
    end
  end
  parts = split(node.kids, 0, empty, empty)
  t-seq(parts.{0}, empty, lam(vs):
      cps-fold-binop(vs.first, vs.rest, parts.{1}, k)
    end)
end

# Overloadable operators map to a `cps-op-*` seed intrinsic that dispatches the
# operator method (`_plus`/...) WITH a continuation (numeric/string fast-path tail-
# calls the continuation directly). Non-overloadable ops (and/or/==/<>/<=>) have no
# data-method overload so they stay a bounded sub-expression.
fun op-cps-helper(op :: String) -> Option<String>:
  ask:
    | op == "+" then: some("cps-op-plus")
    | op == "-" then: some("cps-op-minus")
    | op == "*" then: some("cps-op-times")
    | op == "/" then: some("cps-op-divide")
    | op == "<" then: some("cps-op-lessthan")
    | op == ">" then: some("cps-op-greaterthan")
    | op == "<=" then: some("cps-op-lessequal")
    | op == ">=" then: some("cps-op-greaterequal")
    | otherwise: none
  end
end

# Combine the already-evaluated operand value-sources left-to-right (the seed parses
# mixed operators left-associatively, no precedence). Each overloadable step is a
# tail call to its `cps-op-*` helper threading the continuation; bounded ops fold
# into a plain sub-expression.
fun cps-fold-binop(acc :: String, rest :: List<String>, ops :: List<String>, k :: Cont) -> String:
  cases(List) rest:
    | empty => applyk(k, acc)
    | link(v, vrest) =>
      op = ops.first
      orest = ops.rest
      cases(Option) op-cps-helper(op):
        | some(helper) =>
          inner = k-fn(lam(r): cps-fold-binop(r, vrest, orest, k) end)
          helper + "(" + acc + ", " + v + ", " + reifyk(inner) + ")"
        | none =>
          cps-fold-binop("(" + acc + " " + op + " " + v + ")", vrest, orest, k)
      end
  end
end

fun app-arg-nodes(node :: CstNode) -> List<CstNode>:
  cases(Option) child(node, "app-args"):
    | none => empty
    | some(args) =>
      cases(Option) child(args, "opt-comma-binops"):
        | none => empty
        | some(optcb) => cases(Option) child(optcb, "comma-binops"):
            | none => empty
            | some(cb) => filter(lam(k): k.name == "binop-expr" end, cb.kids) end
      end
  end
end

fun t-app(node :: CstNode, k :: Cont) -> String:
  fn-node = node.kids.first
  arg-nodes = app-arg-nodes(node)
  cases(DotR) as-dot(fn-node):
    | a-dot(obj-node, dname) =>   # method/field call: obj.m(args) with continuation
      t(obj-node, k-fn(lam(vo):
          t-seq(arg-nodes, empty, lam(vs):
              vo + "." + dname + "(" + join-args(vs + [list: reifyk(k)]) + ")" end) end))
    | no-dot =>
      cases(Option) simple-name(fn-node):
        | some(fname) =>
          if is-prim(fname):
            t-seq(arg-nodes, empty, lam(vs): applyk(k, fname + "(" + join-args(vs) + ")") end)
          else: t-general-app(fn-node, arg-nodes, k)
          end
        | none => t-general-app(fn-node, arg-nodes, k)
      end
  end
end
fun t-general-app(fn-node, arg-nodes, k) -> String:
  # general CPS call: pass an extra trailing continuation arg (tail call -> return_call)
  t-seq(link(fn-node, arg-nodes), empty, lam(vs):
      vs.first + "(" + join-args(vs.rest + [list: reifyk(k)]) + ")" end)
end
fun join-args(vs :: List<String>) -> String: string-join(vs, ", ") end

fun t-construct(node :: CstNode, k :: Cont) -> String:
  ctor-node = child-bang(node, "binop-expr")
  ctor-name = cases(Option) simple-name(ctor-node): | some(n) => n | none => "list" end
  elems = cases(Option) child(node, "trailing-opt-comma-binops"):
    | none => empty
    | some(tr) => cases(Option) child(tr, "comma-binops"):
        | none => empty | some(cb) => filter(lam(x): x.name == "binop-expr" end, cb.kids) end
  end
  t-seq(elems, empty, lam(vs): applyk(k, "[" + ctor-name + ": " + join-args(vs) + "]") end)
end

# {a; b; c}  — CPS-eval the fields left-to-right, then build the tuple literal.
fun t-tuple(node :: CstNode, k :: Cont) -> String:
  fields = cases(Option) child(node, "tuple-fields"):
    | none => empty
    | some(tf) => filter(lam(x): x.name == "binop-expr" end, tf.kids)
  end
  t-seq(fields, empty, lam(vs): applyk(k, "{" + string-join(vs, "; ") + "}") end)
end

# object literal {k: v, ..., method m(self,...): ... end}: CPS-eval value fields
# left-to-right; method bodies are CPS-transformed and take a trailing continuation.
fun obj-field-is-method(f :: CstNode) -> Boolean: is-some(child(f, "METHOD")) end
fun cps-obj-method(f :: CstNode) -> String:
  nm = child-bang(child-bang(f, "key"), "NAME").value.or-else("_")
  params = header-params(f)
  kg = gensym("k")
  body = t-block(child-bang(f, "block"), k-var(kg))
  "method " + nm + "(" + join-args(params + [list: kg]) + "): yield-check(lam(): " + body + " end) end"
end
fun t-obj(node :: CstNode, k :: Cont) -> String:
  fields = cases(Option) child(node, "obj-fields"):
    | none => empty
    | some(ofs) => filter(lam(x): x.name == "obj-field" end, ofs.kids)
  end
  value-fields = filter(lam(f): not(obj-field-is-method(f)) end, fields)
  method-srcs = map(cps-obj-method, filter(obj-field-is-method, fields))
  keys = map(lam(f): child-bang(child-bang(f, "key"), "NAME").value.or-else("_") end, value-fields)
  vals = map(lam(f): find-bang(lam(x): x.name == "binop-expr" end, f.kids) end, value-fields)
  t-seq(vals, empty, lam(vs):
      kv-pairs = fold_n(lam(i, acc, vv): acc + [list: keys.get(i) + ": " + vv] end, 0, empty, vs)
      applyk(k, "{" + string-join(kv-pairs + method-srcs, ", ") + "}") end)
end

fun t-if(node :: CstNode, k :: Cont) -> String:
  kids = node.kids
  cond = find-bang(lam(x): x.name == "binop-expr" end, kids)
  blocks = filter(lam(x): x.name == "block" end, kids)
  elseifs = filter(lam(x): x.name == "else-if" end, kids)
  has-else = is-some(find-opt(lam(x): x.name == "ELSECOLON" end, kids))
  when not(has-else): raise("if without else not supported in CPS") end
  fun if-expr(vc :: String, kf :: Cont) -> String:
    base = "if " + vc + ": " + t-block(blocks.first, kf)
    mid = for fold(acc from base, ei from elseifs):
      ec = find-bang(lam(x): x.name == "binop-expr" end, ei.kids)
      eb = find-bang(lam(x): x.name == "block" end, ei.kids)
      acc + " else if " + render-pure(ec) + ": " + t-block(eb, kf)
    end
    mid + " else: " + t-block(blocks.get(blocks.length() - 1), kf) + " end"
  end
  cases(Cont) k:
    | k-var(_) => t(cond, k-fn(lam(vc): if-expr(vc, k) end))
    | k-fn(_) =>
      kf = gensym("k")
      inner = t(cond, k-fn(lam(vc): if-expr(vc, k-var(kf)) end))
      "block: " + kf + " = " + reifyk(k) + " " + inner + " end"
  end
end

fun render-ann(ann-node :: Option<CstNode>) -> String:
  cases(Option) ann-node:
    | none => "Any"
    | some(a) =>
      fun find-name(n :: CstNode) -> Option<String>:
        if n.name == "NAME": n.value
        else:
          for fold(acc from none, k from n.kids):
            cases(Option) acc: | some(_) => acc | none => find-name(k) end
          end
        end
      end
      cases(Option) find-name(a): | some(s) => s | none => "Any" end
  end
end

fun t-cases(node :: CstNode, k :: Cont) -> String:
  ty = render-ann(child(node, "ann"))
  scrut = find-bang(lam(x): x.name == "binop-expr" end, node.kids)
  branches = filter(lam(x): x.name == "cases-branch" end, node.kids)
  # else block (after the ELSE token) — TODO(port): index-based slice as in tCases
  else-block = find-else-block(node)
  fun emit(vscrut :: String, kf :: Cont) -> String:
    base = "cases(" + ty + ") " + vscrut + ":"
    body = for fold(acc from base, br from branches):
      vname = child-bang(br, "NAME").value.or-else("_")
      binds = cases(Option) child(br, "cases-args"):
        | none => empty
        | some(an) => map(lam(cb): binding-name(cases(Option) child(cb, "binding"): | some(b) => b | none => cb end) end,
                          filter(lam(x): x.name == "cases-binding" end, an.kids))
      end
      hd = if is-empty(binds): vname else: vname + "(" + join-args(binds) + ")" end
      acc + " | " + hd + " => " + t-block(child-bang(br, "block"), kf)
    end
    full = cases(Option) else-block: | some(eb) => body + " | else => " + t-block(eb, kf) | none => body end
    full + " end"
  end
  cases(Cont) k:
    | k-var(_) => t(scrut, k-fn(lam(vc): emit(vc, k) end))
    | k-fn(_) =>
      kf = gensym("k")
      inner = t(scrut, k-fn(lam(vc): emit(vc, k-var(kf)) end))
      "block: " + kf + " = " + reifyk(k) + " " + inner + " end"
  end
end
# Faithful else-block extraction: cases-expr ends with `[BAR ELSE THICKARROW block]`,
# so the else block is the first direct `block` kid appearing AFTER the `ELSE` token
# (the per-branch blocks live inside `cases-branch`, not as direct kids).
fun find-else-block(node :: CstNode) -> Option<CstNode>:
  fun loop(kids :: List<CstNode>, seen-else :: Boolean) -> Option<CstNode>:
    cases(List) kids:
      | empty => none
      | link(x, rest) =>
        new-seen = seen-else or (x.name == "ELSE")
        if new-seen and (x.name == "block"): some(x)
        else: loop(rest, new-seen)
        end
    end
  end
  loop(node.kids, false)
end

# for ITER(p from e, ...): body end  ==>  ITER(lam(p,...,KG): yield-check(...) end, e..., reify k)
fun t-for(node :: CstNode, k :: Cont) -> String:
  iter-expr = find-bang(lam(x): x.name == "expr" end, node.kids)
  binds = filter(lam(x): x.name == "for-bind" end, node.kids)
  params = map(lam(b): binding-name(child-bang(b, "binding")) end, binds)
  from-exprs = map(lam(b): find-bang(lam(x): x.name == "binop-expr" end, b.kids) end, binds)
  body = child-bang(node, "block")
  kg = gensym("k")
  lam-body = t-block(body, k-var(kg))
  lam-src = "lam(" + join-args(params + [list: kg]) + "): yield-check(lam(): " + lam-body + " end) end"
  t(iter-expr, k-fn(lam(v-iter):
      t-seq(from-exprs, empty, lam(vs):
          v-iter + "(" + join-args(link(lam-src, vs) + [list: reifyk(k)]) + ")" end) end))
end

# when COND: BODY end  ==>  if COND: <BODY, value discarded> ; nothing  else: nothing end
# `when` always yields nothing; the body runs for effect and stays interruptible
# (its calls are CPS-threaded). k is bound once so it isn't duplicated across branches.
fun t-when(node :: CstNode, k :: Cont) -> String:
  cond = find-bang(lam(x): x.name == "binop-expr" end, node.kids)
  body = child-bang(node, "block")
  fun emit(vc :: String, kf :: Cont) -> String:
    "if " + vc + ": " + t-block(body, k-fn(lam(_): applyk(kf, "nothing") end))
      + " else: " + applyk(kf, "nothing") + " end"
  end
  cases(Cont) k:
    | k-var(_) => t(cond, k-fn(lam(vc): emit(vc, k) end))
    | k-fn(_) =>
      kf = gensym("k")
      inner = t(cond, k-fn(lam(vc): emit(vc, k-var(kf)) end))
      "block: " + kf + " = " + reifyk(k) + " " + inner + " end"
  end
end

# ask: | t1 then: b1 | t2 then: b2 [ | otherwise: bo ] end  ==>  nested if/else.
# Unlike if's else-if conditions (assumed pure), ask BRANCH TESTS sit in value
# position and may contain calls, so each test is CPS-evaluated; the rest of the
# chain becomes its else-branch. k is bound once and shared across all branch bodies.
fun t-ask(node :: CstNode, k :: Cont) -> String:
  branches = filter(lam(x): x.name == "if-pipe-branch" end, node.kids)
  otherwise-blk = child(node, "block")   # the optional `| otherwise:` block (direct kid)
  fun build(brs :: List<CstNode>, kf :: Cont) -> String:
    cases(List) brs:
      | empty =>
        cases(Option) otherwise-blk:
          | some(ob) => t-block(ob, kf)
          | none => "raise(\"ask: no branch matched\")"
        end
      | link(br, rest) =>
        test = find-bang(lam(x): x.name == "binop-expr" end, br.kids)
        body = find-bang(lam(x): x.name == "block" end, br.kids)
        t(test, k-fn(lam(vt):
            "if " + vt + ": " + t-block(body, kf) + " else: " + build(rest, kf) + " end" end))
    end
  end
  cases(Cont) k:
    | k-var(_) => build(branches, k)
    | k-fn(_) =>
      kf = gensym("k")
      "block: " + kf + " = " + reifyk(k) + " " + build(branches, k-var(kf)) + " end"
  end
end

# render a call-free expression to source (else-if conditions) — mirror renderPure
fun render-pure(node :: CstNode) -> String:
  ask:
    | (node.name == "expr") or (node.name == "prim-expr") then: render-pure(only(node))
    | node.name == "binop-expr" then:
      if node.kids.length() == 1: render-pure(node.kids.first)
      else:
        fun loop(i, acc):
          if (i + 1) < node.kids.length():
            loop(i + 2, "(" + acc + " " + op-of(node.kids.get(i)) + " " + render-pure(node.kids.get(i + 1)) + ")")
          else: acc end
        end
        loop(1, render-pure(node.kids.first))
      end
    | node.name == "paren-expr" then: "(" + render-pure(child-bang(node, "binop-expr")) + ")"
    | node.name == "dot-expr" then: render-pure(node.kids.first) + "." + child-bang(node, "NAME").value.or-else("_")
    | (node.name == "num-expr") or (node.name == "frac-expr") or (node.name == "rfrac-expr") or (node.name == "string-expr") then:
      only(node).value.or-else("0")
    | node.name == "bool-expr" then: if only(node).name == "TRUE": "true" else: "false" end
    | node.name == "id-expr" then: only(node).value.or-else("_")
    | otherwise: raise("call in pure position not supported in CPS: " + node.name)
  end
end

fun t-block(block :: CstNode, k :: Cont) -> String:
  stmts = map(only, filter(lam(x): x.name == "stmt" end, block.kids))
  t-stmts(stmts, 0, k)
end

fun t-stmts(stmts :: List<CstNode>, i :: Number, k :: Cont) -> String:
  if is-empty(stmts): applyk(k, "nothing")
  else:
    last = i == (stmts.length() - 1)
    s = stmts.get(i)
    ask:
      | (s.name == "let-expr") or (s.name == "var-expr") or (s.name == "rec-expr") then:
        bnode = cases(Option) child(s, "toplevel-binding"):
          | some(b) => b
          | none => cases(Option) child(s, "binding"): | some(b) => b | none => s.kids.first end
        end
        name = binding-name(bnode)
        val-node = s.kids.get(s.kids.length() - 1)
        t(val-node, k-fn(lam(v): "block: " + name + " = " + v + " " + t-stmts(stmts, i + 1, k) + " end" end))
      | s.name == "fun-expr" then: "block: " + cps-fun-def(s) + " " + t-stmts(stmts, i + 1, k) + " end"
      | s.name == "data-expr" then: "block: " + render-data(s) + " " + t-stmts(stmts, i + 1, k) + " end"
      | s.name == "check-expr" then:
        cont = if last: k else: k-fn(lam(_v): t-stmts(stmts, i + 1, k) end) end
        t-check-block(s, cont)
      | last then: t(s, k)
      | otherwise: t(s, k-fn(lam(_v): t-stmts(stmts, i + 1, k) end))
    end
  end
end

# ---- check: blocks ----
# A `check:`/`check "name":`/`examples:` block. We CPS-evaluate each test's operands
# (so calls inside them stay interruptible), bind them to value-vars, then emit a check
# block comparing those VALUES — so the seed's check harness records pass/fail + renders
# messages exactly as for the direct compiler. Only EQUALITY-comparison ops are supported:
# the harness compares the two pre-computed values with built-in equality (no user
# predicate/thunk call). satisfies/violates/is%/raises* call a user fn/thunk that, after
# CPS, takes a continuation the harness can't supply — so those raise a clear error.
fun check-op-supported(op-name :: String) -> Boolean:
  # is / is-not / is== / is=~ / is<=> / is-not== / ... / is-roughly / is-not-roughly
  (string-substring(op-name, 0, 2) == "is") and
    not(string-contains(op-name, "%"))
end

fun t-check-block(node :: CstNode, kont :: Cont) -> String:
  name-part = cases(Option) child(node, "STRING"):
    | some(s) => " " + s.value.or-else("\"\"")
    | none => ""
  end
  inner = child-bang(node, "block")
  tests = map(only, filter(lam(x): x.name == "stmt" end, inner.kids))
  fun do-tests(ts :: List<CstNode>, acc :: List<String>) -> String:
    cases(List) ts:
      | empty =>
        "block: check" + name-part + ": " + string-join(acc, " ") + " end "
          + applyk(kont, "nothing") + " end"
      | link(ct, rest) =>
        cps-check-test(ct, lam(line): do-tests(rest, acc + [list: line]) end)
    end
  end
  do-tests(tests, empty)
end

# CPS-eval a check-test's operands, then call `kont` with the rendered "lval OP rval" line.
fun cps-check-test(ct :: CstNode, kont :: (String -> String)) -> String:
  binops = filter(lam(x): x.name == "binop-expr" end, ct.kids)
  if ct.kids.length() == 1:
    t(ct.kids.first, k-fn(lam(v): kont(v) end))
  else if binops.length() < 2:
    t(binops.first, k-fn(lam(v): kont(v) end))
  else:
    cop = child-bang(ct, "check-op")
    op-name = cop.kids.first.value.or-else("is")
    when not(check-op-supported(op-name)) or is-some(child(ct, "PERCENT")):
      raise("check-op not yet supported in CPS: " + op-name
        + (if is-some(child(ct, "PERCENT")): "%(refinement)" else: "" end))
    end
    lhs = binops.first
    rhs = binops.get(binops.length() - 1)
    t(lhs, k-fn(lam(lv):
        t(rhs, k-fn(lam(rv):
            kont(lv + " " + op-name + " " + rv)
          end))
      end))
  end
end

fun cps-fun-def(fn-expr :: CstNode) -> String:
  name = child-bang(fn-expr, "NAME").value.or-else("_")
  params = header-params(fn-expr)
  kg = gensym("k")
  body = t-block(child-bang(fn-expr, "block"), k-var(kg))
  "fun " + name + "(" + join-args(params + [list: kg]) + "): yield-check(lam(): " + body + " end) end"
end

fun cps-lambda(node :: CstNode) -> String:
  params = header-params(node)
  kg = gensym("k")
  body = t-block(child-bang(node, "block"), k-var(kg))
  "lam(" + join-args(params + [list: kg]) + "): yield-check(lam(): " + body + " end) end"
end

# A method `field` (in a `with:`/`sharing:` block) shares the obj-field CST shape, so
# `cps-obj-method` transforms it (CPS body + trailing continuation param), which is what
# a method CALL SITE `obj.m(args)` expects (t-app's a-dot case appends reifyk(k)).
# OPERATOR methods (`_plus`/`_lessthan`/...) are ALSO CPS-transformed now: the call site
# `a + b` is routed through the `cps-op-*` seed intrinsic (see t-binop/op-cps-helper),
# which dispatches the operator method WITH the continuation — so list/data `+` works and
# is interruptible in stoppable mode (numeric/string `+` stays a direct fast-path).
fun field-method-name(f :: CstNode) -> String:
  child-bang(child-bang(f, "key"), "NAME").value.or-else("_")
end
fun is-operator-method(f :: CstNode) -> Boolean:
  string-substring(field-method-name(f), 0, 1) == "_"
end
# CPS-transform the NAMED method fields of a `data-with` / `data-sharing` block.
fun data-block-methods(blk :: Option<CstNode>) -> List<String>:
  cases(Option) blk:
    | none => empty
    | some(b) =>
      cases(Option) child(b, "fields"):
        | none => empty
        | some(fs) =>
          methods = filter(lam(x): (x.name == "field") and is-some(child(x, "METHOD")) end, fs.kids)
          # ALL methods are CPS-transformed (take a trailing continuation) — including
          # OPERATOR methods (`_plus`/`_lessthan`/...). The call site `a + b` is routed
          # (see t-binop) through the `cps-op-*` seed intrinsic, which dispatches the
          # operator method WITH the continuation, so list/data `+` is interruptible.
          map(cps-obj-method, methods)
      end
  end
end

fun render-data(node :: CstNode) -> String:
  ty-name = child-bang(node, "NAME").value.or-else("_")
  variants = filter(lam(k): (k.name == "data-variant") or (k.name == "first-data-variant") end, node.kids)
  parts = map(lam(v):
      ctor-part = cases(Option) child(v, "variant-constructor"):
        | some(ctor) =>
          nm = child-bang(ctor, "NAME").value.or-else("_")
          fields = cases(Option) child(ctor, "variant-members"):
            | none => empty
            | some(m) => map(lam(vm): binding-name(child-bang(vm, "binding")) end,
                             filter(lam(k): k.name == "variant-member" end, m.kids))
          end
          nm + "(" + join-args(fields) + ")"
        | none => child-bang(v, "NAME").value.or-else("_")
      end
      # per-variant `with:` methods (CPS-transformed, named only)
      with-methods = data-block-methods(child(v, "data-with"))
      if is-empty(with-methods): ctor-part
      else: ctor-part + " with: " + string-join(with-methods, ", ")
      end
    end, variants)
  # shared `sharing:` methods (CPS-transformed, named only)
  sharing-methods = data-block-methods(child(node, "data-sharing"))
  variant-src = string-join(map(lam(p): "| " + p end, parts), " ")
  sharing-src = if is-empty(sharing-methods): "" else: " sharing: " + string-join(sharing-methods, ", ") end
  "data " + ty-name + ": " + variant-src + sharing-src + " end"
end

# ---- top level ----
fun cps-transform(program :: CstNode) -> String block:
  g := 0
  ctors := empty
  fun-defs := empty
  collect-data(program)
  collect-fun-defs(program)
  block = child-bang(program, "block")
  stmts = map(only, filter(lam(x): x.name == "stmt" end, block.kids))
  decls = for fold(acc from empty, s from stmts):
    ask: | s.name == "data-expr" then: acc + [list: render-data(s)]
         | s.name == "fun-expr" then: acc + [list: cps-fun-def(s)]
         | otherwise: acc end
  end
  rest = filter(lam(s): not((s.name == "data-expr") or (s.name == "fun-expr")) end, stmts)
  driver = if is-empty(rest): "finish-result(nothing)"
    else: t-stmts(rest, 0, k-fn(lam(v): "finish-result(" + v + ")" end)) end
  string-join(decls, "\n") + (if is-empty(decls): "" else: "\n" end) + driver + "\n"
end
