#lang pyret
# CPS TRANSFORM over ast.arr — an AST-to-AST continuation-passing transform.
#
# cps.arr consumes the JS-GLR generic `cst(name, value, kids)` tree and emits a
# SOURCE STRING (which must then be RE-PARSED to be compiled).  THIS module instead
# consumes the real `ast.arr` `s-*` nodes from the pure-Pyret parser
# (self-host/pyret-parser.arr) and PRODUCES `ast.arr` nodes — no source string, no
# re-parse.  That matters for two reasons:
#
#   1. SAFETY.  A string-emitting transform hand-builds syntax (quoting strings,
#      parenthesizing to preserve operator grouping, dodging reserved words); each is
#      a chance to emit invalid or subtly-wrong source.  An ast->ast transform CANNOT
#      emit invalid syntax — every node constructor is checked by the compiler.
#   2. THE NO-JS-PARSER GOAL.  A string-emitting transform must re-parse its own
#      output (source -> parse -> CPS -> SOURCE -> parse AGAIN -> backend), so it can
#      never remove the parser from the round-trip.  ast->ast is parse-once
#      (source -> parse -> CPS -> backend) — the path the web IDE needs.
#
# The continuation-passing SHAPE mirrors cps.arr value-for-value; the one intentional
# DIFFERENCE is `and`/`or`, which cps.arr lowers to a strict `(a and b)` (NO
# short-circuit — a latent bug); here they desugar to `if` so the right operand is
# only evaluated when reached.
#
# SCOPE: core constructs — literals (num/frac/rfrac/str/bool/id/undefined), s-op (binops
# incl. and/or short-circuit), s-app (prim / general / method), s-lam, s-fun, s-let /
# s-var / s-rec / s-let-expr, s-if / s-if-else, s-block / s-user-block.  PLUS (step 2):
# s-cases / s-cases-else, s-data (+ ctor registration), s-for, s-when, s-method, s-tuple /
# s-tuple-get, s-obj / s-extend / s-update (object + method fields), s-construct ([list:]),
# s-assign (:=), s-if-pipe / s-if-pipe-else (ask:), s-dot / s-get-bang, s-instantiate, and
# `check:` blocks (equality-style ops).  Unhandled nodes raise a clear `# TODO(cps-ast)`.

provide *
provide-types *

import ast as A
import srcloc as S

# ---- dummy-loc node builders (mirror compile-driver.arr) ----
fun cps-lml() -> A.Loc: S.builtin("cps-ast") end
fun cps-lnm(s :: String) -> A.Name: A.s-name(cps-lml(), s) end
fun cps-lid(s :: String) -> A.Expr: A.s-id(cps-lml(), cps-lnm(s)) end
fun cps-lbind(s :: String) -> A.Bind: A.s-bind(cps-lml(), false, cps-lnm(s), A.a-blank) end
fun cps-lcall(name :: String, args :: List<A.Expr>) -> A.Expr: A.s-app(cps-lml(), cps-lid(name), args) end
# `block: <stmts> end`
fun lblock(stmts :: List<A.Expr>) -> A.Expr: A.s-block(cps-lml(), stmts) end
# a single-bind `let`/`var` expression: `<kw> nm = val  <body>`
fun llet(nm :: String, val :: A.Expr, body :: A.Expr) -> A.Expr:
  A.s-let-expr(cps-lml(), [list: A.s-let-bind(cps-lml(), cps-lbind(nm), val)], body, true)
end
fun lvar(nm :: String, val :: A.Expr, body :: A.Expr) -> A.Expr:
  A.s-let-expr(cps-lml(), [list: A.s-var-bind(cps-lml(), cps-lbind(nm), val)], body, true)
end
fun ltrue() -> A.Expr: A.s-bool(cps-lml(), true) end
fun lfalse() -> A.Expr: A.s-bool(cps-lml(), false) end
# `if t: thn else: els end`
fun lif(t :: A.Expr, thn :: A.Expr, els :: A.Expr) -> A.Expr:
  A.s-if-else(cps-lml(), [list: A.s-if-branch(cps-lml(), t, thn)], els, false)
end
# `lam(<params>): <body> end`
fun llam(params :: List<A.Bind>, body :: A.Expr) -> A.Expr:
  A.s-lam(cps-lml(), "", [list:], params, A.a-blank, "", body, none, none, false)
end
# the per-call interrupt point: `yield-check(lam(): <body> end)`
fun yield-wrap(body :: A.Expr) -> A.Expr:
  cps-lcall("yield-check", [list: llam([list:], body)])
end

# ---- continuations (mirror cps.arr, now Expr-valued) ----
# k-var(nm) : the continuation is the variable `nm`     -> applied as `nm(v)`
# k-fn(ap)  : the continuation is a meta-level function -> `ap(v)` inlines its body
data Cont:
  | k-var(name :: String)
  | k-fn(apply :: (A.Expr -> A.Expr))
end

# ---- transform state ----
var g :: Number = 0                          # gensym counter
var fun-defs :: List<String> = empty         # names defined by top-level `fun`
var ctors :: List<String> = empty            # data constructor names (none yet — TODO data)

fun gensym(p :: String) -> String block:
  s = p + "cps" + num-to-string(g)
  g := g + 1
  s
end

# ---- continuation application / reification (mirror cps.arr) ----
fun applyk(k :: Cont, v :: A.Expr) -> A.Expr:
  cases(Cont) k:
    | k-var(nm) => cps-lcall(nm, [list: v])
    | k-fn(ap)  => ap(v)
  end
end

# Turn a continuation into a first-class VALUE expression (to pass as a function arg).
fun reifyk(k :: Cont) -> A.Expr:
  cases(Cont) k:
    | k-var(nm) => cps-lid(nm)
    | k-fn(ap) =>
      x = gensym("v")
      llam([list: cps-lbind(x)], ap(cps-lid(x)))
  end
end

# Run `f` with a continuation that is safe to MENTION MORE THAN ONCE (e.g. both
# branches of an `if`).  A k-var is already a name; a k-fn is bound to a fresh local
# so its body isn't duplicated across branches.
fun with-reified-k(k :: Cont, f :: (Cont -> A.Expr)) -> A.Expr:
  cases(Cont) k:
    | k-var(_) => f(k)
    | k-fn(_) =>
      kf = gensym("k")
      llet(kf, reifyk(k), f(k-var(kf)))
  end
end

# ---- primitives (mirror cps.arr) ----
# Called DIRECTLY (no continuation); their result feeds k.  A program-defined `fun`
# of the same name SHADOWS the intrinsic (it must be CPS-called instead).
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

fun is-prim(name :: String) -> Boolean:
  if fun-defs.member(name): false
  else:
    # NB: parenthesize the `and` group — the seed parses mixed and/or
    # left-associatively (no precedence), so the trailing `and` would otherwise
    # poison the whole disjunction.
    intrinsics.member(name) or ctors.member(name) or
      ((string-length(name) > 3) and (string-substring(name, 0, 3) == "is-")
        and ctors.member(string-substring(name, 3, string-length(name))))
  end
end

# Overloadable ops thread a CPS intrinsic (cps-op-*) so an overloaded `_plus` etc.
# stays interruptible; the rest are bounded (operands evaluated, then a plain op feeds k).
fun op-cps-helper(op :: String) -> Option<String>:
  ask:
    | op == "op+"  then: some("cps-op-plus")
    | op == "op-"  then: some("cps-op-minus")
    | op == "op*"  then: some("cps-op-times")
    | op == "op/"  then: some("cps-op-divide")
    | op == "op<"  then: some("cps-op-lessthan")
    | op == "op>"  then: some("cps-op-greaterthan")
    | op == "op<=" then: some("cps-op-lessequal")
    | op == "op>=" then: some("cps-op-greaterequal")
    | otherwise: none
  end
end

fun bind-name(b :: A.Bind) -> String:
  cases(A.Bind) b:
    | s-bind(_, _, id, _) => id.toname()
    | else => raise("TODO(cps-ast): destructuring bind " + b.label())
  end
end

# ---- sequencing (mirror cps.arr's t-seq): CPS-evaluate nodes left to right,
# collecting their value-expressions, then hand the list to `kf`. ----
fun t-seq(nodes :: List<A.Expr>, acc :: List<A.Expr>, kf :: (List<A.Expr> -> A.Expr)) -> A.Expr:
  cases(List) nodes:
    | empty => kf(acc)
    | link(n, rest) =>
      t(n, k-fn(lam(v): t-seq(rest, acc + [list: v], kf) end))
  end
end

# ---- expression transform ----
fun t(node :: A.Expr, k :: Cont) -> A.Expr:
  cases(A.Expr) node:
    # literals + identifiers are already value-expressions — feed the node to k directly
    # (no num-to-string / no string quoting — the node IS the value).
    | s-num(_, _) => applyk(k, node)
    | s-frac(_, _, _) => applyk(k, node)        # exact-rational literal `1/2`
    | s-rfrac(_, _, _) => applyk(k, node)       # roughnum-rational literal `~1/2`
    | s-str(_, _) => applyk(k, node)
    | s-bool(_, _) => applyk(k, node)
    | s-id(_, _) => applyk(k, node)
    | s-id-letrec(_, _, _) => applyk(k, node)
    | s-id-var(_, _) => applyk(k, node)
    | s-undefined(_) => applyk(k, node)
    | s-paren(_, e) => t(e, k)
    | s-block(_, stmts) => t-stmts(stmts, 0, k)
    | s-user-block(_, body) => t(body, k)
    | s-let-expr(_, binds, body, _) => t-let-binds(binds, body, k)
    | s-op(_, _, op, lhs, rhs) => t-op(op, lhs, rhs, k)
    | s-app(_, _, _) => t-app(node, k)
    | s-app-enriched(l, f, args, _) => t-app(A.s-app(l, f, args), k)
    | s-dot(_, obj, field) =>
      t(obj, k-fn(lam(vo): applyk(k, A.s-dot(cps-lml(), vo, field)) end))
    | s-get-bang(_, obj, field) =>
      t(obj, k-fn(lam(vo): applyk(k, A.s-get-bang(cps-lml(), vo, field)) end))
    | s-lam(_, _, _, _, _, _, _, _, _, _) => applyk(k, cps-lambda(node))
    | s-method(_, _, _, _, _, _, _, _, _, _) => applyk(k, cps-method-value(node))
    | s-if-else(_, branches, els, _) => t-if(branches, els, k)
    | s-if(_, branches, _) => t-if(branches, cps-lid("nothing"), k)  # no else -> nothing
    | s-cases(_, typ, val, branches, _) => t-cases(typ, val, branches, none, k)
    | s-cases-else(_, typ, val, branches, els, _) => t-cases(typ, val, branches, some(els), k)
    | s-when(_, test-e, body, _) => t-when(test-e, body, k)
    | s-if-pipe(_, branches, _) => t-ask(branches, none, k)
    | s-if-pipe-else(_, branches, els, _) => t-ask(branches, some(els), k)
    | s-for(_, iter, binds, _, body, _) => t-for(iter, binds, body, k)
    | s-tuple(_, fields) =>
      t-seq(fields, empty, lam(vs): applyk(k, A.s-tuple(cps-lml(), vs)) end)
    | s-tuple-get(_, tup, idx, _) =>
      t(tup, k-fn(lam(v): applyk(k, A.s-tuple-get(cps-lml(), v, idx, cps-lml())) end))
    | s-obj(_, fields) =>
      cps-fields-then(fields, lam(fs): applyk(k, A.s-obj(cps-lml(), fs)) end)
    | s-extend(_, supe, fields) =>
      t(supe, k-fn(lam(vsupe):
        cps-fields-then(fields, lam(fs): applyk(k, A.s-extend(cps-lml(), vsupe, fs)) end)
      end))
    | s-update(_, supe, fields) =>
      t(supe, k-fn(lam(vsupe):
        cps-fields-then(fields, lam(fs): applyk(k, A.s-update(cps-lml(), vsupe, fs)) end)
      end))
    | s-construct(_, modifier, ctor, values) =>
      t-seq(values, empty, lam(vs): applyk(k, A.s-construct(cps-lml(), modifier, ctor, vs)) end)
    | s-assign(_, id, value) =>
      t(value, k-fn(lam(v): applyk(k, A.s-assign(cps-lml(), id, v)) end))
    | s-instantiate(_, expr, params) =>
      t(expr, k-fn(lam(v): applyk(k, A.s-instantiate(cps-lml(), v, params)) end))
    | else => raise("TODO(cps-ast): expression " + node.label())
  end
end

# `and`/`or` short-circuit (the cps.arr gap we fix here); overloadable ops thread a
# cps-op-* intrinsic; bounded ops rebuild the operator node over the evaluated values.
fun t-op(op :: String, lhs :: A.Expr, rhs :: A.Expr, k :: Cont) -> A.Expr:
  ask:
    | op == "opand" then:
      with-reified-k(k, lam(kk):
        t(lhs, k-fn(lam(va): lif(va, t(rhs, kk), applyk(kk, lfalse())) end))
      end)
    | op == "opor" then:
      with-reified-k(k, lam(kk):
        t(lhs, k-fn(lam(va): lif(va, applyk(kk, ltrue()), t(rhs, kk)) end))
      end)
    | otherwise:
      cases(Option) op-cps-helper(op):
        | some(helper) =>
          t-seq([list: lhs, rhs], empty, lam(vs):
            cps-lcall(helper, [list: vs.get(0), vs.get(1), reifyk(k)])
          end)
        | none =>
          t-seq([list: lhs, rhs], empty, lam(vs):
            applyk(k, A.s-op(cps-lml(), cps-lml(), op, vs.get(0), vs.get(1)))
          end)
      end
  end
end

fun t-app(node :: A.Expr, k :: Cont) -> A.Expr:
  cases(A.Expr) node:
    | s-app(_, f, args) =>
      cases(A.Expr) f:
        | s-dot(_, obj, field) =>
          # method call: evaluate receiver + args, then `recv.field(args, reifyk(k))`
          t(obj, k-fn(lam(vo):
            t-seq(args, empty, lam(vargs):
              A.s-app(cps-lml(), A.s-dot(cps-lml(), vo, field), vargs + [list: reifyk(k)])
            end)
          end))
        | s-id(_, idn) =>
          name = idn.toname()
          if is-prim(name):
            # direct call (no continuation passed); its result feeds k
            t-seq(args, empty, lam(vargs): applyk(k, A.s-app(cps-lml(), f, vargs)) end)
          else:
            # CPS call: the continuation is the last argument
            t-seq(args, empty, lam(vargs):
              A.s-app(cps-lml(), f, vargs + [list: reifyk(k)])
            end)
          end
        | else =>
          # general application: evaluate the callee to a value, then call it
          t(f, k-fn(lam(vf):
            t-seq(args, empty, lam(vargs):
              A.s-app(cps-lml(), vf, vargs + [list: reifyk(k)])
            end)
          end))
      end
  end
end

# if / else-if / else: every test is CPS-evaluated (no render-pure crutch).  The
# continuation is reified once (when it's a k-fn) so it isn't duplicated per branch.
fun t-if(branches :: List<A.IfBranch>, els :: A.Expr, k :: Cont) -> A.Expr:
  with-reified-k(k, lam(kk): t-branches(branches, els, kk) end)
end

fun t-branches(branches :: List<A.IfBranch>, els :: A.Expr, kk :: Cont) -> A.Expr:
  cases(List) branches:
    | empty => t(els, kk)
    | link(b, rest) =>
      cases(A.IfBranch) b:
        | s-if-branch(_, test-e, body) =>
          t(test-e, k-fn(lam(vt):
            lif(vt, t(body, kk), t-branches(rest, els, kk))
          end))
      end
  end
end

# cases(T) scrut: | c(a) => body ... [| else => e] end — the scrutinee is CPS-evaluated,
# each branch body CPS'd with the (reified-once) continuation so it isn't duplicated.
fun t-cases(typ :: A.Ann, val :: A.Expr, branches :: List<A.CasesBranch>,
    els-opt :: Option<A.Expr>, k :: Cont) -> A.Expr:
  with-reified-k(k, lam(kk):
    t(val, k-fn(lam(vscrut):
      new-branches = map(lam(br): cps-cases-branch(br, kk) end, branches)
      cases(Option) els-opt:
        | none => A.s-cases(cps-lml(), typ, vscrut, new-branches, false)
        | some(els) => A.s-cases-else(cps-lml(), typ, vscrut, new-branches, t(els, kk), false)
      end
    end))
  end)
end

fun cps-cases-branch(br :: A.CasesBranch, kk :: Cont) -> A.CasesBranch:
  cases(A.CasesBranch) br:
    | s-cases-branch(_, _, name, args, body) =>
      A.s-cases-branch(cps-lml(), cps-lml(), name, args, t(body, kk))
    | s-singleton-cases-branch(_, _, name, body) =>
      A.s-singleton-cases-branch(cps-lml(), cps-lml(), name, t(body, kk))
  end
end

# when COND: BODY end  — BODY runs for effect (interruptible); the whole thing is nothing.
# The body's value-expr is EMITTED (in a block) before continuing — a body like `c := 10`
# or `print(x)` is side-effecting, so a continuation that discards its value must still
# evaluate it (else the effect is dropped).
fun t-when(test-e :: A.Expr, body :: A.Expr, k :: Cont) -> A.Expr:
  with-reified-k(k, lam(kk):
    t(test-e, k-fn(lam(vc):
      lif(vc,
        t(body, k-fn(lam(vb): lblock([list: vb, applyk(kk, cps-lid("nothing"))]) end)),
        applyk(kk, cps-lid("nothing")))
    end))
  end)
end

# ask: | t1 then: b1 ... [| otherwise: e] end  ==>  nested if/else.  Unlike if's else-if
# tests, ask branch TESTS sit in value position and may contain calls, so each is
# CPS-evaluated; the rest of the chain becomes its else-branch.
fun t-ask(branches :: List<A.IfPipeBranch>, els-opt :: Option<A.Expr>, k :: Cont) -> A.Expr:
  with-reified-k(k, lam(kk): t-ask-branches(branches, els-opt, kk) end)
end

fun t-ask-branches(brs :: List<A.IfPipeBranch>, els-opt :: Option<A.Expr>, kk :: Cont) -> A.Expr:
  cases(List) brs:
    | empty =>
      cases(Option) els-opt:
        | some(e) => t(e, kk)
        | none => cps-lcall("raise", [list: A.s-str(cps-lml(), "ask: no branch matched")])
      end
    | link(br, rest) =>
      cases(A.IfPipeBranch) br:
        | s-if-pipe-branch(_, test-e, body) =>
          t(test-e, k-fn(lam(vt):
            lif(vt, t(body, kk), t-ask-branches(rest, els-opt, kk))
          end))
      end
  end
end

# for ITER(p from e, ...): body end  ==>  ITER(lam(p,...,kg): yield-check(...) end, e..., reify k)
fun t-for(iter :: A.Expr, binds :: List<A.ForBind>, body :: A.Expr, k :: Cont) -> A.Expr:
  params = map(lam(b): cps-lbind(bind-name(b.bind)) end, binds)
  from-exprs = map(lam(b): b.value end, binds)
  kg = gensym("k")
  lam-src = llam(params + [list: cps-lbind(kg)], yield-wrap(t(body, k-var(kg))))
  t(iter, k-fn(lam(viter):
    t-seq(from-exprs, empty, lam(vs):
      A.s-app(cps-lml(), viter, link(lam-src, vs) + [list: reifyk(k)])
    end)
  end))
end

# object / extend / update fields: value (s-data-field) values are CPS-evaluated
# left-to-right; method fields get a trailing continuation param + yield-check body;
# anything else (e.g. mutable fields) passes through unchanged.
fun cps-fields-then(fields :: List<A.Member>, k-on :: (List<A.Member> -> A.Expr)) -> A.Expr:
  data-fields = filter(A.is-s-data-field, fields)
  method-fields = filter(A.is-s-method-field, fields)
  others = filter(lam(f): not(A.is-s-data-field(f)) and not(A.is-s-method-field(f)) end, fields)
  vals = map(lam(f): f.value end, data-fields)
  t-seq(vals, empty, lam(vs):
    new-data = rebuild-data-fields(data-fields, vs)
    new-methods = map(cps-method-field, method-fields)
    k-on(new-data + new-methods + others)
  end)
end

fun rebuild-data-fields(fs :: List<A.Member>, vs :: List<A.Expr>) -> List<A.Member>:
  cases(List) fs:
    | empty => empty
    | link(f, frest) =>
      cases(List) vs:
        | empty => empty
        | link(v, vrest) =>
          link(A.s-data-field(cps-lml(), f.name, v), rebuild-data-fields(frest, vrest))
      end
  end
end

fun cps-method-field(m :: A.Member) -> A.Member:
  cases(A.Member) m:
    | s-method-field(_, name, _, args, _, _, body, _, _, _) =>
      kg = gensym("k")
      params = map(lam(b): cps-lbind(bind-name(b)) end, args) + [list: cps-lbind(kg)]
      A.s-method-field(cps-lml(), name, [list:], params, A.a-blank, "",
        yield-wrap(t(body, k-var(kg))), none, none, false)
    | else => raise("TODO(cps-ast): non-method member in method position " + m.label())
  end
end

fun t-let-binds(binds :: List<A.LetBind>, body :: A.Expr, k :: Cont) -> A.Expr:
  cases(List) binds:
    | empty => t(body, k)
    | link(b, rest) =>
      cases(A.LetBind) b:
        | s-let-bind(_, bind, val) =>
          nm = bind-name(bind)
          t(val, k-fn(lam(v): llet(nm, v, t-let-binds(rest, body, k)) end))
        | s-var-bind(_, bind, val) =>
          nm = bind-name(bind)
          t(val, k-fn(lam(v): lvar(nm, v, t-let-binds(rest, body, k)) end))
        | else => raise("TODO(cps-ast): let-bind " + b.label())
      end
  end
end

# ---- function / lambda definitions ----
# Each gets a fresh continuation PARAM (kg) appended to the value params, and its
# body is wrapped in `yield-check(lam(): ... end)` (the per-call interrupt point).
fun cps-fun-def(fn :: A.Expr) -> A.Expr:
  cases(A.Expr) fn:
    | s-fun(_, name, _, args, _, _, body, _, _, _) =>
      kg = gensym("k")
      params = map(lam(b): cps-lbind(bind-name(b)) end, args) + [list: cps-lbind(kg)]
      cbody = yield-wrap(t(body, k-var(kg)))
      A.s-fun(cps-lml(), name, [list:], params, A.a-blank, "", cbody, none, none, false)
  end
end

fun cps-lambda(node :: A.Expr) -> A.Expr:
  cases(A.Expr) node:
    | s-lam(_, _, _, args, _, _, body, _, _, _) =>
      kg = gensym("k")
      params = map(lam(b): cps-lbind(bind-name(b)) end, args) + [list: cps-lbind(kg)]
      cbody = yield-wrap(t(body, k-var(kg)))
      A.s-lam(cps-lml(), "", [list:], params, A.a-blank, "", cbody, none, none, false)
  end
end

# a bare `method(self, ...): ... end` expression used as a VALUE.
fun cps-method-value(node :: A.Expr) -> A.Expr:
  cases(A.Expr) node:
    | s-method(_, _, _, args, _, _, body, _, _, _) =>
      kg = gensym("k")
      params = map(lam(b): cps-lbind(bind-name(b)) end, args) + [list: cps-lbind(kg)]
      A.s-method(cps-lml(), "", [list:], params, A.a-blank, "",
        yield-wrap(t(body, k-var(kg))), none, none, false)
  end
end

# ---- data definitions ----
# A `data` decl is hoisted (so forward refs resolve) and its methods CPS'd (each gains a
# trailing continuation param), mirroring the call sites that pass reifyk(k) as the last
# arg.  Constructors are NOT CPS'd — they're registered in `ctors` so is-prim calls them
# directly (no continuation).  The surface form is `s-data` (pre-desugar), what the
# pure-Pyret parser emits.
fun cps-data-def(d :: A.Expr) -> A.Expr:
  cases(A.Expr) d:
    # PRESERVE the original data/variant locs.  The backend keys each constructor's
    # table slot by `tostring(variant-loc)`, so collapsing every variant to a single
    # synthetic loc (cps-lml()) COLLIDES their slots -> the codegen's slot lookup finds no
    # entry ("cases: no branch matched" at compile time).  Keeping the real srclocs both
    # avoids the collision and gives accurate error positions.
    | s-data(l, name, params, mixins, variants, shared, _, _) =>
      A.s-data(l, name, params, mixins,
        map(cps-variant, variants), map(cps-member, shared), none, none)
  end
end

fun cps-variant(v :: A.Variant) -> A.Variant:
  cases(A.Variant) v:
    | s-variant(l, cl, name, members, with-members) =>
      A.s-variant(l, cl, name, members, map(cps-member, with-members))
    | s-singleton-variant(l, name, with-members) =>
      A.s-singleton-variant(l, name, map(cps-member, with-members))
  end
end

# data with:/sharing: members — methods are CPS-transformed; non-method (value) members
# are constants, kept as-is.
fun cps-member(m :: A.Member) -> A.Member:
  if A.is-s-method-field(m): cps-method-field(m)
  else: m
  end
end

# ---- check: blocks ----
# Each test's operands are CPS-evaluated (so calls inside them stay interruptible) and
# bound to value-exprs; we then emit an `s-check` comparing those VALUES so the seed's
# check harness records pass/fail exactly as for the direct compiler.  Only EQUALITY-style
# ops (is / is-not / is<op> / is-roughly / …) are supported — satisfies/raises call a
# user fn/thunk that, after CPS, takes a continuation the harness can't supply.
fun check-op-ok(op :: A.CheckOp) -> Boolean:
  lbl = op.label()
  (lbl == "s-op-is") or (lbl == "s-op-is-not") or (lbl == "s-op-is-op") or
    (lbl == "s-op-is-not-op") or (lbl == "s-op-is-roughly") or (lbl == "s-op-is-not-roughly")
end

fun t-check-block(name-opt :: Option<String>, body :: A.Expr, keyword-check :: Boolean,
    k :: Cont) -> A.Expr:
  tests = cases(A.Expr) body:
    | s-block(_, ss) => ss
    | else => [list: body]
  end
  cps-check-tests(tests, empty, lam(new-tests):
    chk = A.s-check(cps-lml(), name-opt, lblock(new-tests), keyword-check)
    lblock([list: chk, applyk(k, cps-lid("nothing"))])
  end)
end

# CPS-eval each check-test's operands (threading lets around the whole block), collecting
# rebuilt s-check-test nodes over the computed value-exprs, then hand them to kf.
fun cps-check-tests(ts :: List<A.Expr>, acc :: List<A.Expr>,
    kf :: (List<A.Expr> -> A.Expr)) -> A.Expr:
  cases(List) ts:
    | empty => kf(acc)
    | link(ct, rest) =>
      cases(A.Expr) ct:
        | s-check-test(_, op, refinement, left, rightopt, _) =>
          when not(check-op-ok(op)): raise("TODO(cps-ast): check-op " + op.label()) end
          when is-some(refinement): raise("TODO(cps-ast): check refinement (%(...))") end
          cases(Option) rightopt:
            | none => raise("TODO(cps-ast): check-test without rhs " + op.label())
            | some(right) =>
              t(left, k-fn(lam(lv):
                t(right, k-fn(lam(rv):
                  new-test = A.s-check-test(cps-lml(), op, none, lv, some(rv), none)
                  cps-check-tests(rest, acc + [list: new-test], kf)
                end))
              end))
          end
        | else => raise("TODO(cps-ast): non-test statement in check block " + ct.label())
      end
  end
end

# ---- statement sequences ----
fun t-stmts(stmts :: List<A.Expr>, i :: Number, k :: Cont) -> A.Expr:
  if is-empty(stmts): applyk(k, cps-lid("nothing"))
  else:
    last = i == (stmts.length() - 1)
    s = stmts.get(i)
    cases(A.Expr) s:
      | s-let(_, name, val, _) =>
        nm = bind-name(name)
        t(val, k-fn(lam(v): llet(nm, v, t-stmts(stmts, i + 1, k)) end))
      | s-var(_, name, val) =>
        nm = bind-name(name)
        t(val, k-fn(lam(v): lvar(nm, v, t-stmts(stmts, i + 1, k)) end))
      | s-rec(_, name, val) =>
        nm = bind-name(name)
        t(val, k-fn(lam(v): llet(nm, v, t-stmts(stmts, i + 1, k)) end))
      | s-fun(_, _, _, _, _, _, _, _, _, _) =>
        lblock([list: cps-fun-def(s), t-stmts(stmts, i + 1, k)])
      | s-data(_, _, _, _, _, _, _, _) =>
        lblock([list: cps-data-def(s), t-stmts(stmts, i + 1, k)])
      | s-check(_, nm, body, kw) =>
        cont = if last: k else: k-fn(lam(_): t-stmts(stmts, i + 1, k) end) end
        t-check-block(nm, body, kw, cont)
      | else =>
        # a plain expression statement
        if last: t(s, k)
        else:
          # Non-last expression: its value must still be EMITTED so side effects
          # (e.g. `print(...)`) run before continuing — don't drop it.
          t(s, k-fn(lam(v): lblock([list: v, t-stmts(stmts, i + 1, k)]) end))
        end
    end
  end
end

# ---- collect top-level fun names (for is-prim shadowing) ----
fun collect-fun-defs(stmts :: List<A.Expr>) -> List<String>:
  for fold(acc from empty, s from stmts):
    cases(A.Expr) s:
      | s-fun(_, name, _, _, _, _, _, _, _, _) => acc + [list: name]
      | else => acc
    end
  end
end

# ---- collect top-level data constructor names (for is-prim: ctors are called directly) ----
fun cps-variant-name(v :: A.Variant) -> String:
  cases(A.Variant) v:
    | s-variant(_, _, name, _, _) => name
    | s-singleton-variant(_, name, _) => name
  end
end
fun collect-ctors(stmts :: List<A.Expr>) -> List<String>:
  for fold(acc from empty, s from stmts):
    cases(A.Expr) s:
      | s-data(_, _, _, _, variants, _, _, _) => acc + map(cps-variant-name, variants)
      | else => acc
    end
  end
end

# ---- entry point ----
# cps-program(prog) -> the CPS'd top-level as an `ast.arr` block Expr.  Top-level
# `fun`s are hoisted as declarations (so forward references resolve); the remaining
# statements become the driver expression whose final continuation is `finish-result`.
# The result feeds the backend directly (production) or `.tosource()` (test rendering).
fun cps-program(prog :: A.Program) -> A.Expr block:
  g := 0
  ctors := empty
  cases(A.Program) prog:
    | s-program(_, _, _, _, _, _, prog-block) =>
      stmts = cases(A.Expr) prog-block:
        | s-block(_, ss) => ss
        | else => [list: prog-block]
      end
      fun-defs := collect-fun-defs(stmts)
      ctors := collect-ctors(stmts)
      # Hoist top-level `fun` and `data` as declarations (forward refs resolve; both are
      # globals), preserving original order so funs/data can reference one another.
      decls = for fold(acc from empty, s from stmts):
        cases(A.Expr) s:
          | s-fun(_, _, _, _, _, _, _, _, _, _) => acc + [list: cps-fun-def(s)]
          | s-data(_, _, _, _, _, _, _, _) => acc + [list: cps-data-def(s)]
          | else => acc
        end
      end
      rest = filter(lam(s): not(A.is-s-fun(s)) and not(A.is-s-data(s)) end, stmts)
      driver = if is-empty(rest): cps-lcall("finish-result", [list: cps-lid("nothing")])
        else: t-stmts(rest, 0, k-fn(lam(v): cps-lcall("finish-result", [list: v]) end))
        end
      lblock(decls + [list: driver])
  end
end
