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

# ── helpers for cases / data desugaring ──────────────────────────────────────

fun desugar-cases-branch(b) -> A.CasesBranch:
  cases(A.CasesBranch) b:
    | s-cases-branch(l, pl, name, args, body) =>
      A.s-cases-branch(l, pl, name, args.map(strip-cases-bind), desugar-expr(body))
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
      A.s-data-field(fresh-loc(), name,
        A.s-method(fresh-loc(), name, params, strip-binds(args), A.a-blank, doc, desugar-expr(body), cl, ck, bl))
    | else => m
  end
end

fun desugar-variant(v) -> A.Variant:
  cases(A.Variant) v:
    | s-variant(l, cl, vname, members, with-members) =>
      A.s-variant(l, cl, vname, members.map(strip-member), with-members.map(desugar-member))
    | s-singleton-variant(l, vname, with-members) =>
      A.s-singleton-variant(l, vname, with-members.map(desugar-member))
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

fun desugar-expr(e :: A.Expr) -> A.Expr:
  l = A.dummy-loc
  no-info = A.app-info-c(false, false)
  cases(A.Expr) e:
    | s-num(_, _)  => e
    | s-str(_, _)  => e
    | s-bool(_, _) => e
    | s-id(_, _)   => e
    | s-prim-val(_, _) => e
    | s-undefined(_) => e
    | s-srcloc(_, _) => e
    | s-id-var(_, _) => e
    | s-id-letrec(_, _, _) => e
    | s-id-modref(_, _, _, _) => e
    | s-id-var-modref(_, _, _, _) => e
    | s-ref(_, _) => e

    | s-op(loc, op-loc, op-str, lhs, rhs) =>
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
      else:
        gname = op-to-global(op-str)
        A.s-app-enriched(loc, A.s-id(loc, A.s-global(gname)),
          [list: desugar-expr(lhs), desugar-expr(rhs)], no-info)
      end

    | s-app(loc, f, args) =>
      # `print(x)` / `display(x)` are intrinsics: lower to a prim-app the backend maps to
      # the host print import (otherwise `print` resolves to an unbound global -> null).
      app-prim-name = builtin-app-name(f)
      if is-some(app-prim-name) and (args.length() == 1):
        A.s-prim-app(loc, app-prim-name.value, [list: desugar-expr(args.first)],
          A.prim-app-info-c(false))
      else:
        A.s-app-enriched(loc, desugar-expr(f), args.map(desugar-expr), no-info)
      end

    | s-app-enriched(loc, f, args, info) =>
      A.s-app-enriched(loc, desugar-expr(f), args.map(desugar-expr), info)

    | s-block(loc, stmts) =>
      nonempty-block(loc, desugar-stmts(stmts))

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

    | s-lam(loc, name, params, args, ann, doc, body, chk-loc, chk, blocky) =>
      A.s-lam(fresh-loc(), name, params, strip-binds(args), A.a-blank, doc, desugar-expr(body), chk-loc, chk, blocky)

    | s-fun(loc, name, params, args, ann, doc, body, chk-loc, chk, blocky) =>
      # s-fun in non-statement position: turn into a self-named lambda
      A.s-lam(fresh-loc(), name, params, strip-binds(args), A.a-blank, doc, desugar-expr(body), chk-loc, chk, blocky)

    | s-method(loc, name, params, args, ann, doc, body, chk-loc, chk, blocky) =>
      A.s-method(fresh-loc(), name, params, strip-binds(args), A.a-blank, doc, desugar-expr(body), chk-loc, chk, blocky)

    | s-let(loc, bind, expr, closure-val) =>
      A.s-let(loc, strip-bind(bind), desugar-expr(expr), closure-val)

    | s-let-expr(loc, binds, body, blocky) =>
      new-binds = binds.map(lam(b):
        cases(A.LetBind) b:
          | s-let-bind(bl, bind, val) => A.s-let-bind(bl, strip-bind(bind), desugar-expr(val))
          | s-var-bind(bl, bind, val) => A.s-var-bind(bl, strip-bind(bind), desugar-expr(val))
        end
      end)
      A.s-let-expr(loc, new-binds, desugar-expr(body), blocky)

    | s-letrec(loc, binds, body, blocky) =>
      new-binds = binds.map(lam(b):
        A.s-letrec-bind(b.l, strip-bind(b.b), desugar-expr(b.value))
      end)
      A.s-letrec(loc, new-binds, desugar-expr(body), blocky)

    | s-var(loc, bind, val) =>
      A.s-var(loc, strip-bind(bind), desugar-expr(val))

    | s-assign(loc, id, val) =>
      A.s-assign(loc, id, desugar-expr(val))

    | s-dot(loc, obj, field) =>
      A.s-dot(loc, desugar-expr(obj), field)

    | s-get-bang(loc, obj, field) =>
      A.s-get-bang(loc, desugar-expr(obj), field)

    | s-update(loc, obj, fields) =>
      A.s-update(loc, desugar-expr(obj), fields.map(lam(f):
        A.s-data-field(f.l, f.name, desugar-expr(f.value))
      end))

    | s-extend(loc, obj, fields) =>
      A.s-extend(loc, desugar-expr(obj), fields.map(lam(f):
        A.s-data-field(f.l, f.name, desugar-expr(f.value))
      end))

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
      args = bindings.map(lam(fb): cases(A.ForBind) fb: | s-for-bind(_, b, _) => strip-bind(b) end end)
      srcs = bindings.map(lam(fb): cases(A.ForBind) fb: | s-for-bind(_, _, v) => desugar-expr(v) end end)
      lam-e = A.s-lam(fresh-loc(), "", [list:], args, A.a-blank, "",
        desugar-expr(body), none, none, false)
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
      build-link-chain(loc, values.map(desugar-expr), no-info)

    | s-data(loc, name, params, mixins, variants, shared, chk-loc, chk) =>
      A.s-data-expr(loc, name, A.s-name(loc, name), params, mixins,
        variants.map(desugar-variant), shared.map(desugar-member), chk-loc, chk)

    | s-cases(loc, typ, val, branches, blocky) =>
      A.s-cases-else(loc, typ, desugar-expr(val),
        branches.map(desugar-cases-branch),
        A.s-prim-app(loc, "throwNoCasesMatched", [list:], A.prim-app-info-c(false)),
        blocky)

    | s-cases-else(loc, typ, val, branches, _else, blocky) =>
      A.s-cases-else(loc, typ, desugar-expr(val),
        branches.map(desugar-cases-branch), desugar-expr(_else), blocky)

    | s-paren(_, inner) => desugar-expr(inner)

    | else => e
  end
end

# ── Desugar a statement list, hoisting consecutive s-fun into s-letrec ────────

fun collect-funs(stmts):
  # Returns {fun-list; remaining-stmts} splitting at first non-s-fun
  cases(List) stmts:
    | empty => {[list:]; [list:]}
    | link(f, rest) =>
      is-sfun = A.is-s-fun(f)
      if is-sfun:
        {more-funs; remaining} = collect-funs(rest)
        {link(f, more-funs); remaining}
      else:
        {[list:]; stmts}
      end
  end
end

fun fun-to-letrec-bind(fn :: A.Expr) -> A.LetrecBind:
  cases(A.Expr) fn:
    | s-fun(fl, fname, fparams, fargs, fann, fdoc, fbody, fchk-loc, fchk, fblocky) =>
      lam-val = A.s-lam(fresh-loc(), fname, fparams, strip-binds(fargs), A.a-blank, fdoc, desugar-expr(fbody),
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

fun desugar-stmts(stmts :: List<A.Expr>) -> List<A.Expr>:
  l = A.dummy-loc
  cases(List) stmts:
    | empty => empty
    | link(f, rest) =>
      cases(A.Expr) f:
        | s-fun(_, _, _, _, _, _, _, _, _, _) =>
          # Collect a run of consecutive s-fun definitions
          {funs; remaining} = collect-funs(stmts)
          letrec-binds = funs.map(fun-to-letrec-bind)
          remaining-desugared = desugar-stmts(remaining)
          [list: A.s-letrec(l, letrec-binds, stmts-to-body(remaining-desugared), false)]
        | s-data(dl, dname, _, _, variants, _, _, _) =>
          # bind the data object to a fresh name, then bind each constructor name to
          # its field of that object (so bare `ctor(args)` / cases over it resolve).
          data-expr = desugar-expr(f)   # -> s-data-expr
          objname = "$data$" + dname
          obj-id = A.s-id(dl, A.s-name(dl, objname))
          data-bind = A.s-let-bind(dl, A.s-bind(dl, false, A.s-name(dl, objname), A.a-blank), data-expr)
          ctor-binds = variants.map(lam(v):
            vn = surface-variant-name(v)
            A.s-let-bind(dl, A.s-bind(dl, false, A.s-name(dl, vn), A.a-blank),
              A.s-dot(dl, obj-id, vn))
          end)
          body = stmts-to-body(desugar-stmts(rest))
          [list: A.s-let-expr(dl, link(data-bind, ctor-binds), body, false)]
        | s-let(ll, bind, val, _) =>
          # top-level `x = e` → s-let-expr binding x over the remaining statements
          body = stmts-to-body(desugar-stmts(rest))
          [list: A.s-let-expr(ll, [list: A.s-let-bind(ll, strip-bind(bind), desugar-expr(val))], body, false)]
        | s-var(ll, bind, val) =>
          # top-level `var x = e` → s-let-expr with a var-bind over the rest
          body = stmts-to-body(desugar-stmts(rest))
          [list: A.s-let-expr(ll, [list: A.s-var-bind(ll, strip-bind(bind), desugar-expr(val))], body, false)]
        | s-type(_, _, _, _) => desugar-stmts(rest)        # type alias: erased
        | s-newtype(_, _, _) => desugar-stmts(rest)        # newtype: erased
        | else =>
          link(desugar-expr(f), desugar-stmts(rest))
      end
  end
end

fun desugar-program(prog :: A.Program) -> A.Program:
  cases(A.Program) prog:
    | s-program(loc, use, prov, prov-types, provides, imports, body) =>
      new-body = cases(A.Expr) body:
        | s-block(bl, stmts) => nonempty-block(bl, desugar-stmts(stmts))
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
fun list-data-node() -> A.Expr:
  fun loc(n :: Number): S.srcloc("list-prelude", n, 0, n, n, 0, n) end
  ml = loc(10)
  fun mem(nm :: String): A.s-variant-member(ml, A.s-normal, A.s-bind(ml, false, A.s-name(ml, nm), A.a-blank)) end
  A.s-data(loc(1), "List", [list:], [list:],
    [list:
      A.s-singleton-variant(loc(2), "empty", [list:]),
      A.s-variant(loc(3), loc(4), "link", [list: mem("first"), mem("rest")], [list:]) ],
    [list:], none, none)
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
