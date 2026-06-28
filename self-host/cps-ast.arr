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
# STEP-1 SCOPE (this file): core constructs — literals (num/str/bool/id), s-op
# (binops incl. and/or short-circuit), s-app (prim / general / method), s-lam, s-fun,
# s-let / s-var / s-let-expr, s-if-else, s-block.  Everything else (cases/data/for/
# when/method/tuples/objects/check/:=/rec/multi-let) raises a clear `# TODO(cps-ast)`.

provide *
provide-types *

import ast as A
import srcloc as S

# ---- dummy-loc node builders (mirror compile-driver.arr) ----
fun lml() -> A.Loc: S.builtin("cps-ast") end
fun lnm(s :: String) -> A.Name: A.s-name(lml(), s) end
fun lid(s :: String) -> A.Expr: A.s-id(lml(), lnm(s)) end
fun lbind(s :: String) -> A.Bind: A.s-bind(lml(), false, lnm(s), A.a-blank) end
fun lcall(name :: String, args :: List<A.Expr>) -> A.Expr: A.s-app(lml(), lid(name), args) end
# `block: <stmts> end`
fun lblock(stmts :: List<A.Expr>) -> A.Expr: A.s-block(lml(), stmts) end
# a single-bind `let`/`var` expression: `<kw> nm = val  <body>`
fun llet(nm :: String, val :: A.Expr, body :: A.Expr) -> A.Expr:
  A.s-let-expr(lml(), [list: A.s-let-bind(lml(), lbind(nm), val)], body, true)
end
fun lvar(nm :: String, val :: A.Expr, body :: A.Expr) -> A.Expr:
  A.s-let-expr(lml(), [list: A.s-var-bind(lml(), lbind(nm), val)], body, true)
end
fun ltrue() -> A.Expr: A.s-bool(lml(), true) end
fun lfalse() -> A.Expr: A.s-bool(lml(), false) end
# `if t: thn else: els end`
fun lif(t :: A.Expr, thn :: A.Expr, els :: A.Expr) -> A.Expr:
  A.s-if-else(lml(), [list: A.s-if-branch(lml(), t, thn)], els, false)
end
# `lam(<params>): <body> end`
fun llam(params :: List<A.Bind>, body :: A.Expr) -> A.Expr:
  A.s-lam(lml(), "", [list:], params, A.a-blank, "", body, none, none, false)
end
# the per-call interrupt point: `yield-check(lam(): <body> end)`
fun yield-wrap(body :: A.Expr) -> A.Expr:
  lcall("yield-check", [list: llam([list:], body)])
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
    | k-var(nm) => lcall(nm, [list: v])
    | k-fn(ap)  => ap(v)
  end
end

# Turn a continuation into a first-class VALUE expression (to pass as a function arg).
fun reifyk(k :: Cont) -> A.Expr:
  cases(Cont) k:
    | k-var(nm) => lid(nm)
    | k-fn(ap) =>
      x = gensym("v")
      llam([list: lbind(x)], ap(lid(x)))
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
    | s-str(_, _) => applyk(k, node)
    | s-bool(_, _) => applyk(k, node)
    | s-id(_, _) => applyk(k, node)
    | s-id-letrec(_, _, _) => applyk(k, node)
    | s-id-var(_, _) => applyk(k, node)
    | s-paren(_, e) => t(e, k)
    | s-block(_, stmts) => t-stmts(stmts, 0, k)
    | s-let-expr(_, binds, body, _) => t-let-binds(binds, body, k)
    | s-op(_, _, op, lhs, rhs) => t-op(op, lhs, rhs, k)
    | s-app(_, _, _) => t-app(node, k)
    | s-app-enriched(l, f, args, _) => t-app(A.s-app(l, f, args), k)
    | s-dot(_, obj, field) =>
      t(obj, k-fn(lam(vo): applyk(k, A.s-dot(lml(), vo, field)) end))
    | s-lam(_, _, _, _, _, _, _, _, _, _) => applyk(k, cps-lambda(node))
    | s-if-else(_, branches, els, _) => t-if(branches, els, k)
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
            lcall(helper, [list: vs.get(0), vs.get(1), reifyk(k)])
          end)
        | none =>
          t-seq([list: lhs, rhs], empty, lam(vs):
            applyk(k, A.s-op(lml(), lml(), op, vs.get(0), vs.get(1)))
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
              A.s-app(lml(), A.s-dot(lml(), vo, field), vargs + [list: reifyk(k)])
            end)
          end))
        | s-id(_, idn) =>
          name = idn.toname()
          if is-prim(name):
            # direct call (no continuation passed); its result feeds k
            t-seq(args, empty, lam(vargs): applyk(k, A.s-app(lml(), f, vargs)) end)
          else:
            # CPS call: the continuation is the last argument
            t-seq(args, empty, lam(vargs):
              A.s-app(lml(), f, vargs + [list: reifyk(k)])
            end)
          end
        | else =>
          # general application: evaluate the callee to a value, then call it
          t(f, k-fn(lam(vf):
            t-seq(args, empty, lam(vargs):
              A.s-app(lml(), vf, vargs + [list: reifyk(k)])
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
      params = map(lam(b): lbind(bind-name(b)) end, args) + [list: lbind(kg)]
      cbody = yield-wrap(t(body, k-var(kg)))
      A.s-fun(lml(), name, [list:], params, A.a-blank, "", cbody, none, none, false)
  end
end

fun cps-lambda(node :: A.Expr) -> A.Expr:
  cases(A.Expr) node:
    | s-lam(_, _, _, args, _, _, body, _, _, _) =>
      kg = gensym("k")
      params = map(lam(b): lbind(bind-name(b)) end, args) + [list: lbind(kg)]
      cbody = yield-wrap(t(body, k-var(kg)))
      A.s-lam(lml(), "", [list:], params, A.a-blank, "", cbody, none, none, false)
  end
end

# ---- statement sequences ----
fun t-stmts(stmts :: List<A.Expr>, i :: Number, k :: Cont) -> A.Expr:
  if is-empty(stmts): applyk(k, lid("nothing"))
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
      | s-fun(_, _, _, _, _, _, _, _, _, _) =>
        lblock([list: cps-fun-def(s), t-stmts(stmts, i + 1, k)])
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
      decls = for fold(acc from empty, s from stmts):
        cases(A.Expr) s:
          | s-fun(_, _, _, _, _, _, _, _, _, _) => acc + [list: cps-fun-def(s)]
          | else => acc
        end
      end
      rest = filter(lam(s): not(A.is-s-fun(s)) end, stmts)
      driver = if is-empty(rest): lcall("finish-result", [list: lid("nothing")])
        else: t-stmts(rest, 0, k-fn(lam(v): lcall("finish-result", [list: v]) end))
        end
      lblock(decls + [list: driver])
  end
end
