#lang pyret
# PORT of src/compiler/cps.ts — the Pyret->Pyret CPS transform for STOPPABLE codegen.
# Written in Pyret so the self-hosted compiler can produce stoppable code itself.
#
# SKETCH STATUS: faithful 1:1 port of cps.ts. Not yet run end-to-end (no parser
# binding here yet — `transform` takes an already-parsed CstNode). Mirrors cps.ts
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

# ---- transform state (mirrors the Cps class fields) ----
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
  "string-length", "string-to-code-points", "string-from-code-point",
  "num-modulo", "num-quotient",
  "raw-array-get", "raw-array-length", "raw-array-set", "raw-array-of",
  "emit-byte", "identical", "print", "display", "print-error" ]

# ---- CstNode helpers (mirror only/child) ----
fun only(n :: CstNode) -> CstNode:
  cases(List) n.kids: | link(f, r) => f | empty => raise("expected single child of " + n.name) end
end
fun child(n :: CstNode, nm :: String) -> Option<CstNode>:
  find(lam(k): k.name == nm end, n.kids)
end
fun child!(n :: CstNode, nm :: String) -> CstNode:
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
      a-dot(cur.kids.first, child!(cur, "NAME").value.or-else("_"))
    else: no-dot
    end
  end
  loop(node)
end

fun is-prim(name :: String) -> Boolean:
  # A program-defined `fun` shadows a same-named data constructor (image lib names).
  if fun-defs.member(name): false
  else:
    intrinsics.member(name) or ctors.member(name) or
      (string-substring(name, 0, 3) == "is-") and ctors.member(string-substring(name, 3, string-length(name)))
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

# ---- the core transform: emit source that computes `node` and feeds it to k ----
fun t(node :: CstNode, k :: Cont) -> String:
  ask:
    | (node.name == "expr") or (node.name == "prim-expr") then: t(only(node), k)
    | node.name == "check-test" then:
      if node.kids.length() == 1: t(node.kids.first, k) else: raise("check-test not supported in CPS") end
    | node.name == "binop-expr" then:
      if node.kids.length() == 1: t(node.kids.first, k) else: t-binop(node, k) end
    | node.name == "paren-expr" then: t(child!(node, "binop-expr"), k)
    | (node.name == "num-expr") or (node.name == "frac-expr") or (node.name == "rfrac-expr") then:
      applyk(k, only(node).value.or-else("0"))
    | node.name == "string-expr" then: applyk(k, only(node).value.or-else(""))
    | node.name == "bool-expr" then: applyk(k, if only(node).name == "TRUE": "true" else: "false" end)
    | node.name == "id-expr" then: applyk(k, only(node).value.or-else("_"))
    | node.name == "app-expr" then: t-app(node, k)
    | node.name == "if-expr" then: t-if(node, k)
    | node.name == "cases-expr" then: t-cases(node, k)
    | node.name == "for-expr" then: t-for(node, k)
    | node.name == "construct-expr" then: t-construct(node, k)
    | node.name == "dot-expr" then:
      t(node.kids.first, k-fn(lam(vo): applyk(k, vo + "." + child!(node, "NAME").value.or-else("_")) end))
    | node.name == "lambda-expr" then: applyk(k, cps-lambda(node))
    | node.name == "user-block-expr" then: t-block(child!(node, "block"), k)
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
      e = fold_n(lam(i, acc, op): "(" + acc + " " + op + " " + vs.get(i + 1) + ")" end,
                 0, vs.first, parts.{1})
      applyk(k, e)
    end)
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
  ctor-node = child!(node, "binop-expr")
  ctor-name = cases(Option) simple-name(ctor-node): | some(n) => n | none => "list" end
  elems = cases(Option) child(node, "trailing-opt-comma-binops"):
    | none => empty
    | some(tr) => cases(Option) child(tr, "comma-binops"):
        | none => empty | some(cb) => filter(lam(x): x.name == "binop-expr" end, cb.kids) end
  end
  t-seq(elems, empty, lam(vs): applyk(k, "[" + ctor-name + ": " + join-args(vs) + "]") end)
end

fun t-if(node :: CstNode, k :: Cont) -> String:
  kids = node.kids
  cond = find(lam(x): x.name == "binop-expr" end, kids).value
  blocks = filter(lam(x): x.name == "block" end, kids)
  elseifs = filter(lam(x): x.name == "else-if" end, kids)
  has-else = is-some(find(lam(x): x.name == "ELSECOLON" end, kids))
  when not(has-else): raise("if without else not supported in CPS") end
  fun if-expr(vc :: String, kf :: Cont) -> String:
    base = "if " + vc + ": " + t-block(blocks.first, kf)
    mid = for fold(acc from base, ei from elseifs):
      ec = find(lam(x): x.name == "binop-expr" end, ei.kids).value
      eb = find(lam(x): x.name == "block" end, ei.kids).value
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
  scrut = find(lam(x): x.name == "binop-expr" end, node.kids).value
  branches = filter(lam(x): x.name == "cases-branch" end, node.kids)
  # else block (after the ELSE token) — TODO(port): index-based slice as in tCases
  else-block = find-else-block(node)
  fun emit(vscrut :: String, kf :: Cont) -> String:
    base = "cases(" + ty + ") " + vscrut + ":"
    body = for fold(acc from base, br from branches):
      vname = child!(br, "NAME").value.or-else("_")
      binds = cases(Option) child(br, "cases-args"):
        | none => empty
        | some(an) => map(lam(cb): binding-name(cases(Option) child(cb, "binding"): | some(b) => b | none => cb end) end,
                          filter(lam(x): x.name == "cases-binding" end, an.kids))
      end
      hd = if is-empty(binds): vname else: vname + "(" + join-args(binds) + ")" end
      acc + " | " + hd + " => " + t-block(child!(br, "block"), kf)
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
# TODO(port): faithful else-block extraction (TS slices kids after the ELSE token).
fun find-else-block(node :: CstNode) -> Option<CstNode>: none end

# for ITER(p from e, ...): body end  ==>  ITER(lam(p,...,KG): yield-check(...) end, e..., reify k)
fun t-for(node :: CstNode, k :: Cont) -> String:
  iter-expr = find(lam(x): x.name == "expr" end, node.kids).value
  binds = filter(lam(x): x.name == "for-bind" end, node.kids)
  params = map(lam(b): binding-name(child!(b, "binding")) end, binds)
  from-exprs = map(lam(b): find(lam(x): x.name == "binop-expr" end, b.kids).value end, binds)
  body = child!(node, "block")
  kg = gensym("k")
  lam-body = t-block(body, k-var(kg))
  lam-src = "lam(" + join-args(params + [list: kg]) + "): yield-check(lam(): " + lam-body + " end) end"
  t(iter-expr, k-fn(lam(v-iter):
      t-seq(from-exprs, empty, lam(vs):
          v-iter + "(" + join-args(link(lam-src, vs) + [list: reifyk(k)]) + ")" end) end))
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
    | node.name == "paren-expr" then: "(" + render-pure(child!(node, "binop-expr")) + ")"
    | node.name == "dot-expr" then: render-pure(node.kids.first) + "." + child!(node, "NAME").value.or-else("_")
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
      | last then: t(s, k)
      | otherwise: t(s, k-fn(lam(_v): t-stmts(stmts, i + 1, k) end))
    end
  end
end

fun cps-fun-def(fn-expr :: CstNode) -> String:
  name = child!(fn-expr, "NAME").value.or-else("_")
  params = header-params(fn-expr)
  kg = gensym("k")
  body = t-block(child!(fn-expr, "block"), k-var(kg))
  "fun " + name + "(" + join-args(params + [list: kg]) + "): yield-check(lam(): " + body + " end) end"
end

fun cps-lambda(node :: CstNode) -> String:
  params = header-params(node)
  kg = gensym("k")
  body = t-block(child!(node, "block"), k-var(kg))
  "lam(" + join-args(params + [list: kg]) + "): yield-check(lam(): " + body + " end) end"
end

fun render-data(node :: CstNode) -> String:
  ty-name = child!(node, "NAME").value.or-else("_")
  variants = filter(lam(k): (k.name == "data-variant") or (k.name == "first-data-variant") end, node.kids)
  parts = map(lam(v):
      cases(Option) child(v, "variant-constructor"):
        | some(ctor) =>
          nm = child!(ctor, "NAME").value.or-else("_")
          fields = cases(Option) child(ctor, "variant-members"):
            | none => empty
            | some(m) => map(lam(vm): binding-name(child!(vm, "binding")) end,
                             filter(lam(k): k.name == "variant-member" end, m.kids))
          end
          nm + "(" + join-args(fields) + ")"
        | none => child!(v, "NAME").value.or-else("_")
      end
    end, variants)
  "data " + ty-name + ": " + string-join(map(lam(p): "| " + p end, parts), " ") + " end"
end

# ---- top level ----
fun transform(program :: CstNode) -> String block:
  g := 0
  ctors := empty
  fun-defs := empty
  collect-data(program)
  collect-fun-defs(program)
  block = child!(program, "block")
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
