provide *
# End-to-end SELF-HOSTED compile driver
#
# Chain: surface-parse (JS GLR) -> desugar-for-anf (cases-based, no visit()) ->
#        fix-provides -> ANF -> wasm-of-pyret backend.
#
# IMPORTANT: The seed compiler does NOT generate _match methods for data variants,
# so visit() on AST nodes is broken.  All passes in this driver use `cases`
# (which the seed compiler DOES support) instead of the visitor pattern.

import file("../self-compiler/compiler/parse-pyret.arr") as P
import ast as A
import anf as ANF
import srcloc as S
import file("./wasm-of-pyret.arr") as W

# ── unique lambda locs ───────────────────────────────────────────────────────
# The JS-GLR surface-parse gives every node `dummy-loc` (S.builtin("dummy location")).
# The backend keys each lambda's fnIndex/table-slot by tostring(its loc), so two
# sibling lambdas sharing dummy-loc COLLIDE — both resolve to the first one's slot,
# so calling the second runs the first's body.  Give every lambda/method a unique
# synthetic loc during desugar so the keys are distinct.
var lam-uid :: Number = 0
fun fresh-loc() -> A.Loc block:
  lam-uid := lam-uid + 1
  S.builtin("lam#" + tostring(lam-uid))
end

# ── op-string → global arithmetic function name ─────────────────────────────

fun op-to-global(op-str :: String) -> String:
  if op-str == "op+": "_plus"
  else if op-str == "op-": "_minus"
  else if op-str == "op*": "_times"
  else if op-str == "op/": "_divide"
  else if op-str == "op<": "_lessthan"
  else if op-str == "op>": "_greaterthan"
  else if op-str == "op<=": "_lessequal"
  else if op-str == "op>=": "_greaterequal"
  else if op-str == "op==": "equal-always"
  else: raise("Unknown op: " + op-str)
  end
end

# ── annotation stripping ─────────────────────────────────────────────────────
# Our backend does NO contract checking, so annotations are ERASED for codegen.
# Critically, leaving them in place traps the compiler: a bind/return annotation that
# is an `a-app` (e.g. `List<Number>`, `Option<a>`), `a-arrow`, `a-dot`, etc. null-refs
# downstream (anf/backend) — the dominant "null-ref at module load" self-compile blocker.
# So we replace every bind/return Ann with `a-blank` during desugar.

fun strip-bind(b :: A.Bind) -> A.Bind:
  cases(A.Bind) b:
    | s-bind(bl, sh, nm, _) => A.s-bind(bl, sh, nm, A.a-blank)
    | s-tuple-bind(bl, fields, as-name) =>
      A.s-tuple-bind(bl, fields.map(strip-bind),
        cases(Option) as-name:
          | none => none
          | some(ab) => some(strip-bind(ab))
        end)
  end
end

fun strip-binds(bs :: List<A.Bind>) -> List<A.Bind>: bs.map(strip-bind) end

fun strip-member(m :: A.VariantMember) -> A.VariantMember:
  cases(A.VariantMember) m:
    | s-variant-member(ml, mt, bind) => A.s-variant-member(ml, mt, strip-bind(bind))
  end
end

fun strip-cases-bind(cb :: A.CasesBind) -> A.CasesBind:
  cases(A.CasesBind) cb:
    | s-cases-bind(cl, ft, bind) => A.s-cases-bind(cl, ft, strip-bind(bind))
  end
end

# ── tuple-bind desugaring ────────────────────────────────────────────────────
# ANF can't consume `s-tuple-bind` (it reads `.id`), so `{a; b} = e`, tuple-bind
# params, and tuple cases-binds must be lowered to a fresh name + `tuple-get` lets
# (mirrors real Pyret's desugar-scope). These helpers build plain ast.arr nodes
# only; callers pass already-desugared sub-expressions.

fun fresh-tuple-name() -> String block:
  lam-uid := lam-uid + 1
  "$tup#" + tostring(lam-uid)
end

fun concat-all(lsts :: List) -> List:
  for fold(acc from [list:], x from lsts): acc + x end
end

# ── constant-stack list helpers ──────────────────────────────────────────────
# The seed's prelude `map`/`foldr` are NON-tail (`link(f(x), map(f, r))`), so they
# recurse depth = list-length and OVERFLOW the WASM stack on long lists — e.g. a module
# with a long run of top-level `fun`s, or a `data` with 100+ variants. The seed compiles
# NATIVE tail calls, so these accumulator-based versions run in CONSTANT stack. Use `tmap`
# (not `.map`) for every driver traversal over a possibly-long, size-proportional list.
fun trev(l :: List, acc :: List) -> List:
  cases(List) l:
    | empty => acc
    | link(x, r) => trev(r, link(x, acc))
  end
end
fun tmap(f, l :: List) -> List:
  # foldl is tail-recursive in the prelude; build reversed then reverse (both tail).
  trev(foldl(lam(acc, x): link(f(x), acc) end, [list:], l), [list:])
end

# Bind the names inside tuple-bind `tb` by reading from already-named `src-id` (an
# s-id of the holder). Recurses for nested tuple-binds. Returns a list of let-binds.
fun destructure-from(bl, tb :: A.Bind, src-id :: A.Expr) -> List<A.LetBind>:
  cases(A.Bind) tb:
    | s-bind(_, _, _, _) => [list: A.s-let-bind(bl, strip-bind(tb), src-id)]
    | s-tuple-bind(tbl, fields, as-name) =>
      as-binds = cases(Option) as-name:
        | none => [list:]
        | some(ab) => [list: A.s-let-bind(tbl, strip-bind(ab), src-id)]
      end
      field-binds = concat-all(
        map2(lam(f, i): destructure-from(tbl, f, A.s-tuple-get(tbl, src-id, i, tbl)) end,
          fields, range(0, fields.length())))
      as-binds + field-binds
  end
end

# Expand a single let-bind whose bind may be a tuple-bind: fresh = val, then
# destructure. Plain binds pass through (annotation-stripped). `val` is desugared.
fun expand-letbind(bl, tb :: A.Bind, val :: A.Expr) -> List<A.LetBind>:
  cases(A.Bind) tb:
    | s-bind(_, _, _, _) => [list: A.s-let-bind(bl, strip-bind(tb), val)]
    | s-tuple-bind(tbl, _, _) =>
      fresh = fresh-tuple-name()
      fresh-bind = A.s-bind(tbl, false, A.s-name(tbl, fresh), A.a-blank)
      fresh-id = A.s-id(tbl, A.s-name(tbl, fresh))
      link(A.s-let-bind(bl, fresh-bind, val), destructure-from(tbl, tb, fresh-id))
  end
end

# Split a parameter list: tuple-bind params become fresh names; their destructuring
# let-binds are returned to prepend to the body. Returns {new-params; prelude-binds}.
fun split-params(args :: List<A.Bind>):
  cases(List) args:
    | empty => {[list:]; [list:]}
    | link(a, rest) =>
      {rps; rbs} = split-params(rest)
      cases(A.Bind) a:
        | s-bind(_, _, _, _) => {link(strip-bind(a), rps); rbs}
        | s-tuple-bind(tbl, _, _) =>
          fresh = fresh-tuple-name()
          fresh-bind = A.s-bind(tbl, false, A.s-name(tbl, fresh), A.a-blank)
          fresh-id = A.s-id(tbl, A.s-name(tbl, fresh))
          {link(fresh-bind, rps); destructure-from(tbl, a, fresh-id) + rbs}
      end
  end
end

# Wrap a (desugared) body in a let-expr binding the param-destructuring prelude.
fun wrap-body(bl, prelude :: List<A.LetBind>, body :: A.Expr) -> A.Expr:
  if is-empty(prelude): body
  else: A.s-let-expr(bl, prelude, body, false)
  end
end

# Desugar a lambda's args+body, destructuring any tuple-bind params into the body.
fun desugar-lam-parts(bl, args :: List<A.Bind>, body :: A.Expr):
  {new-args; prelude} = split-params(args)
  {new-args; wrap-body(bl, prelude, desugar-expr(body))}
end

# ── helpers for cases / data desugaring ──────────────────────────────────────

# Split cases-branch binds: a tuple cases-bind becomes a fresh-name cases-bind plus
# destructuring let-binds to prepend to the branch body. Returns {new-binds; prelude}.
fun split-cases-binds(cbs :: List<A.CasesBind>):
  cases(List) cbs:
    | empty => {[list:]; [list:]}
    | link(cb, rest) =>
      {rcs; rbs} = split-cases-binds(rest)
      cases(A.CasesBind) cb:
        | s-cases-bind(cl, ft, bind) =>
          cases(A.Bind) bind:
            | s-bind(_, _, _, _) => {link(A.s-cases-bind(cl, ft, strip-bind(bind)), rcs); rbs}
            | s-tuple-bind(tbl, _, _) =>
              fresh = fresh-tuple-name()
              fresh-bind = A.s-bind(tbl, false, A.s-name(tbl, fresh), A.a-blank)
              fresh-id = A.s-id(tbl, A.s-name(tbl, fresh))
              {link(A.s-cases-bind(cl, ft, fresh-bind), rcs); destructure-from(tbl, bind, fresh-id) + rbs}
          end
      end
  end
end

fun desugar-cases-branch(b) -> A.CasesBranch:
  cases(A.CasesBranch) b:
    | s-cases-branch(l, pl, name, args, body) =>
      {new-args; prelude} = split-cases-binds(args)
      A.s-cases-branch(l, pl, name, new-args, wrap-body(l, prelude, desugar-expr(body)))
    | s-singleton-cases-branch(l, pl, name, body) =>
      A.s-singleton-cases-branch(l, pl, name, desugar-expr(body))
  end
end

fun desugar-member(m) -> A.Member:
  cases(A.Member) m:
    | s-data-field(l, name, value) => A.s-data-field(l, name, desugar-expr(value))
    | s-method-field(l, name, params, args, ann, doc, body, cl, ck, bl) =>
      # Normalize a method field to a data-field whose VALUE is an s-method expression.
      # anf reads each member's `.value` (get-value); s-method-field has no `.value`, so
      # feeding it to anf raises "$err_no_field". (Mirrors real Pyret's desugar, which
      # lowers method fields to data-field + s-method before anf.)
      {new-args; new-body} = desugar-lam-parts(l, args, body)
      A.s-data-field(fresh-loc(), name,
        A.s-method(fresh-loc(), name, params, new-args, A.a-blank, doc, new-body, cl, ck, bl))
    | else => m
  end
end

fun desugar-variant(v) -> A.Variant:
  cases(A.Variant) v:
    | s-variant(l, cl, vname, members, with-members) =>
      A.s-variant(l, cl, vname, tmap(strip-member, members), tmap(desugar-member, with-members))
    | s-singleton-variant(l, vname, with-members) =>
      A.s-singleton-variant(l, vname, tmap(desugar-member, with-members))
  end
end

# build a right-nested `link(v0, link(v1, ..., empty))` from already-desugared values.
fun build-link-chain(loc, vals, no-info):
  cases(List) vals:
    | empty => A.s-id(loc, A.s-name(loc, "empty"))
    | link(v, rest) =>
      A.s-app-enriched(loc, A.s-id(loc, A.s-name(loc, "link")),
        [list: v, build-link-chain(loc, rest, no-info)], no-info)
  end
end

# If `f` is a reference to an intrinsic builtin function (print/display) handled by a
# host import, return some(its-name); else none. Lets the s-app case lower it to a prim-app.
fun builtin-app-name(f) -> Option:
  cases(A.Expr) f:
    | s-id(_, id) =>
      nm = cases(A.Name) id:
        | s-name(_, s) => s
        | s-global(s) => s
        | else => ""
      end
      if (nm == "print") or (nm == "display"): some(nm) else: none end
    | else => none
  end
end

# ── `_` curry desugaring ─────────────────────────────────────────────────────
# `_` is s-id(s-underscore). In operand position it means "make a lambda over this hole":
#   _ + 1   -> lam(a): a + 1 end       _ + _ -> lam(a, b): a + b end
#   f(_, x) -> lam(a): f(a, x) end     _.foo -> lam(a): a.foo end
# Real Pyret does this in desugar.arr's curry pass; without it `_` reaches the backend as
# an unbound id -> null-ref. We detect underscore operands, replace each with a fresh param,
# and wrap the (re-desugared) expression in an s-lam over those params.
fun is-underscore-operand(e :: A.Expr) -> Boolean:
  # The pure-Pyret parser lexes `_` as a plain name "_" (s-id(s-name(_, "_"))); the JS-GLR
  # bridge may instead give s-underscore. Match both.
  cases(A.Expr) e:
    | s-id(_, n) =>
      cases(A.Name) n:
        | s-underscore(_) => true
        | s-name(_, s) => s == "_"
        | else => false
      end
    | else => false
  end
end

# {fresh-bind-list; replacement-expr (UN-desugared)}: an underscore slot becomes a fresh
# param + an s-id to it; any other expr passes through unchanged (desugared by the re-entry).
fun curry-slot(loc, e :: A.Expr):
  if is-underscore-operand(e):
    nm = fresh-tuple-name()
    {[list: A.s-bind(loc, false, A.s-name(loc, nm), A.a-blank)]; A.s-id(loc, A.s-name(loc, nm))}
  else:
    {[list:]; e}
  end
end

fun any-underscore(args :: List<A.Expr>) -> Boolean:
  cases(List) args:
    | empty => false
    | link(a, r) => if is-underscore-operand(a): true else: any-underscore(r) end
  end
end

# Replace underscore args with fresh params (tail-recursive): {fresh-binds; new-args}.
fun curry-args-acc(loc, args :: List<A.Expr>, bacc :: List, aacc :: List):
  cases(List) args:
    | empty => {trev(bacc, [list:]); trev(aacc, [list:])}
    | link(a, r) =>
      {bs; ax} = curry-slot(loc, a)
      curry-args-acc(loc, r, trev(bs, bacc), link(ax, aacc))
  end
end

fun curry-lam(loc, binds :: List, inner :: A.Expr) -> A.Expr:
  A.s-lam(fresh-loc(), "", [list:], binds, A.a-blank, "", desugar-expr(inner), none, none, false)
end

# ── cases-based AST desugaring (no visit()) ──────────────────────────────────
#
# FUTURE: switch to Pyret's REAL desugar pass (self-compiler/compiler/desugar.arr).
#   `desugar(program)` (desugar.arr:116) is cases-based and natively handles s-op,
#   s-id, s-check/s-check-test, s-data-expr, etc. — it would collapse most of the
#   hand-written cases below AND give full-language coverage.  `.visit()` now works
#   (the seed's _match/$variant_match fix), so the visitor-based parts run.
#   THE BLOCKER: desugar expects the AST in resolve-scope's OUTPUT shape — resolved
#   id forms (s-id-letrec/s-id-var/s-global), s-data-expr (not s-data), core
#   let/letrec.  Producing that means running desugar-scope(prog, env) +
#   resolve-names(p, uri, env) (resolve-scope.arr:576/667) first, both of which take
#   a C.CompileEnvironment.  So the remaining work is constructing a minimal
#   CompileEnvironment (globals + module provides) — not the visitor mechanism.
#   Until then this hand-written desugar covers the supported subset.
#
# Converts forms that ANF doesn't handle to forms it does:
#   s-op        -> s-app-enriched( s-id(s-global(…)), [lhs, rhs] )
#   s-app       -> s-app-enriched( f, args )
#   s-fun       -> collected into s-letrec by desugar-stmts
#   s-if        -> s-if-else (adds runtime error else-branch)
# All other nodes are passed through with recursive descent into sub-expressions.

# Auto-generated variant predicates `is-<variant>`: the backend dispatches them as a CALL
# (a-app on the variant id), but the seed also reifies them as first-class CLOSURES when used
# as VALUES (e.g. `MakeName`'s `is-s-name: is-s-name` object field, `.filter(is-link)`). The
# hand-written desugar has no resolve-scope to do that, so a bare `is-<variant>` would resolve
# to a null global. We ETA-EXPAND a value-position `is-V` into `lam(x): is-V(x) end`; the body
# stays a CALL the backend's variant-pred dispatch handles. (Call-position callees are kept raw
# by `desugar-callee`, so `is-V(arg)` does NOT eta-expand — avoiding infinite expansion.)
# Cross-module qualified refs. The whole program is a FLAT concat of module bodies with the
# `import ... as N` headers STRIPPED (build.ts mergeSourcesFor), so a qualified ref like
# `S.builtin` / `PP.str` arrives as s-dot(s-id(<alias>), member) with `<alias>` UNBOUND — it
# would read a null module value -> ref.cast. We flatten it to the bare global `member`,
# detecting a module alias by Pyret naming convention: a Capitalized head whose `member` is a
# known top-level global (modules/types are Capitalized; values/`self`/locals are lowercase,
# so real field access like `self.flat-width` is never flattened). `shadow-exports` maps a
# module-level shadowed surface name to its resolve-shadows fresh name, so `PP.str` resolves
# to pprint's SMART ctor (the final binding) rather than the raw variant ctor.
var top-globals :: List<String> = [list:]
var shadow-exports :: List = [list:]   # List<{k :: String; v :: String}>
fun is-uppercase-start(s :: String) -> Boolean:
  if string-length(s) == 0: false
  else:
    c = string-to-code-points(s).first
    (c >= 65) and (c <= 90)
  end
end
# Names introduced at the program top level (fun/data-type/variant/let/var/rec), so a
# qualified `Alias.member` flattens only when `member` really is a module global.
fun collect-top-globals(stmts :: List) -> List<String>:
  cases(List) stmts:
    | empty => [list:]
    | link(f, r) =>
      ns = cases(A.Expr) f:
        | s-fun(_, nm, _, _, _, _, _, _, _, _) => [list: nm]
        | s-data(_, nm, _, _, variants, _, _, _) => link(nm, tmap(surface-variant-name, variants))
        | s-let(_, bind, _, _) => cases(A.Bind) bind: | s-bind(_, _, bn, _) => if A.is-s-name(bn): [list: bn.s] else: [list:] end | else => [list:] end
        | s-var(_, bind, _) => cases(A.Bind) bind: | s-bind(_, _, bn, _) => if A.is-s-name(bn): [list: bn.s] else: [list:] end | else => [list:] end
        | s-rec(_, bind, _) => cases(A.Bind) bind: | s-bind(_, _, bn, _) => if A.is-s-name(bn): [list: bn.s] else: [list:] end | else => [list:] end
        | else => [list:]
      end
      ns + collect-top-globals(r)
  end
end
fun export-name(field :: String) -> String:
  fun go(es):
    cases(List) es:
      | empty => field
      | link(e, r) => if e.k == field: e.v else: go(r) end
    end
  end
  go(shadow-exports)
end
var known-variants :: List<String> = [list:]
fun is-variant-pred-name(s :: String) -> Boolean:
  (string-length(s) > 3) and (string-substring(s, 0, 3) == "is-") and
    known-variants.member(string-substring(s, 3, string-length(s)))
end
fun make-isvariant-eta(idl, s :: String) -> A.Expr:
  x = A.s-name(idl, fresh-tuple-name())
  body = A.s-block(idl, [list:
      A.s-app-enriched(idl, A.s-id(idl, A.s-name(idl, s)), [list: A.s-id(idl, x)],
        A.app-info-c(false, false))])
  A.s-lam(fresh-loc(), "", [list:], [list: A.s-bind(idl, false, x, A.a-blank)], A.a-blank, "",
    body, none, none, false)
end
# Collect every (top-level) data variant name, so is-<variant>-as-value can be detected.
fun collect-variant-names(stmts :: List) -> List<String>:
  cases(List) stmts:
    | empty => [list:]
    | link(f, r) =>
      vs = cases(A.Expr) f:
        | s-data(_, _, _, _, variants, _, _, _) => tmap(surface-variant-name, variants)
        | else => [list:]
      end
      vs + collect-variant-names(r)
  end
end
# Desugar a CALL callee: keep a bare s-id raw (so is-<variant>(arg) dispatches as a predicate
# CALL rather than eta-expanding); everything else desugars normally.
fun desugar-callee(f :: A.Expr) -> A.Expr:
  cases(A.Expr) f:
    | s-id(_, _) => f
    | else => desugar-expr(f)
  end
end

fun desugar-expr(e :: A.Expr) -> A.Expr:
  l = A.dummy-loc
  no-info = A.app-info-c(false, false)
  cases(A.Expr) e:
    | s-num(_, _)  => e
    | s-str(_, _)  => e
    | s-bool(_, _) => e
    | s-id(idl, nm) =>
      cases(A.Name) nm:
        | s-name(_, s) => if is-variant-pred-name(s): make-isvariant-eta(idl, s) else: e end
        | else => e
      end
    | s-prim-val(_, _) => e
    | s-undefined(_) => e
    | s-srcloc(_, _) => e
    | s-id-var(_, _) => e
    | s-id-letrec(_, _, _) => e
    | s-id-modref(_, _, _, _) => e
    | s-id-var-modref(_, _, _, _) => e
    | s-ref(_, _) => e

    | s-op(loc, op-loc, op-str, lhs, rhs) =>
      if is-underscore-operand(lhs) or is-underscore-operand(rhs):
        # curry: `_ + e` / `e + _` / `_ + _` -> lam over the hole(s); re-desugar the op
        # with fresh ids (no underscores left -> falls through to the normal op handling).
        {lb; lx} = curry-slot(loc, lhs)
        {rb; rx} = curry-slot(loc, rhs)
        curry-lam(loc, lb + rb, A.s-op(loc, op-loc, op-str, lx, rx))
      else:
      # `and`/`or` are SHORT-CIRCUIT — desugar to `if`, not a strict binary call.
      #   a and b -> if a: b else: false end
      #   a or b  -> if a: true else: b end
      if op-str == "opand":
        A.s-if-else(loc,
          [list: A.s-if-branch(loc, desugar-expr(lhs), desugar-expr(rhs))],
          A.s-bool(loc, false), false)
      else if op-str == "opor":
        A.s-if-else(loc,
          [list: A.s-if-branch(loc, desugar-expr(lhs), A.s-bool(loc, true))],
          desugar-expr(rhs), false)
      else if op-str == "op^":
        # reverse application: `a ^ f` -> f(a)
        A.s-app-enriched(loc, desugar-expr(rhs), [list: desugar-expr(lhs)], no-info)
      else if op-str == "op<>":
        # not-equal: `a <> b` -> not(a == b)   (mirrors the seed's NEQ = eqz($equal))
        eq-app = A.s-app-enriched(loc, A.s-id(loc, A.s-global("equal-always")),
          [list: desugar-expr(lhs), desugar-expr(rhs)], no-info)
        A.s-prim-app(loc, "not", [list: eq-app], A.prim-app-info-c(false))
      else:
        gname = op-to-global(op-str)
        A.s-app-enriched(loc, A.s-id(loc, A.s-global(gname)),
          [list: desugar-expr(lhs), desugar-expr(rhs)], no-info)
      end
      end

    | s-app(loc, f, args) =>
      if any-underscore(args):
        # curry: `f(_, x)` -> `lam(a): f(a, x) end` (re-desugar the app with fresh ids).
        {newbinds; newargs} = curry-args-acc(loc, args, [list:], [list:])
        curry-lam(loc, newbinds, A.s-app(loc, f, newargs))
      else:
      # `print(x)` / `display(x)` are intrinsics: lower to a prim-app the backend maps to
      # the host print import (otherwise `print` resolves to an unbound global -> null).
      app-prim-name = builtin-app-name(f)
      if is-some(app-prim-name) and (args.length() == 1):
        A.s-prim-app(loc, app-prim-name.value, [list: desugar-expr(args.first)],
          A.prim-app-info-c(false))
      else:
        A.s-app-enriched(loc, desugar-callee(f), args.map(desugar-expr), no-info)
      end
      end

    | s-app-enriched(loc, f, args, info) =>
      A.s-app-enriched(loc, desugar-callee(f), args.map(desugar-expr), info)

    | s-block(loc, stmts) =>
      # anf raises "Empty block" on an empty stmt list (e.g. a block whose only
      # statements were erased type-aliases/contracts) — nonempty-block emits `nothing`.
      nonempty-block(loc, desugar-stmts(stmts, false))   # nested block: not module-top-level

    | s-if-else(loc, branches, _else, blocky) =>
      A.s-if-else(loc,
        branches.map(lam(b): A.s-if-branch(b.l, desugar-expr(b.test), desugar-expr(b.body)) end),
        desugar-expr(_else), blocky)

    | s-if(loc, branches, blocky) =>
      # Desugar s-if (no else) to s-if-else with a raise as the else branch
      A.s-if-else(loc,
        branches.map(lam(b): A.s-if-branch(b.l, desugar-expr(b.test), desugar-expr(b.body)) end),
        A.s-prim-app(loc, "throwNonBooleanCondition", [list:], A.prim-app-info-c(false)),
        blocky)

    | s-when(loc, test, blk, blocky) =>
      # `when c: body end` -> `if c: body ; nothing else: nothing end` (when yields nothing)
      nothing-id = A.s-id(loc, A.s-name(loc, "nothing"))
      A.s-if-else(loc,
        [list: A.s-if-branch(loc, desugar-expr(test),
            A.s-block(loc, [list: desugar-expr(blk), nothing-id]))],
        nothing-id, blocky)

    | s-if-pipe(loc, branches, blocky) =>
      # `ask: | t then: b ... end` (no otherwise) -> nested if-else; no-match raises.
      A.s-if-else(loc,
        branches.map(lam(b): A.s-if-branch(b.l, desugar-expr(b.test), desugar-expr(b.body)) end),
        A.s-prim-app(loc, "throwNoBranchesMatched", [list:], A.prim-app-info-c(false)),
        blocky)

    | s-if-pipe-else(loc, branches, _else, blocky) =>
      # `ask: ... | otherwise: e end` -> nested if-else with `e` as the else.
      A.s-if-else(loc,
        branches.map(lam(b): A.s-if-branch(b.l, desugar-expr(b.test), desugar-expr(b.body)) end),
        desugar-expr(_else), blocky)

    | s-lam(loc, name, params, args, ann, doc, body, chk-loc, chk, blocky) =>
      {new-args; new-body} = desugar-lam-parts(loc, args, body)
      A.s-lam(fresh-loc(), name, params, new-args, A.a-blank, doc, new-body, chk-loc, chk, blocky)

    | s-fun(loc, name, params, args, ann, doc, body, chk-loc, chk, blocky) =>
      # s-fun in non-statement position: turn into a self-named lambda
      {new-args; new-body} = desugar-lam-parts(loc, args, body)
      A.s-lam(fresh-loc(), name, params, new-args, A.a-blank, doc, new-body, chk-loc, chk, blocky)

    | s-method(loc, name, params, args, ann, doc, body, chk-loc, chk, blocky) =>
      {new-args; new-body} = desugar-lam-parts(loc, args, body)
      A.s-method(fresh-loc(), name, params, new-args, A.a-blank, doc, new-body, chk-loc, chk, blocky)

    | s-let(loc, bind, expr, closure-val) =>
      A.s-let(loc, strip-bind(bind), desugar-expr(expr), closure-val)

    | s-let-expr(loc, binds, body, blocky) =>
      new-binds = concat-all(tmap(lam(b):
        cases(A.LetBind) b:
          | s-let-bind(bl, bind, val) => expand-letbind(bl, bind, desugar-expr(val))
          | s-var-bind(bl, bind, val) => [list: A.s-var-bind(bl, strip-bind(bind), desugar-expr(val))]
        end
      end, binds))
      A.s-let-expr(loc, new-binds, desugar-expr(body), blocky)

    | s-letrec(loc, binds, body, blocky) =>
      new-binds = tmap(lam(b):
        A.s-letrec-bind(b.l, strip-bind(b.b), desugar-expr(b.value))
      end, binds)
      A.s-letrec(loc, new-binds, desugar-expr(body), blocky)

    | s-var(loc, bind, val) =>
      A.s-var(loc, strip-bind(bind), desugar-expr(val))

    | s-assign(loc, id, val) =>
      A.s-assign(loc, id, desugar-expr(val))

    | s-dot(loc, obj, field) =>
      is-modref = cases(A.Expr) obj:
        | s-id(_, nm) => A.is-s-name(nm) and is-uppercase-start(nm.s) and top-globals.member(field)
        | else => false
      end
      if is-modref:
        # `N.member` (N an import alias) -> the bare global `member` (flat namespace),
        # mapped through shadow-exports so a shadowed export resolves to its final binding.
        A.s-id(loc, A.s-name(loc, export-name(field)))
      else if is-underscore-operand(obj):
        # curry: `_.foo` -> `lam(a): a.foo end`
        {bs; ox} = curry-slot(loc, obj)
        curry-lam(loc, bs, A.s-dot(loc, ox, field))
      else:
        A.s-dot(loc, desugar-expr(obj), field)
      end

    | s-get-bang(loc, obj, field) =>
      A.s-get-bang(loc, desugar-expr(obj), field)

    | s-update(loc, obj, fields) =>
      A.s-update(loc, desugar-expr(obj), fields.map(lam(f):
        A.s-data-field(f.l, f.name, desugar-expr(f.value))
      end))

    | s-extend(loc, obj, fields) =>
      # desugar-member handles BOTH s-data-field and s-method-field (the latter -> a
      # data-field carrying an s-method value); reading f.value directly crashed on
      # method fields (they have .body, not .value) — the `default-map-visitor.{ method
      # ... }` extend idiom that blocked ast-util/desugar-check/type-check/etc.
      A.s-extend(loc, desugar-expr(obj), fields.map(desugar-member))

    | s-obj(loc, fields) =>
      # desugar-member handles BOTH s-data-field and s-method-field (the latter -> a
      # data-field carrying an s-method value), so object methods compile too.
      A.s-obj(loc, fields.map(desugar-member))

    | s-tuple(loc, fields) =>
      A.s-tuple(loc, fields.map(desugar-expr))

    | s-tuple-get(loc, tup, index, index-loc) =>
      A.s-tuple-get(loc, desugar-expr(tup), index, index-loc)

    | s-array(loc, values) =>
      A.s-array(loc, values.map(desugar-expr))

    | s-user-block(loc, body) =>
      # strip s-user-block — just keep the inner expression
      desugar-expr(body)

    | s-for(loc, iterator, bindings, _, body, _) =>
      # `for ITER(b0 from e0, b1 from e1): body end`
      #   -> ITER(lam(b0, b1): body end, e0, e1)
      raw-args = bindings.map(lam(fb): cases(A.ForBind) fb: | s-for-bind(_, b, _) => b end end)
      srcs = bindings.map(lam(fb): cases(A.ForBind) fb: | s-for-bind(_, _, v) => desugar-expr(v) end end)
      {new-args; new-body} = desugar-lam-parts(loc, raw-args, body)
      lam-e = A.s-lam(fresh-loc(), "", [list:], new-args, A.a-blank, "",
        new-body, none, none, false)
      A.s-app-enriched(loc, desugar-expr(iterator), link(lam-e, srcs), no-info)

    | s-instantiate(loc, body, params) =>
      A.s-instantiate(loc, desugar-expr(body), params)

    | s-module(loc, answer, dv, dt, prov, types, checks) =>
      A.s-module(loc, desugar-expr(answer), dv, dt, prov, types, desugar-expr(checks))

    | s-check-expr(loc, expr, ann) =>
      A.s-check-expr(loc, desugar-expr(expr), ann)

    | s-check(loc, name, body, kw) =>
      # a `check:`/`examples:` block — keep only its body (the s-check-tests),
      # which desugar to check-harness prim-apps below.
      desugar-expr(body)

    | s-check-test(loc, op, refinement, left, right, cause) =>
      # `lhs is rhs` / `lhs is-not rhs` -> a prim-app the backend maps to the
      # runtime check harness ($check_is / $check_is_not), which bumps $passed/$total.
      dleft = desugar-expr(left)
      cases(Option) right:
        | none =>
          # postfix ops (does-not-raise, etc.) not yet supported self-hosted
          raise("self-hosted check: unsupported postfix check op")
        | some(r) =>
          dright = desugar-expr(r)
          pname = cases(A.CheckOp) op:
            | s-op-is(_) => "check-is"
            | s-op-is-not(_) => "check-is-not"
            | else => raise("self-hosted check: unsupported check op " + op.label())
          end
          A.s-prim-app(loc, pname, [list: dleft, dright], A.prim-app-info-c(false))
      end

    | s-prim-app(loc, fname, args, info) =>
      A.s-prim-app(loc, fname, args.map(desugar-expr), info)

    | s-construct(loc, modifier, constructor, values) =>
      # `[list: e1, e2, ...]` lowers to nested link(e1, link(e2, ..., empty)).
      # link/empty come from the (minimal) prelude that the harness prepends.
      # Only the `list` constructor is handled; others fall through to an error.
      # NB: build the chain with an EXPLICIT recursion (not foldr): the seed's prelude
      # foldr calls its function with SWAPPED args (f(acc, elt)), so a foldr-based build
      # produced a malformed chain.  (Seed prelude bug, out of scope here.)
      build-link-chain(loc, tmap(desugar-expr, values), no-info)

    | s-data(loc, name, params, mixins, variants, shared, chk-loc, chk) =>
      A.s-data-expr(loc, name, A.s-name(loc, name), params, mixins,
        tmap(desugar-variant, variants), tmap(desugar-member, shared), chk-loc, chk)

    | s-cases(loc, typ, val, branches, blocky) =>
      A.s-cases-else(loc, typ, desugar-expr(val),
        tmap(desugar-cases-branch, branches),
        A.s-prim-app(loc, "throwNoCasesMatched", [list:], A.prim-app-info-c(false)),
        blocky)

    | s-cases-else(loc, typ, val, branches, _else, blocky) =>
      A.s-cases-else(loc, typ, desugar-expr(val),
        tmap(desugar-cases-branch, branches), desugar-expr(_else), blocky)

    | s-paren(_, inner) => desugar-expr(inner)

    | s-template(loc) =>
      # `...` unfinished-expression placeholder: abort at runtime (backend prim).
      A.s-prim-app(loc, "throwUnfinishedTemplate", [list:], A.prim-app-info-c(false))

    | else => e
  end
end

# ── Desugar a statement list, hoisting consecutive s-fun into s-letrec ────────

fun collect-funs-acc(stmts, acc :: List):
  # Tail-recursive: accumulate the run of consecutive s-fun (reversed), stop at the
  # first non-s-fun. (Was non-tail — overflowed on a long run of top-level funs, the
  # dominant self-compile "Maximum call stack" blocker on the largest modules.)
  cases(List) stmts:
    | empty => {trev(acc, [list:]); [list:]}
    | link(f, rest) =>
      if A.is-s-fun(f): collect-funs-acc(rest, link(f, acc))
      else: {trev(acc, [list:]); stmts}
      end
  end
end

fun collect-funs(stmts):
  # Returns {fun-list; remaining-stmts} splitting at first non-s-fun
  collect-funs-acc(stmts, [list:])
end

fun fun-to-letrec-bind(fn :: A.Expr) -> A.LetrecBind:
  cases(A.Expr) fn:
    | s-fun(fl, fname, fparams, fargs, fann, fdoc, fbody, fchk-loc, fchk, fblocky) =>
      {new-args; new-body} = desugar-lam-parts(fl, fargs, fbody)
      lam-val = A.s-lam(fresh-loc(), fname, fparams, new-args, A.a-blank, fdoc, new-body,
                        fchk-loc, fchk, fblocky)
      A.s-letrec-bind(fl, A.s-bind(fl, false, A.s-name(fl, fname), A.a-blank), lam-val)
  end
end

fun surface-variant-name(v) -> String:
  cases(A.Variant) v:
    | s-variant(_, _, vn, _, _) => vn
    | s-singleton-variant(_, vn, _) => vn
  end
end

# Build an s-block that is NEVER empty: an empty statement list (e.g. a body/module
# whose statements were all erased contracts/types) would trip anf.arr's "Empty block",
# so substitute a `nothing` statement. Used at every s-block-producing site.
fun nonempty-block(loc, desugared :: List<A.Expr>) -> A.Expr:
  if is-empty(desugared): A.s-block(loc, [list: A.s-id(loc, A.s-name(loc, "nothing"))])
  else: A.s-block(loc, desugared)
  end
end

# the remaining statements as a single body expression (for let/letrec bodies)
fun stmts-to-body(desugared :: List<A.Expr>) -> A.Expr:
  l = A.dummy-loc
  if is-empty(desugared): A.s-id(l, A.s-name(l, "nothing"))
  else if is-empty(desugared.rest): desugared.first
  else: A.s-block(l, desugared)
  end
end

# Partition a statement list (tail-recursively) into (a) the letrec-binds for ALL
# `s-fun` / `s-data` (object + constructors) / `s-rec` definitions — wherever they
# appear — and (b) the remaining statements (value `s-let`/`s-var` + expressions), both
# in source order. `s-type`/`s-newtype`/`s-contract` are erased. This makes the whole
# level ONE mutually-recursive scope: definitions are hoisted ahead of the value
# bindings, so a value initializer can forward-reference a fun/constructor defined later.
# (Top-level names become mutable globals in the backend, so visibility is total — the
# ONLY thing that mattered was init ORDER; fun/data/rec bindings are effect-free, so
# moving them ahead of the value bindings/expressions preserves observable behavior.)
fun partition-top(stmts, bind-acc :: List, rest-acc :: List):
  cases(List) stmts:
    | empty => { trev(bind-acc, [list:]); trev(rest-acc, [list:]) }
    | link(f, more) =>
      cases(A.Expr) f:
        | s-fun(_, _, _, _, _, _, _, _, _, _) =>
          partition-top(more, link(fun-to-letrec-bind(f), bind-acc), rest-acc)
        | s-data(dl, dname, _, _, variants, _, _, _) =>
          objname = "$data$" + dname
          obj-id = A.s-id(dl, A.s-name(dl, objname))
          obj-bind = A.s-letrec-bind(dl, A.s-bind(dl, false, A.s-name(dl, objname), A.a-blank),
            desugar-expr(f))   # -> s-data-expr
          ctor-binds = tmap(lam(v):
              vn = surface-variant-name(v)
              A.s-letrec-bind(dl, A.s-bind(dl, false, A.s-name(dl, vn), A.a-blank),
                A.s-dot(dl, obj-id, vn))
            end, variants)
          # keep order [obj-bind, ctor0, ctor1, …] in the final (un-reversed) list
          partition-top(more, trev(link(obj-bind, ctor-binds), bind-acc), rest-acc)
        | s-rec(rl, bind, val) =>
          partition-top(more,
            link(A.s-letrec-bind(rl, strip-bind(bind), desugar-expr(val)), bind-acc), rest-acc)
        | s-var(vl, bind, val) =>
          # Hoist `var` into the letrec too: ANF lowers letrec binds to a PRE-ALLOCATED box
          # (s-var-bind s-undefined) + an assign, so a nested `fun` defined before the var in
          # the hoist order still captures the (pre-allocated) box -> shared mutation works.
          # (Without this, a hoisted fun that mutates a local var — e.g. pprint's `format`
          # whose inner `emit-text` mutates `cur-line` — captured a not-yet-bound null box.)
          partition-top(more,
            link(A.s-letrec-bind(vl, strip-bind(bind), desugar-expr(val)), bind-acc), rest-acc)
        | s-type(_, _, _, _) => partition-top(more, bind-acc, rest-acc)       # erased
        | s-newtype(_, _, _) => partition-top(more, bind-acc, rest-acc)       # erased
        | s-contract(_, _, _, _) => partition-top(more, bind-acc, rest-acc)   # erased
        | else => partition-top(more, bind-acc, link(f, rest-acc))            # let/var/expr
      end
  end
end

# Does bind `b` (re)bind the name `n`? (so a substitution must stop under it)
fun bind-has-name(b :: A.Bind, n :: String) -> Boolean:
  cases(A.Bind) b:
    | s-bind(_, _, nm, _) => A.is-s-name(nm) and (nm.s == n)
    | s-tuple-bind(_, fs, as-n) =>
      lists.any(lam(x): bind-has-name(x, n) end, fs) or
      cases(Option) as-n: | none => false | some(ab) => bind-has-name(ab, n) end
  end
end

# Capture-avoiding rename of FREE references to the bare name `fromn` -> Name `ton`,
# over a surface expression. Covers the forms that appear in `shadow X = val` values
# (lambdas + their app/dot/op bodies); stops under a binder that rebinds `fromn`.
fun subst-id(e :: A.Expr, fromn :: String, ton) -> A.Expr:
  sub = lam(x): subst-id(x, fromn, ton) end
  subst-branch = lam(br):
    cases(A.CasesBranch) br:
      | s-cases-branch(bl, pl, name, args, body) =>
        rebinds = lists.any(lam(cb): cases(A.CasesBind) cb:
            | s-cases-bind(_, _, bb) => bind-has-name(bb, fromn) end end, args)
        if rebinds: br else: A.s-cases-branch(bl, pl, name, args, sub(body)) end
      | s-singleton-cases-branch(bl, pl, name, body) =>
        A.s-singleton-cases-branch(bl, pl, name, sub(body))
    end
  end
  subst-member = lam(m):
    cases(A.Member) m:
      | s-data-field(ml, nm, v) => A.s-data-field(ml, nm, sub(v))
      | s-method-field(ml, nm, ps, args, ann, doc, body, cl, ck, bl) =>
        if lists.any(lam(a): bind-has-name(a, fromn) end, args): m
        else: A.s-method-field(ml, nm, ps, args, ann, doc, sub(body), cl, ck, bl)
        end
      | else => m
    end
  end
  cases(A.Expr) e:
    | s-id(l, n) => if A.is-s-name(n) and (n.s == fromn): A.s-id(l, ton) else: e end
    | s-app(l, f, args) => A.s-app(l, sub(f), map(sub, args))
    | s-app-enriched(l, f, args, info) => A.s-app-enriched(l, sub(f), map(sub, args), info)
    | s-prim-app(l, fn, args, info) => A.s-prim-app(l, fn, map(sub, args), info)
    | s-op(l, ol, op, lft, rgt) => A.s-op(l, ol, op, sub(lft), sub(rgt))
    | s-dot(l, o, fld) => A.s-dot(l, sub(o), fld)
    | s-get-bang(l, o, fld) => A.s-get-bang(l, sub(o), fld)
    | s-paren(l, x) => A.s-paren(l, sub(x))
    | s-tuple(l, fs) => A.s-tuple(l, map(sub, fs))
    | s-tuple-get(l, t, i, il) => A.s-tuple-get(l, sub(t), i, il)
    | s-construct(l, m, c, vs) => A.s-construct(l, m, sub(c), map(sub, vs))
    | s-lam(l, nm, ps, args, ann, doc, body, ck, cl, bl) =>
      if lists.any(lam(a): bind-has-name(a, fromn) end, args): e
      else: A.s-lam(l, nm, ps, args, ann, doc, sub(body), ck, cl, bl)
      end
    | s-block(l, stmts) => A.s-block(l, map(sub, stmts))   # lambda bodies are blocks!
    | s-if-else(l, branches, els, bl) =>
      A.s-if-else(l, map(lam(b): A.s-if-branch(b.l, sub(b.test), sub(b.body)) end, branches), sub(els), bl)
    | s-if(l, branches, bl) =>
      A.s-if(l, map(lam(b): A.s-if-branch(b.l, sub(b.test), sub(b.body)) end, branches), bl)
    | s-user-block(l, bdy) => A.s-user-block(l, sub(bdy))
    # ---- definitions/statements (so a forward shadow-rename reaches funs defined AFTER it) ----
    | s-fun(l, nm, ps, args, ann, doc, body, cl, ck, bl) =>
      if lists.any(lam(a): bind-has-name(a, fromn) end, args): e
      else: A.s-fun(l, nm, ps, args, ann, doc, sub(body), cl, ck, bl)
      end
    | s-method(l, nm, ps, args, ann, doc, body, cl, ck, bl) =>
      if lists.any(lam(a): bind-has-name(a, fromn) end, args): e
      else: A.s-method(l, nm, ps, args, ann, doc, sub(body), cl, ck, bl)
      end
    | s-let(l, b, v, kv) => A.s-let(l, b, sub(v), kv)
    | s-var(l, b, v) => A.s-var(l, b, sub(v))
    | s-letrec(l, binds, body, bl) =>
      A.s-letrec(l, map(lam(lb): cases(A.LetrecBind) lb:
            | s-letrec-bind(bl2, bb, vv) => A.s-letrec-bind(bl2, bb, sub(vv)) end end, binds),
        sub(body), bl)
    | s-let-expr(l, binds, body, bl) =>
      A.s-let-expr(l, map(lam(lb): cases(A.LetBind) lb:
            | s-let-bind(bl2, bb, vv) => A.s-let-bind(bl2, bb, sub(vv))
            | s-var-bind(bl2, bb, vv) => A.s-var-bind(bl2, bb, sub(vv)) end end, binds),
        sub(body), bl)
    | s-when(l, test, blk, bl) => A.s-when(l, sub(test), sub(blk), bl)
    | s-for(l, it, binds, ann, body, bl) =>
      fbinds = map(lam(fb): cases(A.ForBind) fb:
          | s-for-bind(fl, bb, vv) => A.s-for-bind(fl, bb, sub(vv)) end end, binds)
      rebinds = lists.any(lam(fb): cases(A.ForBind) fb:
          | s-for-bind(_, bb, _) => bind-has-name(bb, fromn) end end, binds)
      body2 = if rebinds: body else: sub(body) end
      A.s-for(l, sub(it), fbinds, ann, body2, bl)
    | s-cases(l, typ, val, branches, bl) =>
      A.s-cases(l, typ, sub(val), map(subst-branch, branches), bl)
    | s-cases-else(l, typ, val, branches, els, bl) =>
      A.s-cases-else(l, typ, sub(val), map(subst-branch, branches), sub(els), bl)
    | s-instantiate(l, ex, params) => A.s-instantiate(l, sub(ex), params)
    | s-extend(l, supe, fields) => A.s-extend(l, sub(supe), map(subst-member, fields))
    | s-update(l, supe, fields) => A.s-update(l, sub(supe), map(subst-member, fields))
    | s-obj(l, fields) => A.s-obj(l, map(subst-member, fields))
    | s-array(l, vs) => A.s-array(l, map(sub, vs))
    | s-check-test(l, op, refi, lft, rgt, cause) =>
      A.s-check-test(l, op, refi, sub(lft),
        cases(Option) rgt: | none => none | some(x) => some(sub(x)) end, cause)
    | s-check(l, name, body, kw) => A.s-check(l, name, sub(body), kw)
    | s-check-expr(l, ex, ann) => A.s-check-expr(l, sub(ex), ann)
    | else => e
  end
end

var shadow-uid :: Number = 0
fun fresh-shadow-name(base :: String) -> String block:
  shadow-uid := shadow-uid + 1
  "$sh#" + base + "#" + tostring(shadow-uid)
end

# Desugar the non-hoisted statements (value `s-let`/`s-var` + expressions) in source
# order into a nested s-let-expr / expression list.
#
# SHADOW handling: a top-level `shadow X = val` whose `val` references X expects X to mean
# the PRIOR binding (Pyret `let`s are NON-recursive), but X is a mutable global the new
# binding OVERWRITES — so val's self-references would see the NEW binding at run time (e.g.
# infinite recursion in pprint's `shadow str = lam(s): str(s,…) end`). Fix: capture the prior
# X in a fresh global `orig` and substitute X->orig inside `val`, then bind X = val'. References
# AFTER the shadow keep using X (the new binding); references inside val see the prior one.
fun desugar-rest(stmts :: List<A.Expr>) -> List<A.Expr>:
  cases(List) stmts:
    | empty => empty
    | link(f, rest) =>
      cases(A.Expr) f:
        | s-let(ll, bind, val, _) =>
          body = stmts-to-body(desugar-rest(rest))
          is-shadow = cases(A.Bind) bind:
            | s-bind(_, shadows, nm, _) => shadows and A.is-s-name(nm)
            | else => false
          end
          if is-shadow:
            nm = bind.id
            orig-name = A.s-name(ll, fresh-shadow-name(nm.s))
            # OUTER let binds orig = (prior X); its value `X` must resolve to the prior
            # binding, so orig lives in its OWN let — NOT alongside the new X (which would
            # make `orig = X` see the new X under letrec-ish bind visibility).
            orig-bind = A.s-let-bind(ll, A.s-bind(ll, false, orig-name, A.a-blank), A.s-id(ll, nm))
            shadow-val = desugar-expr(subst-id(val, nm.s, orig-name))
            sbinds = expand-letbind(ll, A.s-bind(ll, true, nm, A.a-blank), shadow-val)
            [list: A.s-let-expr(ll, [list: orig-bind],
                A.s-let-expr(ll, sbinds, body, false), false)]
          else:
            [list: A.s-let-expr(ll, expand-letbind(ll, bind, desugar-expr(val)), body, false)]
          end
        | s-var(ll, bind, val) =>
          body = stmts-to-body(desugar-rest(rest))
          [list: A.s-let-expr(ll, [list: A.s-var-bind(ll, strip-bind(bind), desugar-expr(val))], body, false)]
        | else =>
          link(desugar-expr(f), desugar-rest(rest))
      end
  end
end

# PROGRAM-ORDER shadow resolution (runs BEFORE partition-top, on the raw surface stmts).
# A top-level `shadow X = val` must NOT reassign the mutable global X — that corrupts X for
# every fun/method/data-method defined BEFORE the shadow (e.g. pprint's `_plus` calls the raw
# 4-arg `concat` ctor, but a later `shadow concat = lam(fst,snd): fst + snd end` would make it
# read the 2-arg smart ctor -> infinite recursion). Correct Pyret semantics: `shadow X`
# introduces a NEW binding visible only to code AFTER it. We model that by alpha-renaming:
# bind a fresh name `X#k = val` and rename every later reference X -> X#k (capture-avoiding,
# via subst-id). Code before the shadow keeps the original X; the global X is never mutated.
# val itself keeps X (a non-recursive let binds the PRIOR X), and earlier shadows have already
# been forward-substituted into both val and the rest.
fun resolve-shadows(stmts :: List<A.Expr>, record :: Boolean) -> List<A.Expr> block:
  cases(List) stmts:
    | empty => empty
    | link(f, rest) =>
      info = cases(A.Expr) f:
        | s-let(ll, bind, val, kv) =>
          cases(A.Bind) bind:
            | s-bind(_, shadows, nm, _) =>
              if shadows and A.is-s-name(nm): some({ll: ll, nm: nm, val: val, kv: kv}) else: none end
            | else => none
          end
        | else => none
      end
      cases(Option) info:
        | none => link(f, resolve-shadows(rest, record))
        | some(si) =>
          fresh = A.s-name(si.ll, fresh-shadow-name(si.nm.s))
          # record top-level shadows so a cross-module `ALIAS.X` resolves to the final binding.
          when record:
            shadow-exports := link({k: si.nm.s, v: fresh.s}, shadow-exports)
          end
          new-let = A.s-let(si.ll, A.s-bind(si.ll, false, fresh, A.a-blank), si.val, si.kv)
          renamed-rest = map(lam(s): subst-id(s, si.nm.s, fresh) end, rest)
          link(new-let, resolve-shadows(renamed-rest, record))
      end
  end
end

fun desugar-stmts(stmts0 :: List<A.Expr>, top :: Boolean) -> List<A.Expr>:
  l = A.dummy-loc
  stmts = resolve-shadows(stmts0, top)
  {hoisted; rest} = partition-top(stmts, [list:], [list:])
  body = desugar-rest(rest)
  if is-empty(hoisted): body
  else: [list: A.s-letrec(l, hoisted, stmts-to-body(body), false)]
  end
end

fun desugar-program(prog :: A.Program) -> A.Program block:
  cases(A.Program) prog:
    | s-program(loc, use, prov, prov-types, provides, imports, body) =>
      shadow-exports := [list:]   # repopulated by resolve-shadows (top-level, run next)
      cases(A.Expr) body:
        | s-block(_, stmts) =>
          known-variants := collect-variant-names(stmts)
          top-globals := collect-top-globals(stmts)
        | else =>
          known-variants := [list:]
          top-globals := [list:]
      end
      new-body = cases(A.Expr) body:
        | s-block(bl, stmts) => nonempty-block(bl, desugar-stmts(stmts, true))   # module top-level
        | else => desugar-expr(body)
      end
      A.s-program(loc, use, prov, prov-types, provides, imports, new-body)
  end
end

# ── Patch provides.first for ANF (which expects a non-empty provides list) ────

fun fix-provides(prog :: A.Program) -> A.Program:
  cases(A.Program) prog:
    | s-program(l, u, p, pt, _, imports, blk) =>
      A.s-program(l, u, p, pt, [list: A.s-provide-none(l)], imports, blk)
  end
end

# ── Main compile pipeline ─────────────────────────────────────────────────────


# A minimal `data List` so `[list: ...]` (lowered to link/empty) resolves when the driver
# compiles a standalone program with no prelude merged.  HAND-BUILT as an `ast.arr` node
# (NOT re-parsed): `surface-parse` parses the host `read-source` buffer and IGNORES its
# `src` argument, so a second `surface-parse` call can't introduce new source — and it
# would also clobber the shared host parse state.  So we construct the data node directly
# and inject it into the already-parsed program.  Distinct (fresh) locs per variant avoid
# constructor table-slot collisions (the same dummy-loc hazard as lambdas).
# ── injected-List method builders (concise ast.arr constructors) ──────────────
fun lml(): S.builtin("list-method") end
fun lnm(s :: String): A.s-name(lml(), s) end
fun lid(s :: String): A.s-id(lml(), lnm(s)) end
fun lbind(s :: String): A.s-bind(lml(), false, lnm(s), A.a-blank) end
fun lcbind(s :: String): A.s-cases-bind(lml(), A.s-cases-bind-normal, lbind(s)) end
fun lcall(fn :: A.Expr, args :: List): A.s-app(lml(), fn, args) end
fun ldot(o :: A.Expr, f :: String): A.s-dot(lml(), o, f) end
fun lop(o :: String, a :: A.Expr, b :: A.Expr): A.s-op(lml(), lml(), o, a, b) end
# `cases(List) self: | empty => empty-e | link(f, r) => link-e end`
fun list-cases(scrut :: A.Expr, empty-e :: A.Expr, link-e :: A.Expr) -> A.Expr:
  A.s-cases(lml(), A.a-name(lml(), lnm("List")), scrut,
    [list:
      A.s-singleton-cases-branch(lml(), lml(), "empty", empty-e),
      A.s-cases-branch(lml(), lml(), "link", [list: lcbind("f"), lcbind("r")], link-e) ],
    false)
end
fun lshared(name :: String, argnames :: List<String>, body :: A.Expr) -> A.Member:
  A.s-method-field(lml(), name, [list:], tmap(lbind, argnames), A.a-blank, "", body, none, none, false)
end
# `sharing:` methods so `[list: ...].length()` / `.map`/`.each`/`.foldl`/`.member` work on
# the injected List. Recursion is via METHOD calls (r.length()), which the seed compiles as
# native tail/closure calls — constant stack. (first/rest are the link variant's fields.)
fun list-shared-methods() -> List:
  self-l = lid("self")
  [list:
    lshared("length", [list: "self"],
      list-cases(self-l, A.s-num(lml(), 0),
        lop("op+", A.s-num(lml(), 1), lcall(ldot(lid("r"), "length"), [list:])))),
    lshared("is-empty", [list: "self"],
      list-cases(self-l, A.s-bool(lml(), true), A.s-bool(lml(), false))),
    lshared("map", [list: "self", "fn"],
      list-cases(self-l, lid("empty"),
        lcall(lid("link"),
          [list: lcall(lid("fn"), [list: lid("f")]),
                 lcall(ldot(lid("r"), "map"), [list: lid("fn")])]))),
    lshared("each", [list: "self", "fn"],
      list-cases(self-l, lid("nothing"),
        A.s-block(lml(),
          [list: lcall(lid("fn"), [list: lid("f")]),
                 lcall(ldot(lid("r"), "each"), [list: lid("fn")])]))),
    lshared("foldl", [list: "self", "fn", "acc"],   # element-first: fn(elt, acc)
      list-cases(self-l, lid("acc"),
        lcall(ldot(lid("r"), "foldl"),
          [list: lid("fn"), lcall(lid("fn"), [list: lid("f"), lid("acc")])]))),
    lshared("member", [list: "self", "x"],
      list-cases(self-l, A.s-bool(lml(), false),
        A.s-if-else(lml(),
          [list: A.s-if-branch(lml(), lop("op==", lid("f"), lid("x")), A.s-bool(lml(), true))],
          lcall(ldot(lid("r"), "member"), [list: lid("x")]), false)))
  ]
end

fun list-data-node() -> A.Expr:
  fun loc(n :: Number): S.srcloc("list-prelude", n, 0, n, n, 0, n) end
  ml = loc(10)
  fun mem(nm :: String): A.s-variant-member(ml, A.s-normal, A.s-bind(ml, false, A.s-name(ml, nm), A.a-blank)) end
  A.s-data(loc(1), "List", [list:], [list:],
    [list:
      A.s-singleton-variant(loc(2), "empty", [list:]),
      A.s-variant(loc(3), loc(4), "link", [list: mem("first"), mem("rest")], [list:]) ],
    list-shared-methods(), none, none)
end

fun inject-list-data(prog :: A.Program) -> A.Program:
  cases(A.Program) prog:
    | s-program(l, u, p, pt, pv, im, body) =>
      dn = list-data-node()
      nb = cases(A.Expr) body:
        | s-block(bl, sts) => A.s-block(bl, link(dn, sts))
        | else => A.s-block(l, [list: dn, body])
      end
      A.s-program(l, u, p, pt, pv, im, nb)
  end
end

fun compile-source(src) -> List<Number>:
  parsed = P.surface-parse(src, "test")
  raw-ast =
    if string-contains(src, "[list:") and not(string-contains(src, "data List")):
      inject-list-data(parsed)
    else: parsed
    end
  desugared = desugar-program(raw-ast)
  fixed = fix-provides(desugared)
  aprog = ANF.anf-program(fixed)
  W.compile-prog(aprog)
end

fun do-emit(bytes) block:
  each(lam(b): emit-byte(b) end, bytes)
end

do-emit(compile-source(read-source()))
