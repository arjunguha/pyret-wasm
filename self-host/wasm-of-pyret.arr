provide *
# wasm-of-pyret: the ANF -> WebAssembly backend for the self-hosted compiler. It
# REPLACES js-of-pyret.arr — instead of emitting JS, it walks Pyret's A-Normal-Form IR
# (ast-anf.arr) and emits a WASM-GC module via encoder.arr, on top of the value model /
# runtime emitted by runtime.arr. Mirrors the STRUCTURE of anf-loop-compiler.arr /
# js-of-pyret.arr (the real backend) so later diffing is easy.
#
# STATUS: faithful structural port. The value-model leaf forms (num/bool/str/tuple/obj/
# dot/var-cell/assign) emit real encoder bytes against the runtime's GC type indices.
# Now ALSO ported: closure free-var CAPTURE (lambdas pack their free vars into the
# $Closure env and read them back from the env inside the body — boxed `var`s capture the
# box so mutation is shared), a-data-expr CONSTRUCTOR emission (one table function per
# variant building a $Variant, plus the $variant_names global), the prim-app dispatch
# table (equality/raw-array/type-predicates/string-to-code-point), inline $truthy, and
# singleton constructors as VALUES.  `$raise` is now a real call to the host `raise`
# import: the funcidx space is [host imports ++ runtime ++ lambdas ++ ctors ++ main], so
# imports occupy the lowest indices and every defined-function reference is offset by
# NUM-IMPORTS (centralized in runtime.arr's num-host-imports).  Most runtime kernels are
# still `todo()` stubs, so a compiled module does not RUN end-to-end yet; this emits
# faithful bytes for the structure above.

import encoder as E
import ast-anf as N
import ast as A
import runtime as R

# ===== GC type indices (must match types.ts / runtime.arr's rec-group order) =====
T-LIMBS = 0
T-NUM = 1
T-FIX = 2
T-RAT = 3
T-ROUGH = 4
T-BIG = 5
T-STR = 6
T-FIELDS = 7        # (array (mut anyref)) — also the boxed-var 1-cell
T-VARIANT = 8       # (struct i32 id, (ref $Str) name, (ref $Fields) fields)
T-CLOSURE = 9       # (struct i32 fnIndex, (ref null $Fields) caps)
T-NAMES = 10        # (array (ref $Str))
T-OBJECT = 11       # (struct (ref $Names), (ref $Fields))
T-METHOD = 12       # (struct (ref $Closure))
ANYREF-BT = [list: 110]   # blocktype: single anyref result
I31-HT = 108              # the i31 abstract heaptype byte (== i31ref value-type byte)
EQREF-HT = 109            # the eq abstract heaptype byte (== eqref value-type byte)

# ===== runtime-function indices =====
# The function index space is [HOST IMPORTS ++ runtime fns ++ user lambdas ++ variant
# ctors ++ main]. Imports occupy the lowest funcidxs (wasm requires imports first), so
# EVERY defined-function reference is offset by NUM-IMPORTS. `rt-index(name)` is a runtime
# fn's POSITION in build-runtime(); `rt-funcidx(name)` adds the import offset to get the
# real funcidx for a `call`. Host imports are called by their import index (host-funcidx).
NUM-GC-TYPES = 13
RT-FUNS = R.build-runtime()
NUM-IMPORTS = R.num-host-imports
fun rt-index(name :: String) -> Number: rt-index-from(RT-FUNS, name, 0) end
fun rt-index-from(fs, name :: String, i :: Number) -> Number:
  cases(List) fs:
    | empty => raise("wasm-of-pyret: no runtime fn named " + name)
    | link(f, r) => if f.name == name: i else: rt-index-from(r, name, i + 1) end
  end
end
# real funcidx of a runtime fn (= import block + its position).
fun rt-funcidx(name :: String) -> Number: NUM-IMPORTS + rt-index(name) end
# funcidx of a host import (lives in the low import block; no offset).
fun host-funcidx(name :: String) -> Number: R.host-import-index(name) end
fun idx-make-fix(): rt-funcidx("$make_fix") end
fun idx-make-rough(): rt-funcidx("$make_rough") end
fun idx-make-rat(): rt-funcidx("$make_rat") end
fun idx-make-object(): rt-funcidx("$make_object") end
fun idx-obj-get(): rt-funcidx("$obj_get") end
fun idx-obj-extend(): rt-funcidx("$obj_extend") end
fun idx-variant-field-by-name(): rt-funcidx("$variant_field_by_name") end
fun idx-variant-id(): rt-funcidx("$variant_id") end
fun idx-num-to-i32(): rt-funcidx("$num_to_i32") end

# bools/nothing are i31 (true=1,false=0,nothing=2). $truthy is inlined: cast to i31 then
# i31.get_s, leaving an i32 the `if` consumes (mirrors compile.ts's truthy()).
fun truthy-instr() -> List<Number>: E.ref-cast(I31-HT).append(E.i31-get-s) end
# $raise(ptr,len) host import: host throws a PyretError, never returns. We pass an empty
# message span (0,0) for now (TODO(port): write the real message into scratch memory),
# then `unreachable` so the surrounding (anyref-typed) block still validates.
fun raise-instr() -> List<Number>:
  E.i32-const(0).append(E.i32-const(0)).append(E.i-call(host-funcidx("raise"))).append(E.i-unreachable)
end
# wrap an i32 (0/1) bool on the stack into a Pyret boolean (i31). (mirrors mkBool.)
fun to-bool() -> List<Number>: E.ref-i31 end

# prim-app names the front-end throws for failed control flow (desugar.arr). They abort.
throw-prims :: List<String> = [list:
  "throwNoBranchesMatched", "throwNoCasesMatched", "throwNonBooleanCondition",
  "throwNonBooleanOp", "throwUnfinishedTemplate" ]

# ===== compile context =====
# locals: List<{k; i}> A.Name-key -> wasm local index. vars: keys that are BOXED (a-var)
# so a-id-var/a-assign go through the 1-cell. fenv: reserved. lams: List<{k; i; fvs}>
# lambda-loc-key -> {fnIndex(=table slot); ordered free-var keys}, from collect-lambdas.
# dreg: List<{name; id; arity; fields}> the data registry (variant-name -> global id, field
# count, field names) from collect-data, used by a-cases dispatch + a-data-expr + the
# $variant_names global. gvars: every key bound by an a-var anywhere (names are unique post
# resolve-scope) so capture knows to grab the BOX. nlams: lambda count, so a-data-expr can
# compute a ctor's table slot (= nlams + variant.id).
data Ctx: ctx(locals, next-local :: Number, vars, fenv, lams, dreg, gvars, nlams :: Number) end
# loc-independent identity. Only s-name carries a loc (the reason the dummy-loc shim
# existed); other Names + non-Name values are already loc-free under tostring. Guard with
# is-s-name (null-safe) so a non-Name (e.g. a tuple-bind's absent .id) falls back like the
# old tostring instead of crashing on a missing .key(). (Loc-independent for s-name, which
# is what the injected-List link/empty resolution needs.)
fun name-key(n): if A.is-s-name(n): "name#" + n.s else: tostring(n) end end
fun bind-local(c :: Ctx, key, idx :: Number) -> Ctx block:
  max-local-used := num-max(max-local-used, idx + 1)
  ctx(link({k: key, i: idx, v: false}, c.locals), num-max(c.next-local, idx + 1), c.vars, c.fenv, c.lams, c.dreg, c.gvars, c.nlams)
end
fun bind-var(c :: Ctx, key, idx :: Number) -> Ctx block:
  max-local-used := num-max(max-local-used, idx + 1)
  ctx(link({k: key, i: idx, v: true}, c.locals), num-max(c.next-local, idx + 1), link(key, c.vars), c.fenv, c.lams, c.dreg, c.gvars, c.nlams)
end
fun is-var(c :: Ctx, key) -> Boolean: c.vars.member(key) end
fun lookup-local-opt(c :: Ctx, key):
  find-pair-opt(c.locals, key)
end
# Like lookup-local-opt but returns the WHOLE entry {k; i; v} of the FIRST (newest, so
# shadowing-aware) match. Reads use THIS entry's `v` (is-it-a-box) flag rather than the
# name-keyed `is-var`: when a plain `let` shadows a `var`/letrec-bound name of the same name
# (anf lowers a hoisted `fun g` to a `var g`, then `shadow g = <let>`), `is-var` stays true
# for the name but the shadow's entry has v=false, so the read must local-get, not box-read.
fun lookup-ventry-opt(c :: Ctx, key):
  fun go(ps):
    cases(List) ps:
      | empty => none
      | link(f, r) => if f.k == key: some(f) else: go(r) end
    end
  end
  go(c.locals)
end
fun find-pair-opt(ps, key):
  cases(List) ps:
    | empty => none
    | link(f, r) => if f.k == key: some(f.i) else: find-pair-opt(r, key) end
  end
end
fun lookup-local(c :: Ctx, key) -> Number:
  cases(Option) lookup-local-opt(c, key):
    | none => raise("wasm-of-pyret: unbound local " + key)
    | some(i) => i
  end
end
# top-level/global resolution: the `fenv` Ctx slot carries the global map
# (List<{k; gi}>: top-level binding key -> wasm global index). Top-level bindings are
# mirrored into mutable anyref globals so lambdas (which do NOT capture top-level names)
# resolve them by global.get — enabling forward/mutually-recursive top-level reference.
fun gmap-lookup(c :: Ctx, key):
  find-gi(c.fenv, key)
end
fun find-gi(ps, key):
  cases(List) ps:
    | empty => none
    | link(f, r) => if f.k == key: some(f.gi) else: find-gi(r, key) end
  end
end
# resolve an id that is NOT a local: global.get if top-level, else null. (TODO(port):
# module-qualified refs.)
fun resolve-nonlocal(c :: Ctx, key) -> List<Number>:
  cases(Option) gmap-lookup(c, key):
    | some(gi) => E.global-get(gi)
    | none => E.i-ref-null(110)
  end
end
# if `key` is a top-level global, mirror the just-bound local `idx` into it.
fun mirror-global(c :: Ctx, key, idx :: Number) -> List<Number>:
  cases(Option) gmap-lookup(c, key):
    | none => empty
    | some(gi) => E.local-get(idx).append(E.global-set(gi))
  end
end
# variant-name -> {id; arity; fields} option, from the data registry.
fun data-lookup(c :: Ctx, name :: String): dreg-find(c.dreg, name) end
fun dreg-find(ds, name :: String):
  cases(List) ds:
    | empty => none
    | link(f, r) => if f.name == name: some(f) else: dreg-find(r, name) end
  end
end
# lambda-loc-key -> its collected {k; i(fnIndex); fvs}.
fun lookup-lam-pair(ps, key):
  cases(List) ps:
    | empty => raise("wasm-of-pyret: lambda not collected " + key)
    | link(f, r) => if f.k == key: f else: lookup-lam-pair(r, key) end
  end
end

# ===== free-var analysis (for closure capture) =====
# fv-* return ordered, de-duplicated lists of A.Name keys referenced but not bound within.
fun fv-union(a, b):
  cases(List) b:
    | empty => a
    | link(f, r) => fv-union(if a.member(f): a else: a.append([list: f]) end, r)
  end
end
fun fv-subtract(a, ks): a.filter(lam(x): not(ks.member(x)) end) end
# Primitive intrinsic globals (handled by compile-intrinsic) have NO runtime value, so they
# must never be captured as a lambda free var — else the body would bind them as a (null)
# local, shadowing the intrinsic dispatch. (Matches the seed treating these as call-only.)
intrinsic-names :: List<String> = [list:
  "tostring", "to-string", "torepr", "to-repr", "string-length",
  "string-to-code-points", "string-from-code-point", "string-to-code-point",
  "num-modulo", "num-quotient", "num-expt", "num-to-roughnum", "num-is-roughnum",
  "num-floor", "num-ceiling", "num-round", "num-is-integer", "num-to-rational",
  "prim-raw-array-get", "prim-raw-array-set", "prim-raw-array-length", "prim-raw-array-of",
  "time-now", "read-source", "emit-byte",
  # CPS stoppability intrinsics (call-only; lowered in compile-cps-intrinsic). Like the
  # other intrinsics they have NO runtime value, so excluding them from lambda captures
  # is essential — otherwise a CPS'd body (every fn body is `yield-check(lam(): ... end)`)
  # would bind them as null caps, bypass the dispatch, and null-trap on call.
  "yield-check", "finish-result",
  "cps-op-plus", "cps-op-minus", "cps-op-times", "cps-op-divide",
  "cps-op-lessthan", "cps-op-greaterthan", "cps-op-lessequal", "cps-op-greaterequal" ]
fun name-is-intrinsic(id) -> Boolean:
  cases(A.Name) id:
    | s-name(_, s) => intrinsic-names.member(s)
    | s-global(s) => intrinsic-names.member(s)
    | else => false
  end
end
fun fv-val(v):
  cases(N.AVal) v:
    | a-id(_, id) => if name-is-intrinsic(id): empty else: [list: name-key(id)] end
    | a-id-safe-letrec(_, id) => [list: name-key(id)]
    | else => empty
  end
end
fun fv-vals(vs):
  cases(List) vs:
    | empty => empty
    | link(f, r) => fv-union(fv-val(f), fv-vals(r))
  end
end
fun fv-fields(fields): fv-vals(fields.map(lam(f): f.value end)) end
fun arg-keys(args): args.map(lam(a): name-key(a.id) end) end
fun branch-arg-keys(br):
  cases(N.ACasesBranch) br:
    | a-cases-branch(_, _, _, args, _) => args.map(lam(cb): name-key(cb.bind.id) end)
    | a-singleton-cases-branch(_, _, _, _) => empty
  end
end
fun fv-branches(branches):
  cases(List) branches:
    | empty => empty
    | link(br, r) =>
      fv-union(fv-subtract(fv-expr(branch-body(br)), branch-arg-keys(br)), fv-branches(r))
  end
end
fun fv-lettable(lt):
  cases(N.ALettable) lt:
    | a-val(_, v) => fv-val(v)
    | a-id-var(_, id) => [list: name-key(id)]
    | a-id-letrec(_, id, _) => [list: name-key(id)]
    | a-id-var-modref(_, _, _, _) => empty
    | a-app(_, f, args, _) => fv-union(fv-val(f), fv-vals(args))
    | a-prim-app(_, _, args, _) => fv-vals(args)
    | a-if(_, cnd, t, e) => fv-union(fv-val(cnd), fv-union(fv-expr(t), fv-expr(e)))
    | a-lam(_, _, args, _, body) => fv-subtract(fv-expr(body), arg-keys(args))
    | a-method(_, _, args, _, body) => fv-subtract(fv-expr(body), arg-keys(args))
    | a-obj(_, fields) => fv-fields(fields)
    | a-extend(_, supe, fields) => fv-union(fv-val(supe), fv-fields(fields))
    | a-update(_, supe, fields) => fv-union(fv-val(supe), fv-fields(fields))
    | a-dot(_, obj, _) => fv-val(obj)
    | a-colon(_, obj, _) => fv-val(obj)
    | a-get-bang(_, obj, _) => fv-val(obj)
    | a-tuple(_, fields) => fv-vals(fields)
    | a-tuple-get(_, tup, _) => fv-val(tup)
    | a-cases(_, _, val, branches, els) => fv-union(fv-val(val), fv-union(fv-expr(els), fv-branches(branches)))
    | a-assign(_, id, value) => fv-union([list: name-key(id)], fv-val(value))
    | a-method-app(_, obj, _, args) => fv-union(fv-val(obj), fv-vals(args))
    | a-data-expr(_, _, _, _, _) => empty   # TODO(port): with-members/shared free vars
    | a-ref(_, _) => empty
    | a-module(_, _, _, _, _, _, _) => empty
  end
end
fun fv-expr(e):
  cases(N.AExpr) e:
    | a-let(_, b, lt, body) => fv-union(fv-lettable(lt), fv-subtract(fv-expr(body), [list: name-key(b.id)]))
    | a-var(_, b, lt, body) => fv-union(fv-lettable(lt), fv-subtract(fv-expr(body), [list: name-key(b.id)]))
    | a-seq(_, e1, e2) => fv-union(fv-lettable(e1), fv-expr(e2))
    | a-lettable(_, lt) => fv-lettable(lt)
    | a-type-let(_, _, body) => fv-expr(body)
    | a-arr-let(_, b, _, lt, body) => fv-union(fv-lettable(lt), fv-subtract(fv-expr(body), [list: name-key(b.id)]))
  end
end
fun fv-of-lam(args, body): fv-subtract(fv-expr(body), arg-keys(args)) end

# ===== a $Str (array i8) from a Pyret string's code points =====
fun emit-str(s :: String) -> List<Number>:
  cps = string-to-code-points(s)
  E.concat-bytes(cps.map(lam(cp): E.i32-const(cp) end)).append(E.array-new-fixed(T-STR, length(cps)))
end
# read the boxed-var 1-cell at local `idx` -> its value
fun box-read(idx :: Number) -> List<Number>:
  # cast anyref local to (ref $Fields) before array.get (WASM requires the concrete type)
  E.local-get(idx).append(E.ref-cast(T-FIELDS)).append(E.i32-const(0)).append(E.array-get(T-FIELDS))
end
# load a free var's CURRENT value at a capture site. For a `var` the local already holds the
# 1-cell BOX, so the box (not the value) is captured -> shared mutation. A name not bound as a
# local (e.g. a top-level def) captures as null. TODO(port).
#
# bind-caps (in the lambda) decides box-vs-plain for a capture by GLOBAL gvars membership,
# which is keyed by surface name and so conflates a plain local with a same-named top-level
# var (e.g. a cases-branch param `field` shadowing a top-level `field` def). When that happens
# bind-caps will box-READ the capture, so here we must pack a BOX: a real var (e.v) already
# holds its box (pass it for shared mutation), but a plain local holds a value -> wrap it in a
# fresh 1-cell box so the box-read in the lambda recovers the value (no shared mutation needed
# since the shadowing local is a let, not a var).
fun load-capture(c :: Ctx, key) -> List<Number>:
  cases(Option) lookup-ventry-opt(c, key):
    | none => E.i-ref-null(110)
    | some(e) =>
      if c.gvars.member(key) and not(e.v):
        E.local-get(e.i).append(E.array-new-fixed(T-FIELDS, 1))
      else:
        E.local-get(e.i)
      end
  end
end

# Smallest denominator d>=1 making n*d an exact integer. n is an exact non-integer
# rational; since n is already reduced this yields the REDUCED num/den (num = n*d).
# (num-numerator/num-denominator aren't seed builtins, hence this minimal-den search.)
fun find-min-den(n, d :: Number) -> Number:
  if num-is-integer(n * d): d else: find-min-den(n, d + 1) end
end

# ===== AVal -> instructions (leaves one anyref on the stack) =====
fun compile-aval(v, c :: Ctx) -> List<Number>:
  cases(N.AVal) v:
    | a-num(l, n) =>
      # roughnum literal (~3.14) -> $make_rough(f64); exact integer -> $make_fix(i64);
      # exact non-integer (rational, e.g. 1/2, 3.14=157/50) -> $make_rat($make_fix(num),
      # $make_fix(den)) with the reduced num/den from the minimal-denominator search.
      # (Bignum literals beyond i64 are still TODO(port): need $Bignum limbs.)
      if num-is-roughnum(n): E.f64-const(n).append(E.i-call(idx-make-rough()))
      else if num-is-integer(n): E.i64-const(n).append(E.i-call(idx-make-fix()))
      else:
        den = find-min-den(n, 1)
        num = n * den                            # exact integer (n is reduced -> so are num/den)
        E.i64-const(num).append(E.i-call(idx-make-fix()))
          .append(E.i64-const(den)).append(E.i-call(idx-make-fix()))
          .append(E.i-call(idx-make-rat()))
      end
    | a-str(l, s) => emit-str(s)
    | a-bool(l, b) => E.i32-const(if b: 1 else: 0 end).append(E.ref-i31)
    | a-id(l, id) =>
      k = name-key(id)
      cases(Option) lookup-ventry-opt(c, k):                                 # per-entry v (shadowing-aware)
        | none => resolve-nonlocal(c, k)                                     # top-level global, else null
        | some(e) => if e.v: box-read(e.i) else: E.local-get(e.i) end
      end
    | a-id-safe-letrec(l, id) =>                                             # letrec-safe read: same as a-id
      k = name-key(id)
      cases(Option) lookup-local-opt(c, k):
        | none => resolve-nonlocal(c, k)
        | some(i) => E.local-get(i)
      end
    | a-id-modref(l, id, uri, name) => E.i-ref-null(110)                    # TODO(port): module ref
    | a-srcloc(l, loc) => E.i-ref-null(110)                                  # TODO(port): srcloc value
    | a-undefined(l) => E.i-ref-null(110)
    | a-prim-val(l, name) => E.i-ref-null(110)                              # TODO(port): primitive globals
  end
end

fun compile-avals(vs, c :: Ctx) -> List<Number>:
  E.concat-bytes(vs.map(lam(v): compile-aval(v, c) end))
end
# pack a list of already-on-stack values into a $Fields array (caller pushed them)
fun pack-fields(vs, c :: Ctx) -> List<Number>:
  compile-avals(vs, c).append(E.array-new-fixed(T-FIELDS, length(vs)))
end
# pack a list of already-compiled instruction sequences into a $Fields array.
fun pack-instrs(parts :: List<List<Number>>) -> List<Number>:
  E.concat-bytes(parts).append(E.array-new-fixed(T-FIELDS, length(parts)))
end
# a $Names array of $Str from field records (each with .name)
fun emit-names(flds) -> List<Number>:
  E.concat-bytes(flds.map(lam(f): emit-str(f.name) end)).append(E.array-new-fixed(T-NAMES, length(flds)))
end
# a $Names array from a plain list of field-name strings
fun emit-names-of(names) -> List<Number>:
  E.concat-bytes(names.map(lam(nm): emit-str(nm) end)).append(E.array-new-fixed(T-NAMES, length(names)))
end

# ===== prim-app dispatch =====
# Mirrors the seed's intrinsic ladder (compile.ts buildPrimApp): the raw-array library,
# value-model type predicates, equality, and string-to-code-point lower to inline GC ops +
# runtime calls; control-flow throw-prims and the unmapped tail call the $raise host import.
# Each branch leaves ONE anyref on the stack.  Args are $Num/anyref AVals.
fun prim-type-test(args, c :: Ctx, t :: Number) -> List<Number>:
  compile-aval(args.first, c).append(E.ref-test-null(t)).append(to-bool())
end
fun compile-prim-app(fname :: String, args, c :: Ctx) -> List<Number>:
  ask:
    # ---- equality ----
    | (fname == "equal-always") or (fname == "equal-now") then:
      compile-avals(args, c).append(E.i-call(rt-funcidx("$equal"))).append(to-bool())
    | fname == "identical" then:
      compile-aval(args.first, c).append(E.ref-cast(EQREF-HT))
        .append(compile-aval(args.rest.first, c)).append(E.ref-cast(EQREF-HT))
        .append(E.ref-eq).append(to-bool())
    | fname == "not" then:
      compile-aval(args.first, c).append(truthy-instr()).append(E.i32-eqz).append(to-bool())
    # ---- raw arrays = a $Fields (array (mut anyref)) ----
    | (fname == "raw-array-get") or (fname == "prim-raw-array-get") then:
      compile-aval(args.first, c).append(E.ref-cast(T-FIELDS))
        .append(compile-aval(args.rest.first, c)).append(E.i-call(idx-num-to-i32()))
        .append(E.array-get(T-FIELDS))
    | (fname == "raw-array-length") or (fname == "prim-raw-array-length") then:
      compile-aval(args.first, c).append(E.ref-cast(T-FIELDS)).append(E.array-len)
        .append(E.i64-extend-i32-u).append(E.i-call(idx-make-fix()))
    | (fname == "raw-array-set") or (fname == "prim-raw-array-set") then:
      a = c.next-local                                  # stash array; assignment returns it
      compile-aval(args.first, c).append(E.local-set(a))
        .append(E.local-get(a)).append(E.ref-cast(T-FIELDS))
        .append(compile-aval(args.rest.first, c)).append(E.i-call(idx-num-to-i32()))
        .append(compile-aval(args.rest.rest.first, c))
        .append(E.array-set(T-FIELDS))
        .append(E.local-get(a))
    | (fname == "raw-array-of") or (fname == "prim-raw-array-of") then:
      # array.new $Fields : [init, i32 count] -> arrayref  (init = elt, count = n)
      compile-aval(args.first, c)
        .append(compile-aval(args.rest.first, c)).append(E.i-call(idx-num-to-i32()))
        .append(E.array-new(T-FIELDS))
    # ---- the byte code point of a 1-char string ----
    | fname == "string-to-code-point" then:
      compile-aval(args.first, c).append(E.ref-cast(T-STR))
        .append(E.i32-const(0)).append(E.array-get-u(T-STR))
        .append(E.i64-extend-i32-u).append(E.i-call(idx-make-fix()))
    # ---- value-model type predicates (ref.test the runtime representation) ----
    | fname == "is-string" then: prim-type-test(args, c, T-STR)
    | fname == "is-number" then: prim-type-test(args, c, T-NUM)
    | fname == "is-function" then: prim-type-test(args, c, T-CLOSURE)
    | fname == "is-object" then: prim-type-test(args, c, T-OBJECT)
    | fname == "is-raw-array" then: prim-type-test(args, c, T-FIELDS)
    # ---- check harness: bump $passed/$total, report failures to the host ----
    # $check_is/$check_is_not take (lhs, rhs) and return nothing; push a nothing
    # (null anyref) so the lettable leaves exactly one value.
    | fname == "check-is" then:
      compile-avals(args, c).append(E.i-call(rt-funcidx("$check_is"))).append(E.i-ref-null(110))
    | fname == "check-is-not" then:
      compile-avals(args, c).append(E.i-call(rt-funcidx("$check_is_not"))).append(E.i-ref-null(110))
    # ---- print/display: render the value to SCRATCH-OFFSET, call the host print
    #      import (addr, len), and return the printed value (Pyret's print is identity) ----
    | (fname == "print") or (fname == "display") then:
      v = c.next-local
      compile-aval(args.first, c).append(E.local-set(v))
        .append(E.i32-const(R.SCRATCH-OFFSET))                       # addr (under the len)
        .append(E.local-get(v)).append(E.i-call(rt-funcidx("$val_to_string")))  # -> len
        .append(E.i-call(host-funcidx("print")))                    # print(addr, len)
        # Force a yield right after printing: zero $gas so the NEXT yield-check pauses
        # immediately. In CPS'd (stoppable) code the trampoline then yields to the event
        # loop — the browser renders this line and Stop is serviced before the next print.
        # In non-CPS code there are no yield-checks, so this is a harmless global write.
        .append(E.i32-const(0)).append(E.global-set(R.GI-GAS))
        .append(E.local-get(v))                                     # result = the value
    # ---- control-flow aborts + the unmapped tail -> $raise host import ----
    | throw-prims.member(fname) then: raise-instr()
    | otherwise: raise-instr()   # TODO(port): makeArrayN, getMaker*, getColonField, getBracket, makeSome/None, run-task...
  end
end

# ===== runtime intrinsics (mirrors the seed's compile.ts compileIntrinsic ladder) =====
# Primitive globals that are NOT user-defined funs: string-length, num-modulo, the
# prim-raw-array-* kernels, tostring, read-source, the num tower ops, … The driver lowers
# these as plain s-app(s-id(s-global NAME), args); they'd otherwise resolve to a NULL global
# (resolve-nonlocal) and trap. Each branch leaves ONE anyref. Returns none if NAME is unknown,
# so the a-app caller falls back to the closure-calling convention.
fun as-num(v, c :: Ctx) -> List<Number>:
  compile-aval(v, c).append(E.ref-cast(T-NUM))
end
# round/floor/ceiling: exact in -> exact integer ($make_fix); roughnum (tag 2) -> roughnum.
fun compile-round(op :: String, arg, c :: Ctx) -> List<Number>:
  v = c.next-local
  c2 = ctx(c.locals, c.next-local + 1, c.vars, c.fenv, c.lams, c.dreg, c.gvars, c.nlams)
  f64op = ask:
    | op == "ceil" then: E.f64-ceil
    | op == "nearest" then: E.f64-nearest
    | otherwise: E.f64-floor
  end
  get-num = E.local-get(v).append(E.ref-cast(T-NUM))
  the-f64 = get-num.append(E.i-call(rt-funcidx("$to_f64"))).append(f64op)   # f64
  E.concat-bytes([list:
    compile-aval(arg, c2), E.local-set(v),
    get-num, E.struct-get(T-NUM, 0), E.i32-const(2), E.i32-eq, E.i-if(ANYREF-BT),
    the-f64, E.i-call(idx-make-rough()),
    E.i-else,
    the-f64, E.i64-trunc-f64-s, E.i-call(idx-make-fix()),
    E.i-end])
end
# num-is-integer: fix(0)/bignum(3) -> true; rough(2) and floor(f)==f -> true; rational -> false.
fun compile-num-is-integer(arg, c :: Ctx) -> List<Number>:
  v = c.next-local
  c2 = ctx(c.locals, c.next-local + 1, c.vars, c.fenv, c.lams, c.dreg, c.gvars, c.nlams)
  get-num = E.local-get(v).append(E.ref-cast(T-NUM))
  tag = get-num.append(E.struct-get(T-NUM, 0))
  f = get-num.append(E.i-call(rt-funcidx("$to_f64")))
  floor-eq = f.append(E.f64-floor).append(f).append(E.f64-eq)             # floor(f) == f
  rough-int = tag.append(E.i32-const(2)).append(E.i32-eq).append(floor-eq).append(E.i32-and)
  E.concat-bytes([list:
    compile-aval(arg, c2), E.local-set(v),
    tag, E.i32-const(0), E.i32-eq,
    tag, E.i32-const(3), E.i32-eq, E.i32-or,
    rough-int, E.i32-or,
    to-bool()])
end
# num-to-rational: exact passthrough; roughnum -> nearest exact integer (best-effort).
fun compile-num-to-rational(arg, c :: Ctx) -> List<Number>:
  v = c.next-local
  c2 = ctx(c.locals, c.next-local + 1, c.vars, c.fenv, c.lams, c.dreg, c.gvars, c.nlams)
  get-num = E.local-get(v).append(E.ref-cast(T-NUM))
  E.concat-bytes([list:
    compile-aval(arg, c2), E.local-set(v),
    get-num, E.struct-get(T-NUM, 0), E.i32-const(2), E.i32-eq, E.i-if(ANYREF-BT),
    get-num, E.i-call(rt-funcidx("$to_f64")), E.f64-nearest, E.i64-trunc-f64-s, E.i-call(idx-make-fix()),
    E.i-else,
    E.local-get(v),
    E.i-end])
end
fun compile-intrinsic(name :: String, args, c :: Ctx) -> Option:
  ask:
    | (name == "tostring") or (name == "to-string") or (name == "torepr") or (name == "to-repr") then:
      # render to SCRATCH ($val_to_string -> len), then copy back into a $Str.
      some(E.i32-const(R.SCRATCH-OFFSET)
        .append(compile-aval(args.first, c)).append(E.i-call(rt-funcidx("$val_to_string")))
        .append(E.i-call(rt-funcidx("$str_from_mem"))))
    | name == "string-length" then:
      some(compile-aval(args.first, c).append(E.ref-cast(T-STR)).append(E.i-call(rt-funcidx("$string_length"))))
    | name == "string-to-code-points" then:
      some(compile-aval(args.first, c).append(E.ref-cast(T-STR)).append(E.i-call(rt-funcidx("$str_to_codepoints"))))
    | name == "string-from-code-point" then:
      some(compile-aval(args.first, c).append(E.i-call(idx-num-to-i32())).append(E.array-new-fixed(T-STR, 1)))
    | name == "string-to-code-point" then: some(compile-prim-app("string-to-code-point", args, c))
    | name == "num-modulo" then:
      some(as-num(args.first, c).append(as-num(args.rest.first, c)).append(E.i-call(rt-funcidx("$num_modulo"))))
    | name == "num-quotient" then:
      some(as-num(args.first, c).append(as-num(args.rest.first, c)).append(E.i-call(rt-funcidx("$num_quotient"))))
    | name == "num-expt" then:
      some(as-num(args.first, c).append(as-num(args.rest.first, c)).append(E.i-call(rt-funcidx("$num_expt"))))
    | name == "num-to-roughnum" then:
      some(as-num(args.first, c).append(E.i-call(rt-funcidx("$to_f64"))).append(E.i-call(idx-make-rough())))
    | name == "num-is-roughnum" then:
      some(as-num(args.first, c).append(E.struct-get(T-NUM, 0)).append(E.i32-const(2)).append(E.i32-eq).append(to-bool()))
    | name == "num-floor" then: some(compile-round("floor", args.first, c))
    | name == "num-ceiling" then: some(compile-round("ceil", args.first, c))
    | name == "num-round" then: some(compile-round("nearest", args.first, c))
    | name == "num-is-integer" then: some(compile-num-is-integer(args.first, c))
    | name == "num-to-rational" then: some(compile-num-to-rational(args.first, c))
    | (name == "prim-raw-array-get") or (name == "prim-raw-array-set")
        or (name == "prim-raw-array-length") or (name == "prim-raw-array-of") then:
      some(compile-prim-app(name, args, c))
    | name == "time-now" then:
      some(E.i64-const(0).append(E.i-call(idx-make-fix())))
    | name == "read-source" then:
      # ask the host to write the program source into SCRATCH, then copy into a $Str.
      some(E.i32-const(R.SCRATCH-OFFSET).append(E.i32-const(R.SCRATCH-OFFSET))
        .append(E.i-call(host-funcidx("read_source_into"))).append(E.i-call(rt-funcidx("$str_from_mem"))))
    | name == "emit-byte" then:
      some(compile-aval(args.first, c).append(E.i-call(idx-num-to-i32()))
        .append(E.i-call(host-funcidx("emit_byte"))).append(E.i32-const(2)).append(E.ref-i31))
    | otherwise: none
  end
end
# Extract the bare callee name of an a-id to a free global/name, for intrinsic dispatch.
fun intrinsic-name-of(f) -> Option:
  cases(N.AVal) f:
    | a-id(_, id) =>
      cases(A.Name) id:
        | s-name(_, s) => some(s)
        | s-global(s) => some(s)
        | else => none
      end
    | else => none
  end
end
# Auto-generated variant predicate `is-<variant>(x)`: true iff x is a $Variant with that
# variant's id. (The seed reifies these in compileApp; the self-hosted driver's hand-written
# desugar never generates is-X funs, so they'd resolve to a null global + trap.) Dispatched
# UNCONDITIONALLY by dreg membership in a-app — a spurious null capture (when is-X appears
# free inside a lambda) is harmless because the call is intercepted before reading the local.
fun variant-pred-of(f, c :: Ctx) -> Option:
  cases(Option) intrinsic-name-of(f):
    | none => none
    | some(nm) =>
      if (string-length(nm) > 3) and (string-substring(nm, 0, 3) == "is-"):
        data-lookup(c, string-substring(nm, 3, string-length(nm)))
      else: none
      end
  end
end
fun compile-variant-pred(vinfo, arg, c :: Ctx) -> List<Number>:
  v = c.next-local
  c2 = ctx(c.locals, c.next-local + 1, c.vars, c.fenv, c.lams, c.dreg, c.gvars, c.nlams)
  E.concat-bytes([list:
    compile-aval(arg, c2), E.local-set(v),
    E.local-get(v), E.ref-test-null(T-VARIANT), E.i-if(ANYREF-BT),
      E.local-get(v), E.ref-cast(T-VARIANT), E.i-call(idx-variant-id()), E.i32-const(vinfo.id), E.i32-eq, to-bool(),
    E.i-else,
      E.i32-const(0), E.ref-i31,
    E.i-end])
end

# ===== arithmetic global fast-path helpers =====
# Get the .key() of an AVal id (for global detection). Uses A.Name.key() which returns
# "global#<name>" for s-global, "atom#<base>#<serial>" for s-atom, etc. Returns "" for
# non-id AVal nodes so find-arith never matches them.
fun name-key-of-aval(v) -> String:
  cases(N.AVal) v:
    | a-id(_, id) => id.key()
    | else => ""
  end
end
# Find a runtime-function name for a known arithmetic global key, else none.
fun find-arith(tbl, key :: String):
  cases(List) tbl:
    | empty => none
    | link(f, r) => if f.k == key: some(f.fn) else: find-arith(r, key) end
  end
end

# ===== stoppable (CPS) codegen intrinsics =====
# The CPS pass (self-host/cps.arr, mirrored by src/compiler/cps.ts) rewrites the program
# into continuation-passing style and emits three intrinsic call families the backend must
# lower (the seed lowers them in compile.ts; this is the self-hosted port):
#   yield-check(thunk)            -- per-fn/loop interrupt point  -> runtime $yield (tail)
#   finish-result(v)             -- the halt continuation         -> stash $result + print
#   cps-op-<op>(a, b, k)         -- overloadable binop threading k -> num path or CPS method
# These are emitted as calls to FREE globals (yield-check / finish-result / cps-op-plus ...),
# so they're dispatched here only when the name is NOT locally/top-level bound (shadowable).

# cps-op-<name> -> the op code (PLUS/DASH/.../GEQ), else none.
fun cps-op-code(nm :: String) -> Option:
  ask:
    | nm == "cps-op-plus" then: some("PLUS")
    | nm == "cps-op-minus" then: some("DASH")
    | nm == "cps-op-times" then: some("TIMES")
    | nm == "cps-op-divide" then: some("SLASH")
    | nm == "cps-op-lessthan" then: some("LT")
    | nm == "cps-op-greaterthan" then: some("GT")
    | nm == "cps-op-lessequal" then: some("LEQ")
    | nm == "cps-op-greaterequal" then: some("GEQ")
    | otherwise: none
  end
end
# op code -> the runtime fn for the numeric/string path (these dispatch num internally).
fun cps-op-rt(opc :: String) -> String:
  ask:
    | opc == "PLUS" then: "$plus"  | opc == "DASH" then: "$minus"
    | opc == "TIMES" then: "$times" | opc == "SLASH" then: "$divide"
    | opc == "LT" then: "$lessthan" | opc == "GT" then: "$greaterthan"
    | opc == "LEQ" then: "$lessequal" | otherwise: "$greaterequal"
  end
end
# op code -> the data-overload method name (a._plus(b, k) etc.).
fun cps-op-method(opc :: String) -> String:
  ask:
    | opc == "PLUS" then: "_plus"  | opc == "DASH" then: "_minus"
    | opc == "TIMES" then: "_times" | opc == "SLASH" then: "_divide"
    | opc == "LT" then: "_lessthan" | opc == "GT" then: "_greaterthan"
    | opc == "LEQ" then: "_lessequal" | otherwise: "_greaterequal"
  end
end

# yield-check(thunk): compile the thunk arg and (tail-)call the runtime $yield, which does
# the gas/pause bookkeeping then tail-calls the thunk. Tail-call-to-tail-call keeps the
# stack flat (the whole point of CPS over native return_call).
fun compile-yield-check(thunk, c :: Ctx, tail :: Boolean) -> List<Number>:
  compile-aval(thunk, c)
    .append(if tail: E.i-return-call(rt-funcidx("$yield")) else: E.i-call(rt-funcidx("$yield")) end)
end

# finish-result(v): stash v in $result, render+print it (matching the non-stoppable last-
# expression printing), then return nothing. Mirrors compile.ts compileFinishResult.
fun compile-finish-result(value, c :: Ctx) -> List<Number> block:
  v = c.next-local
  max-local-used := num-max(max-local-used, v + 1)
  c2 = ctx(c.locals, c.next-local + 1, c.vars, c.fenv, c.lams, c.dreg, c.gvars, c.nlams)
  E.concat-bytes([list:
    compile-aval(value, c2), E.local-set(v),
    E.local-get(v), E.global-set(R.GI-RESULT),                 # stash final result
    E.i32-const(R.SCRATCH-OFFSET),                              # addr (under the len)
    E.local-get(v), E.i-call(rt-funcidx("$val_to_string")),    # render -> len
    E.i-call(host-funcidx("print")),                           # print(addr, len)
    E.i32-const(2), E.ref-i31 ])                               # nothing
end

# cps-op-<op>(a, b, k): if a is a number (or string for PLUS), feed the primitive result to
# the continuation k; otherwise tail-dispatch the CPS operator method a._op(b, k) so a data
# overload (now CPS'd with a trailing continuation) stays reachable + interruptible.
# Mirrors compile.ts compileCpsOp.
fun compile-cps-op(opc :: String, args, c :: Ctx, tail :: Boolean) -> List<Number> block:
  base = c.next-local
  a-loc = base
  b-loc = base + 1
  k-loc = base + 2
  fldl = base + 3      # method-dispatch: looked-up field
  cll = base + 4       # method-dispatch: the cast $Closure
  max-local-used := num-max(max-local-used, base + 5)
  c2 = ctx(c.locals, base + 5, c.vars, c.fenv, c.lams, c.dreg, c.gvars, c.nlams)
  tyidx = closure-call-type-idx()
  meth-name = cps-op-method(opc)
  # primitive result (a, b are num/str here): rt fn (anyref, anyref) -> anyref.
  prim-result = E.local-get(a-loc).append(E.local-get(b-loc)).append(E.i-call(rt-funcidx(cps-op-rt(opc))))
  # numeric/string path: k(prim-result)  -- a 1-arg (tail-aware) closure call.
  num-path = E.local-get(k-loc)
    .append(prim-result).append(E.array-new-fixed(T-FIELDS, 1))
    .append(E.local-get(k-loc)).append(E.ref-cast(T-CLOSURE)).append(E.struct-get(T-CLOSURE, 0))
    .append(if tail: E.i-return-call-indirect(tyidx, 0) else: E.i-call-indirect(tyidx, 0) end)
  # method path: a.<meth>(b, k) via $lookup_method (mirrors a-method-app).
  call-args = pack-instrs([list: E.local-get(a-loc), E.local-get(b-loc), E.local-get(k-loc)])
  method-path = E.local-get(fldl).append(E.ref-cast(T-METHOD)).append(E.struct-get(T-METHOD, 0)).append(E.local-set(cll))
    .append(E.local-get(cll)).append(call-args)
    .append(E.local-get(cll)).append(E.ref-cast(T-CLOSURE)).append(E.struct-get(T-CLOSURE, 0))
    .append(if tail: E.i-return-call-indirect(tyidx, 0) else: E.i-call-indirect(tyidx, 0) end)
  plain-path = E.local-get(fldl).append(E.ref-cast(T-CLOSURE)).append(E.local-set(cll))
    .append(E.local-get(cll)).append(call-args)
    .append(E.local-get(cll)).append(E.ref-cast(T-CLOSURE)).append(E.struct-get(T-CLOSURE, 0))
    .append(if tail: E.i-return-call-indirect(tyidx, 0) else: E.i-call-indirect(tyidx, 0) end)
  meth-dispatch = E.local-get(a-loc).append(emit-str(meth-name)).append(E.i-call(rt-funcidx("$lookup_method")))
    .append(E.local-set(fldl))
    .append(E.local-get(fldl)).append(E.ref-test-null(T-METHOD))
    .append(E.i-if(ANYREF-BT)).append(method-path).append(E.i-else).append(plain-path).append(E.i-end)
  is-num = E.local-get(a-loc).append(E.ref-test-null(T-NUM))
  cond = if opc == "PLUS":
      is-num.append(E.local-get(a-loc)).append(E.ref-test-null(T-STR)).append(E.i32-or)
    else: is-num end
  E.concat-bytes([list:
    compile-aval(args.get(0), c2), E.local-set(a-loc),
    compile-aval(args.get(1), c2), E.local-set(b-loc),
    compile-aval(args.get(2), c2), E.local-set(k-loc),
    cond, E.i-if(ANYREF-BT), num-path, E.i-else, meth-dispatch, E.i-end ])
end

# Dispatch a CPS stoppability intrinsic call, if the callee is an unbound global matching one.
fun compile-cps-intrinsic(f, args, c :: Ctx, tail :: Boolean) -> Option:
  cases(Option) intrinsic-name-of(f):
    | none => none
    | some(nm) =>
      ikey = cases(N.AVal) f: | a-id(_, iid) => name-key(iid) | else => "" end
      ibound = cases(Option) lookup-local-opt(c, ikey):
        | some(_) => true
        | none => cases(Option) gmap-lookup(c, ikey): | some(_) => true | none => false end
      end
      if ibound: none
      else:
        ask:
          | (nm == "yield-check") and (length(args) == 1) then: some(compile-yield-check(args.first, c, tail))
          | (nm == "finish-result") and (length(args) == 1) then: some(compile-finish-result(args.first, c))
          | otherwise:
            cases(Option) cps-op-code(nm):
              | none => none
              | some(opc) => if length(args) == 3: some(compile-cps-op(opc, args, c, tail)) else: none end
            end
        end
      end
  end
end

# ===== ALettable -> instructions (leaves the value; `tail` => return_call) =====
fun compile-lettable(lt, c :: Ctx, tail :: Boolean) -> List<Number>:
  cases(N.ALettable) lt:
    | a-val(l, v) => compile-aval(v, c)
    | a-id-var(l, id) =>
      k = name-key(id)
      cases(Option) lookup-ventry-opt(c, k):                                 # per-entry v (shadowing-aware)
        | none => resolve-nonlocal(c, k)
        | some(e) => if e.v: box-read(e.i) else: E.local-get(e.i) end
      end
    | a-id-letrec(l, id, safe) =>
      k = name-key(id)
      cases(Option) lookup-local-opt(c, k):
        | none => resolve-nonlocal(c, k)
        | some(i) => E.local-get(i)
      end
    | a-id-var-modref(l, id, uri, name) => E.i-ref-null(110)                # TODO(port): module ref
    | a-app(l, f, args, info) =>
      cases(Option) compile-cps-intrinsic(f, args, c, tail):
        | some(cinstrs) => cinstrs
        | none =>
      # Fast path: well-known Pyret global arithmetic/comparison operators that desugar
      # emits as s-app(s-id(s-global("_plus")), [a, b]) etc. These map directly to
      # runtime functions that take (anyref, anyref) -> anyref and need no closure wrap.
      # "_plus"    -> $plus      (fixnum add or string concat)
      # "_minus"   -> $minus     (fixnum sub)
      # "_times"   -> $times     (fixnum mul)
      # "_divide"  -> $divide    (fixnum div)
      # "_lessthan" / "_greaterthan" / "_lessequal" / "_greaterequal" -> comparisons
      # "equal-always" / "equal-now" -> $equal (also handled in prim-app but may reach here)
      # Keys use A.Name.key() format: "global#<name>" for s-global names.
      # These are the global function names that desugar.arr emits for operators.
      arith-map = [list:
        {k: "global#_plus",          fn: "$plus"},
        {k: "global#_minus",         fn: "$minus"},
        {k: "global#_times",         fn: "$times"},
        {k: "global#_divide",        fn: "$divide"},
        {k: "global#_lessthan",      fn: "$lessthan"},
        {k: "global#_greaterthan",   fn: "$greaterthan"},
        {k: "global#_lessequal",     fn: "$lessequal"},
        {k: "global#_greaterequal",  fn: "$greaterequal"},
        {k: "global#equal-always",   fn: "$equal_wrap"},
        {k: "global#equal-now",      fn: "$equal_wrap"}
      ]
      f-key = name-key-of-aval(f)
      cases(Option) find-arith(arith-map, f-key):
        | some(rt-name) =>
          # Direct runtime call: push args (anyref), call runtime fn.
          compile-avals(args, c).append(E.i-call(rt-funcidx(rt-name)))
        | none =>
          cases(Option) variant-pred-of(f, c):
            | some(vinfo) => compile-variant-pred(vinfo, args.first, c)
            | none =>
          # A free primitive global (string-length, num-modulo, prim-raw-array-*, tostring, …)
          # is an intrinsic — it has no closure value, so the closure path below would null-trap.
          maybe-intr = cases(Option) intrinsic-name-of(f):
            | none => none
            | some(nm) =>
              ikey = cases(N.AVal) f: | a-id(_, iid) => name-key(iid) | else => "" end
              ibound = cases(Option) lookup-local-opt(c, ikey):
                | some(_) => true
                | none => cases(Option) gmap-lookup(c, ikey): | some(_) => true | none => false end
              end
              if ibound: none else: compile-intrinsic(nm, args, c) end
          end
          cases(Option) maybe-intr:
            | some(iinstrs) => iinstrs
            | none =>
          # closure-calling convention: (closure-as-anyref, $Fields)->anyref via table 0.
          # The closure is used twice (passed as arg0 AND its fnIndex is the table selector),
          # so stash it in a temp local. Stack order for call_indirect: [arg0=closure,
          # arg1=fields, selector=closure.fnIndex].  tyidx = the closure-call func type.
          # A method taken as a VALUE (`f = o.m`) is a $Method wrapping a $Closure — unwrap
          # it so it's callable, else `ref.cast T-CLOSURE` traps.
          cl   = c.next-local        # the callee value as evaluated (anyref)
          clos = c.next-local + 1    # the actual $Closure ($Method unwrapped)
          c2 = ctx(c.locals, c.next-local + 2, c.vars, c.fenv, c.lams, c.dreg, c.gvars, c.nlams)
          tyidx = closure-call-type-idx()
          compile-aval(f, c2)
            .append(E.local-set(cl))
            .append(E.local-get(cl)).append(E.ref-test-null(T-METHOD))   # is the callee a $Method?
            .append(E.i-if(ANYREF-BT))
            .append(E.local-get(cl)).append(E.ref-cast(T-METHOD)).append(E.struct-get(T-METHOD, 0))  # its $Closure
            .append(E.i-else)
            .append(E.local-get(cl))                                  # already a $Closure
            .append(E.i-end)
            .append(E.local-set(clos))
            .append(E.local-get(clos))                                # arg0: the closure
            .append(pack-fields(args, c2))                            # arg1: args as $Fields
            .append(E.local-get(clos)).append(E.ref-cast(T-CLOSURE)).append(E.struct-get(T-CLOSURE, 0))  # selector
            .append(if tail: E.i-return-call-indirect(tyidx, 0) else: E.i-call-indirect(tyidx, 0) end)
          end
          end
      end
      end
    | a-prim-app(l, fname, args, info) => compile-prim-app(fname, args, c)
    | a-if(l, cnd, t, e) =>
      # branch bodies (compile-aexpr) can be large + sit mid-chain, so `.append` after them
      # would recurse to their length — assemble with tail-recursive concat-bytes instead.
      E.concat-bytes([list:
        compile-aval(cnd, c), truthy-instr(), E.i-if(ANYREF-BT),
        compile-aexpr(t, c, tail), E.i-else, compile-aexpr(e, c, tail), E.i-end])
    | a-lam(l, name, args, ret, body) =>
      # closure value: struct.new $Closure {fnIndex, caps}.  fnIndex is the table slot the
      # collect-lambdas pass assigned this lambda; caps is its free vars packed into a
      # $Fields (read back inside the body from local 0). Closed lambdas get an empty caps.
      p = lookup-lam-pair(c.lams, tostring(l))
      caps = E.concat-bytes(p.fvs.map(lam(k): load-capture(c, k) end)).append(E.array-new-fixed(T-FIELDS, length(p.fvs)))
      E.i32-const(p.i).append(caps).append(E.struct-new(T-CLOSURE))
    | a-method(l, name, args, ret, body) =>
      p = lookup-lam-pair(c.lams, tostring(l))
      caps = E.concat-bytes(p.fvs.map(lam(k): load-capture(c, k) end)).append(E.array-new-fixed(T-FIELDS, length(p.fvs)))
      E.i32-const(p.i).append(caps).append(E.struct-new(T-CLOSURE)).append(E.struct-new(T-METHOD))
    | a-obj(l, fields) =>
      # $make_object(names, values)
      emit-names(fields)
        .append(pack-fields(fields.map(lam(f): f.value end), c))
        .append(E.i-call(idx-make-object()))
    | a-extend(l, supe, fields) =>
      # supe flows as anyref (uniform value model); $obj_extend wants (ref $Object) — cast.
      compile-aval(supe, c).append(E.ref-cast(T-OBJECT))
        .append(emit-names(fields))
        .append(pack-fields(fields.map(lam(f): f.value end), c))
        .append(E.i-call(idx-obj-extend()))
    | a-update(l, supe, fields) => compile-aval(supe, c)                    # TODO(port): mutable update
    | a-dot(l, obj, field) =>
      # field access dispatches on the value: a data VARIANT reads its field by name
      # ($variant_field_by_name); any other value (an object) uses $obj_get. (self.x in a
      # variant method needs the variant path.)
      ol = c.next-local
      c2 = ctx(c.locals, c.next-local + 1, c.vars, c.fenv, c.lams, c.dreg, c.gvars, c.nlams)
      compile-aval(obj, c2).append(E.local-set(ol))
        .append(E.local-get(ol)).append(E.ref-test-null(T-VARIANT))
        .append(E.i-if(ANYREF-BT))
        .append(E.local-get(ol)).append(emit-str(field)).append(E.i-call(idx-variant-field-by-name()))
        .append(E.i-else)
        .append(E.local-get(ol)).append(emit-str(field)).append(E.i-call(idx-obj-get()))
        .append(E.i-end)
    | a-colon(l, obj, field) => compile-aval(obj, c)                        # TODO(port): method/field colon
    | a-get-bang(l, obj, field) =>
      # read the ref-cell field by name, then unbox the cell. TODO(port): unbox.
      compile-aval(obj, c).append(emit-str(field)).append(E.i-call(idx-variant-field-by-name()))
    | a-tuple(l, fields) =>
      # tuple = $Variant SENTINEL id -1 (distinct from real variant ids 0,1,2,… which
      # collect-data assigns 0-based — so the first data variant, e.g. `empty`, is no longer
      # mis-rendered/compared as a tuple). $render_variant dispatches tuples on id == -1.
      E.i32-const(-1).append(emit-str("tuple")).append(pack-fields(fields, c)).append(E.struct-new(T-VARIANT))
    | a-tuple-get(l, tup, index) =>
      compile-aval(tup, c)
        .append(E.ref-cast(T-VARIANT))
        .append(E.struct-get(T-VARIANT, 2))   # the $Fields
        .append(E.i32-const(index)).append(E.array-get(T-FIELDS))
    | a-cases(l, typ, val, branches, els) =>
      # vtag dispatch: stash val + its variant-id in temps, then a nested if-chain per
      # branch comparing the id (from the data registry); each matching branch binds its
      # args from the variant's $Fields by index, then runs its body; final else.
      # only vtmp is stashed (it's anyref); the variant id (i32) can't live in an anyref
      # local, so each branch recomputes it from vtmp via $variant_id.
      vtmp = c.next-local
      c2 = ctx(c.locals, c.next-local + 1, c.vars, c.fenv, c.lams, c.dreg, c.gvars, c.nlams)   # reserve 1 temp
      compile-aval(val, c)
        .append(E.local-set(vtmp))
        .append(compile-branches(branches, vtmp, c2, tail, els))
    | a-assign(l, id, value) =>
      # write the var's 1-cell: cell[0] := value ; assignment returns nothing.
      k = name-key(id)
      E.local-get(lookup-local(c, k))
        .append(E.ref-cast(T-FIELDS))  # cast anyref local to (ref $Fields) for array.set
        .append(E.i32-const(0))
        .append(compile-aval(value, c))
        .append(E.array-set(T-FIELDS))
        .append(E.i32-const(2)).append(E.ref-i31)
    | a-method-app(l, obj, meth, args) =>
      if (meth == "_match") and (length(args) == 2):
        # `obj._match(handlers, els)` is Pyret's auto-generated data dispatcher (the basis
        # of `.visit()`). Route to the runtime `$variant_match`, which dispatches obj on
        # handlers by variant name. Mirrors the seed's compileMethodOnValue.
        compile-aval(obj, c)
          .append(compile-aval(args.get(0), c))
          .append(compile-aval(args.get(1), c))
          .append(if tail: E.i-return-call(rt-funcidx("$variant_match"))
                  else: E.i-call(rt-funcidx("$variant_match")) end)
      else:
      # method dispatch: stash obj in a temp, look up the method via $lookup_method
      # (variant -> $variant_methods[id]; object -> itself), then if the field is a
      # $Method call its closure with [self, ...args]; else call the plain field-closure
      # with [args].  Mirrors the seed's compileMethodOnValue.
      objl = c.next-local
      fldl = c.next-local + 1
      cll  = c.next-local + 2
      max-local-used := num-max(max-local-used, cll + 1)   # these temps aren't bind-local'd
      c2 = ctx(c.locals, c.next-local + 3, c.vars, c.fenv, c.lams, c.dreg, c.gvars, c.nlams)
      tyidx = closure-call-type-idx()
      arg-instrs = args.map(lam(a): compile-aval(a, c2) end)
      # $Method path: closure = (cast field $Method).0 ; call [closure, $Fields(self,...args), sel]
      method-path =
        E.local-get(fldl).append(E.ref-cast(T-METHOD)).append(E.struct-get(T-METHOD, 0)).append(E.local-set(cll))
          .append(E.local-get(cll))
          .append(pack-instrs(link(E.local-get(objl), arg-instrs)))
          .append(E.local-get(cll)).append(E.ref-cast(T-CLOSURE)).append(E.struct-get(T-CLOSURE, 0))
          .append(if tail: E.i-return-call-indirect(tyidx, 0) else: E.i-call-indirect(tyidx, 0) end)
      # plain path: the field is itself a closure ; call [field, $Fields(args), sel]
      plain-path =
        E.local-get(fldl).append(E.ref-cast(T-CLOSURE)).append(E.local-set(cll))
          .append(E.local-get(cll))
          .append(pack-instrs(arg-instrs))
          .append(E.local-get(cll)).append(E.ref-cast(T-CLOSURE)).append(E.struct-get(T-CLOSURE, 0))
          .append(if tail: E.i-return-call-indirect(tyidx, 0) else: E.i-call-indirect(tyidx, 0) end)
      compile-aval(obj, c2)
        .append(E.local-set(objl))
        .append(E.local-get(objl)).append(emit-str(meth)).append(E.i-call(rt-funcidx("$lookup_method")))
        .append(E.local-set(fldl))
        .append(E.local-get(fldl)).append(E.ref-test-null(T-METHOD))
        .append(E.i-if(ANYREF-BT)).append(method-path).append(E.i-else).append(plain-path).append(E.i-end)
      end
    | a-data-expr(l, name, namet, variants, shared) =>
      # the variant registry (id/arity/fields) is collected up front (collect-data, in
      # Ctx.dreg); the per-variant constructor FUNCTIONS are emitted by the assembler into
      # the table (ctor table slot = nlams + variant.id). Here we return the data value as
      # an $Object mapping each variant name -> its constructor closure, so later code can
      # reach the constructors. The $variant_names global (for $variant_field_by_name) is
      # built by the assembler from the same registry.
      # Singleton variants bind to their constructed VALUE; regular variants bind to a
      # constructor closure (see data-field-value). TODO(port): is-<variant> predicates and
      # binding the constructor names that the front-end's ANF references directly (needs
      # the top-level/global id resolution that a-id still leaves as null).
      # First, populate $variant_methods[id] for each variant that has `with:`/`sharing:`
      # methods (a methods $Object: name -> the let-bound $Method/closure value, in scope
      # here).  These side-effects leave nothing on the stack; the data $Object follows.
      this-names = variants.map(variant-name)
      # set-all-variant-methods can be large (e.g. ast.arr's 225 variants) and is FIRST in
      # the chain — assemble with tail-recursive concat-bytes so `.append` after it doesn't
      # recurse to its length.
      E.concat-bytes([list:
        set-all-variant-methods(c, variants, shared),
        emit-names-of(this-names),
        E.concat-bytes(variants.map(lam(vv): data-field-value(c, vv) end)),
        E.array-new-fixed(T-FIELDS, length(variants)),
        E.i-call(idx-make-object())])
    | a-ref(l, ann) => E.i-ref-null(110)                                   # TODO(port): bare ref
    | a-module(l, ans, dv, dt, prov, types, checks) =>
      # Return the answer (the last evaluated expression in the body). The module value
      # itself is not representable; we just expose `ans` so the host can render the result.
      # `checks` is the checker results expression; we skip it here because a-prim-val
      # ("builtins") is not yet wired up and would trap. The check: harness is handled
      # separately via a-prim-app dispatch when the full builtins object is available.
      compile-aval(ans, c)
  end
end

# the constructor closure for a variant: struct.new $Closure {table-slot, null caps}.
# table-slot = nlams + the variant's registry id (the assembler lays ctors after lambdas).
fun ctor-closure(c :: Ctx, v) -> List<Number>:
  vn = variant-name(v)
  cases(Option) data-lookup(c, vn):
    | none => E.i-ref-null(T-CLOSURE)
    | some(d) => E.i32-const(c.nlams + d.id).append(E.i-ref-null(T-FIELDS)).append(E.struct-new(T-CLOSURE))
  end
end
# the value bound to a variant name in the data object: a SINGLETON variant is the
# constructed $Variant VALUE (no args, so it's used directly, not called); a regular
# variant is its constructor closure.
fun data-field-value(c :: Ctx, v) -> List<Number>:
  vn = variant-name(v)
  cases(N.AVariant) v:
    | a-singleton-variant(_, _, _) =>
      cases(Option) data-lookup(c, vn):
        | none => E.i-ref-null(110)
        | some(d) =>
          E.i32-const(d.id).append(emit-str(d.name))
            .append(E.array-new-fixed(T-FIELDS, 0)).append(E.struct-new(T-VARIANT))
      end
    | a-variant(_, _, _, _, _) => ctor-closure(c, v)
  end
end
fun variant-name(v) -> String:
  cases(N.AVariant) v:
    | a-variant(_, _, nm, _, _) => nm
    | a-singleton-variant(_, nm, _) => nm
  end
end
fun variant-with-members(v):
  cases(N.AVariant) v:
    | a-variant(_, _, _, _, wm) => wm
    | a-singleton-variant(_, _, wm) => wm
  end
end
# a variant's methods = its `with:` members ++ the data's `sharing:` members not
# overridden by name (with-members win), each an a-field whose value is the let-bound
# method ($Method) reference.
fun merged-methods(v, shared):
  wm = variant-with-members(v)
  wm-names = wm.map(lam(f): f.name end)
  wm + shared.filter(lam(s): not(wm-names.member(s.name)) end)
end
# instructions building a methods $Object (name -> method value) for a field list.
fun methods-object-instrs(c :: Ctx, fields) -> List<Number>:
  emit-names-of(fields.map(lam(f): f.name end))
    .append(pack-fields(fields.map(lam(f): f.value end), c))
    .append(E.i-call(idx-make-object()))
end
# instructions setting $variant_methods[id] := methods-object for one variant (or empty
# if it has no methods).
fun set-one-variant-methods(c :: Ctx, v, shared) -> List<Number>:
  methods = merged-methods(v, shared)
  if is-empty(methods): empty
  else:
    cases(Option) data-lookup(c, variant-name(v)):
      | none => empty
      | some(d) =>
        E.global-get(R.GI-VARIANT-METHODS).append(E.ref-cast(T-FIELDS))
          .append(E.i32-const(d.id))
          .append(methods-object-instrs(c, methods))
          .append(E.array-set(T-FIELDS))
    end
  end
end
fun set-all-variant-methods(c :: Ctx, variants, shared) -> List<Number>:
  E.concat-bytes(variants.map(lam(v): set-one-variant-methods(c, v, shared) end))
end

# prim-app -> runtime index. (kept for reference; the dispatch lives inline in a-prim-app.)

# ===== a-cases branch chain =====
# Build a nested if/else over the variant id (in local `idtmp`), val in local `vtmp`.
fun compile-branches(branches, vtmp :: Number, c :: Ctx, tail :: Boolean, els) -> List<Number>:
  # the variant id of val, recomputed on the stack (i32) each branch (no i32 local).
  val-id = E.local-get(vtmp).append(E.i-call(idx-variant-id()))
  cases(List) branches:
    | empty => compile-aexpr(els, c, tail)
    | link(br, rest) =>
      cases(N.ACasesBranch) br:
        | a-cases-branch(_, _, bname, bargs, bbody) =>
          cases(Option) data-lookup(c, bname):
            | none => compile-branches(rest, vtmp, c, tail, els)     # unknown variant: skip
            | some(d) =>
              bound = bind-cases-args(bargs, 0, vtmp, c, empty)
              # branch body + recursive rest are large + mid-chain → concat-bytes (tail).
              E.concat-bytes([list:
                val-id, E.i32-const(d.id), E.i32-eq, E.i-if(ANYREF-BT),
                bound.code, compile-aexpr(bbody, bound.cx, tail), E.i-else,
                compile-branches(rest, vtmp, c, tail, els), E.i-end])
          end
        | a-singleton-cases-branch(_, _, bname, bbody) =>
          cases(Option) data-lookup(c, bname):
            | none => compile-branches(rest, vtmp, c, tail, els)
            | some(d) =>
              E.concat-bytes([list:
                val-id, E.i32-const(d.id), E.i32-eq, E.i-if(ANYREF-BT),
                compile-aexpr(bbody, c, tail), E.i-else,
                compile-branches(rest, vtmp, c, tail, els), E.i-end])
          end
      end
  end
end

# Bind a branch's args from val's $Fields by index into fresh locals; returns
# { code: prologue-instrs, cx: extended-ctx }.
fun bind-cases-args(args, j :: Number, vtmp :: Number, c :: Ctx, code):
  cases(List) args:
    | empty => { code: code, cx: c }
    | link(cb, rest) =>
      slot = c.next-local
      k = name-key(cb.bind.id)
      c2 = bind-local(c, k, slot)
      step = E.local-get(vtmp)
        .append(E.ref-cast(T-VARIANT))
        .append(E.struct-get(T-VARIANT, 2))   # the $Fields
        .append(E.i32-const(j))
        .append(E.array-get(T-FIELDS))
        .append(E.local-set(slot))
      bind-cases-args(rest, j + 1, vtmp, c2, code.append(step))
  end
end

# ===== AExpr -> instructions =====
# Compile an AExpr. The a-let/a-var/a-seq/a-arr-let/a-type-let SPINE is walked with a
# TAIL-recursive loop (constant stack) — a big module is one long spine, so recursing it
# would overflow. Each spine step's prefix instructions are accumulated (reversed); the
# terminal lettable is compiled in `tail` position, then everything is concat'd (tail).
fun compile-aexpr(e, c :: Ctx, tail :: Boolean) -> List<Number>:
  fun loop(e2, c2 :: Ctx, prefix-rev :: List<List<Number>>) -> List<Number>:
    cases(N.AExpr) e2:
      | a-let(l, b, lt, body) =>
        idx = c2.next-local
        k = name-key(b.id)
        step = E.concat-bytes([list: compile-lettable(lt, c2, false), E.local-set(idx), mirror-global(c2, k, idx)])
        loop(body, bind-local(c2, k, idx), link(step, prefix-rev))
      | a-var(l, b, lt, body) =>
        idx = c2.next-local
        step = E.concat-bytes([list: compile-lettable(lt, c2, false), E.array-new-fixed(T-FIELDS, 1), E.local-set(idx)])
        loop(body, bind-var(c2, name-key(b.id), idx), link(step, prefix-rev))
      | a-seq(l, e1, e2b) =>
        step = E.concat-bytes([list: compile-lettable(e1, c2, false), E.i-drop])
        loop(e2b, c2, link(step, prefix-rev))
      | a-type-let(l, bind, body) => loop(body, c2, prefix-rev)            # types erased
      | a-arr-let(l, b, idx2, lt, body) =>
        slot = c2.next-local
        k = name-key(b.id)
        step = E.concat-bytes([list: compile-lettable(lt, c2, false), E.local-set(slot), mirror-global(c2, k, slot)])
        loop(body, bind-local(c2, k, slot), link(step, prefix-rev))
      | a-lettable(l, lt) =>
        # terminal: prefix steps (un-reverse) ++ the final lettable (in tail position).
        E.concat-bytes(E.rev-onto(prefix-rev, [list: compile-lettable(lt, c2, tail)]))
    end
  end
  loop(e, c, empty)
end

# ===== pre-pass: collect lambdas (so each gets a stable fnIndex/table slot) =====
# Walk the whole program collecting every a-lam/a-method in source order. Each record:
# { key: loc-string, args, body, fvs: ordered free-var keys }. fnIndex == position.
fun collect-lams-expr(e, acc):
  cases(N.AExpr) e:
    | a-let(_, _, lt, body) => collect-lams-expr(body, collect-lams-lettable(lt, acc))
    | a-var(_, _, lt, body) => collect-lams-expr(body, collect-lams-lettable(lt, acc))
    | a-seq(_, e1, e2) => collect-lams-expr(e2, collect-lams-lettable(e1, acc))
    | a-lettable(_, lt) => collect-lams-lettable(lt, acc)
    | a-type-let(_, _, body) => collect-lams-expr(body, acc)
    | a-arr-let(_, _, _, lt, body) => collect-lams-expr(body, collect-lams-lettable(lt, acc))
  end
end
fun collect-lams-lettable(lt, acc):
  cases(N.ALettable) lt:
    | a-lam(l, _, args, _, body) => collect-lams-expr(body, link({key: tostring(l), args: args, body: body, fvs: fv-of-lam(args, body)}, acc))
    | a-method(l, _, args, _, body) => collect-lams-expr(body, link({key: tostring(l), args: args, body: body, fvs: fv-of-lam(args, body)}, acc))
    | a-if(_, _, t, e) => collect-lams-expr(e, collect-lams-expr(t, acc))
    | a-cases(_, _, _, branches, els) =>
      for fold(a from collect-lams-expr(els, acc), br from branches):
        collect-lams-expr(branch-body(br), a)
      end
    | else => acc
  end
end
fun branch-body(br):
  cases(N.ACasesBranch) br:
    | a-cases-branch(_, _, _, _, body) => body
    | a-singleton-cases-branch(_, _, _, body) => body
  end
end

# ===== pre-pass: every key bound by an a-var (so captures grab the box) =====
fun collect-gvars-expr(e, acc):
  cases(N.AExpr) e:
    | a-let(_, _, lt, body) => collect-gvars-expr(body, collect-gvars-lettable(lt, acc))
    | a-var(_, b, lt, body) => collect-gvars-expr(body, collect-gvars-lettable(lt, link(name-key(b.id), acc)))
    | a-seq(_, e1, e2) => collect-gvars-expr(e2, collect-gvars-lettable(e1, acc))
    | a-lettable(_, lt) => collect-gvars-lettable(lt, acc)
    | a-type-let(_, _, body) => collect-gvars-expr(body, acc)
    | a-arr-let(_, _, _, lt, body) => collect-gvars-expr(body, collect-gvars-lettable(lt, acc))
  end
end
fun collect-gvars-lettable(lt, acc):
  cases(N.ALettable) lt:
    | a-lam(_, _, _, _, body) => collect-gvars-expr(body, acc)
    | a-method(_, _, _, _, body) => collect-gvars-expr(body, acc)
    | a-if(_, _, t, e) => collect-gvars-expr(e, collect-gvars-expr(t, acc))
    | a-cases(_, _, _, branches, els) =>
      for fold(a from collect-gvars-expr(els, acc), br from branches):
        collect-gvars-expr(branch-body(br), a)
      end
    | else => acc
  end
end

# ===== pre-pass: collect the data registry (variant-name -> {id; arity; fields}) =====
# Global, unique variant ids assigned in encounter order, used by a-cases dispatch,
# a-data-expr constructors, and the $variant_names global.
fun variant-member-name(m) -> String:
  cases(N.AVariantMember) m:
    # SURFACE name (what `.x` / $variant_field_by_name look up), not the A.Name key.
    | a-variant-member(_, _, bind) => bind.id.toname()
  end
end
fun collect-data-expr(e, acc):
  cases(N.AExpr) e:
    | a-let(_, _, lt, body) => collect-data-expr(body, collect-data-lettable(lt, acc))
    | a-var(_, _, lt, body) => collect-data-expr(body, collect-data-lettable(lt, acc))
    | a-seq(_, e1, e2) => collect-data-expr(e2, collect-data-lettable(e1, acc))
    | a-lettable(_, lt) => collect-data-lettable(lt, acc)
    | a-type-let(_, _, body) => collect-data-expr(body, acc)
    | a-arr-let(_, _, _, lt, body) => collect-data-expr(body, collect-data-lettable(lt, acc))
  end
end
fun collect-data-lettable(lt, acc):
  cases(N.ALettable) lt:
    | a-data-expr(_, _, _, variants, _) =>
      for fold(a from acc, v from variants):
        cases(N.AVariant) v:
          | a-variant(_, _, vname, members, _) =>
            link({name: vname, id: length(a), arity: length(members), fields: members.map(variant-member-name)}, a)
          | a-singleton-variant(_, vname, _) =>
            link({name: vname, id: length(a), arity: 0, fields: empty}, a)
        end
      end
    | a-if(_, _, t, e) => collect-data-expr(e, collect-data-expr(t, acc))
    | a-lam(_, _, _, _, body) => collect-data-expr(body, acc)
    | a-method(_, _, _, _, body) => collect-data-expr(body, acc)
    | a-cases(_, _, _, branches, els) =>
      for fold(a from collect-data-expr(els, acc), br from branches):
        collect-data-expr(branch-body(br), a)
      end
    | else => acc
  end
end
# the registry in id order (ids are dense 0..n-1).
fun ctors-by-id(dreg, i :: Number, n :: Number):
  if i == n: empty
  else: link(find-by-id(dreg, i), ctors-by-id(dreg, i + 1, n)) end
end
fun find-by-id(ds, target :: Number):
  cases(List) ds:
    | empty => raise("wasm-of-pyret: no variant with id " + tostring(target))
    | link(f, r) => if f.id == target: f else: find-by-id(r, target) end
  end
end

# ===== the GC type rec-group (must match types.ts / runtime.arr's layout) =====
fun gc-rec-group():
  i32f = E.field(E.i32t, 0)
  E.rec-group([list:
    E.array-type(E.field(E.i32t, 1)),                                                  # 0  $Limbs (mut i32)
    E.sub-type(empty, E.struct-type([list: i32f])),                                    # 1  $Num (open base)
    E.sub-type([list: 1], E.struct-type([list: i32f, E.field(E.i64t, 0)])),            # 2  $Fixnum
    E.sub-type([list: 1], E.struct-type([list: i32f, E.field(E.reft(1), 0), E.field(E.reft(1), 0)])),  # 3  $Rational
    E.sub-type([list: 1], E.struct-type([list: i32f, E.field(E.f64t, 0)])),            # 4  $Roughnum
    E.sub-type([list: 1], E.struct-type([list: i32f, i32f, E.field(E.reft(0), 0)])),   # 5  $Bignum
    E.array-type(E.field(E.i8st, 1)),                                                  # 6  $Str (mut i8)
    E.array-type(E.field(E.anyref, 1)),                                                # 7  $Fields (mut anyref)
    E.struct-type([list: i32f, E.field(E.reft(6), 0), E.field(E.reft(7), 0)]),         # 8  $Variant
    E.struct-type([list: i32f, E.field(E.reftnull(7), 0)]),                            # 9  $Closure
    E.array-type(E.field(E.reft(6), 1)),                                               # 10 $Names (mut: $obj_extend array.copy)
    E.struct-type([list: E.field(E.reft(10), 0), E.field(E.reft(7), 0)]),              # 11 $Object
    E.struct-type([list: E.field(E.reft(9), 0)]) ])                                    # 12 $Method
end

# type index of the closure-call func type ((closure-as-anyref, $Fields)->anyref): it
# follows the GC rec-group (NUM-GC-TYPES indices) and one func type per runtime fn.
fun closure-call-type-idx(): NUM-GC-TYPES + length(RT-FUNS) end
fun main-type-idx(): NUM-GC-TYPES + length(RT-FUNS) + 1 end
# the host-import func types follow closure-call + main in the type section.
fun import-type-base(): NUM-GC-TYPES + length(RT-FUNS) + 2 end
fun import-type-idx(k :: Number): import-type-base() + k end

# Per-function declared-local COUNT is computed EXACTLY (max local index used) rather than a
# fixed cap — big self-compiled functions (long a-let spines) need far more than the old 512,
# which caused "unknown local 512" at instantiation. bind-local/bind-var bump max-local-used;
# locals-decl(nparams) reads it AFTER the body bytes are built. LOCAL-MARGIN covers the small
# inline scratch temps (a-app uses next-local+2, a-extend +3, a-cases vtmp +1, ...) that are
# allocated by index without going through bind-local.
var max-local-used :: Number = 0
LOCAL-MARGIN = 32
fun locals-decl(nparams :: Number) -> List<List<Number>>:
  cnt = num-max(0, max-local-used - nparams) + LOCAL-MARGIN
  [list: E.local-decl(cnt, E.anyref)]
end

# assign each collected lambda its fnIndex (== source position) -> List<{k; i; fvs}>
fun index-pairs(items, i :: Number, acc):
  cases(List) items:
    | empty => acc.reverse()
    | link(f, r) => index-pairs(r, i + 1, link({k: f.key, i: i, fvs: f.fvs}, acc))
  end
end

# compile one lambda to a code entry: caps (free vars from the closure env, local 0) and
# args (from the $Fields param, local 1) are loaded into fresh locals, then the body in
# tail position.  A captured `var` is re-bound as a var so reads/writes go through the box.
fun compile-lam(lr, lam-map, dreg, gvars, nlams :: Number, gmap) -> List<Number> block:
  max-local-used := 2   # 2 params: local 0 = closure env, local 1 = args $Fields
  c0 = ctx(empty, 2, empty, gmap, lam-map, dreg, gvars, nlams)
  capres = bind-caps(lr.fvs, 0, c0, empty)
  argres = setup-args(lr.args, capres.cx, capres.code, 0)
  body-code = compile-aexpr(lr.body, argres.cx, true)   # built first -> max-local-used final
  E.code-entry(locals-decl(2), argres.code.append(body-code))
end
# load each captured free var out of the closure env (local 0 -> $Closure.caps[j]).
fun bind-caps(fvs, j :: Number, c :: Ctx, code):
  cases(List) fvs:
    | empty => { code: code, cx: c }
    | link(k, rest) =>
      slot = c.next-local
      c2 = if c.gvars.member(k): bind-var(c, k, slot) else: bind-local(c, k, slot) end
      step = E.local-get(0)
        .append(E.ref-cast(T-CLOSURE))
        .append(E.struct-get(T-CLOSURE, 1))   # caps $Fields
        .append(E.i32-const(j))
        .append(E.array-get(T-FIELDS))
        .append(E.local-set(slot))
      bind-caps(rest, j + 1, c2, code.append(step))
  end
end
# copy args out of the $Fields param (local 1) by position into fresh locals.
fun setup-args(args, c :: Ctx, code, argi :: Number):
  cases(List) args:
    | empty => { code: code, cx: c }
    | link(ab, rest) =>
      slot = c.next-local
      c2 = bind-local(c, name-key(ab.id), slot)
      step = E.local-get(1).append(E.i32-const(argi)).append(E.array-get(T-FIELDS)).append(E.local-set(slot))
      setup-args(rest, c2, code.append(step), argi + 1)
  end
end
# compile one variant constructor: receives args as $Fields (local 1); builds the
# $Variant {id, name, fields=local1} and returns it.
fun compile-ctor(d) -> List<Number> block:
  max-local-used := 2   # only param local 1 is used; no fresh locals
  # local 1 (the args $Fields param) is nullable in the closure-call signature; the
  # $Variant.fields field is non-null, so cast before struct.new.
  body = E.i32-const(d.id).append(emit-str(d.name))
    .append(E.local-get(1)).append(E.ref-cast(T-FIELDS)).append(E.struct-new(T-VARIANT))
  E.code-entry(locals-decl(2), body)   # ctor uses only param local 1 -> just the margin
end
# $variant_names global = (ref $Fields) of $Names, indexed by variant id, so
# $variant_field_by_name can scan a variant's field names. Built from the registry.
fun variant-names-init(ordered) -> List<Number>:
  E.concat-bytes(ordered.map(lam(d): emit-names-of(d.fields) end)).append(E.array-new-fixed(T-FIELDS, length(ordered)))
end

# ===== pre-pass: top-level binding keys (mirrored to globals) =====
# Walk the a-let/a-arr-let/a-seq spine of the program body, collecting the keys bound
# at the TOP LEVEL. These become mutable anyref globals so lambdas resolve them by
# global.get (instead of capturing), supporting forward/mutual top-level reference.
# (a-var top-level bindings are left local-only: their box semantics don't map cleanly
# to a value global — TODO(port).)
fun collect-toplevel(e, acc):
  cases(N.AExpr) e:
    | a-let(_, b, _, body) => collect-toplevel(body, link(name-key(b.id), acc))
    | a-arr-let(_, b, _, _, body) => collect-toplevel(body, link(name-key(b.id), acc))
    | a-var(_, _, _, body) => collect-toplevel(body, acc)
    | a-seq(_, _, e2) => collect-toplevel(e2, acc)
    | a-type-let(_, _, body) => collect-toplevel(body, acc)
    | else => acc
  end
end

# ===== program assembler =====
# main sets $link_id/$empty_id from List's link/empty variant ids (looked up in the data
# registry) so the renderer shows lists as [list: ...] and $cons/$empty_list build
# well-formed variants. If the program defines no such variant, the global stays -1.
fun gid-init(dreg, name :: String, gi :: Number) -> List<Number>:
  cases(Option) dreg-find(dreg, name):
    | none => empty
    | some(d) => E.i32-const(d.id).append(E.global-set(gi))
  end
end

fun compile-prog(prog) -> List<Number>:
  cases(N.AProg) prog:
    | a-program(l, provides, imports, body) =>
      lams-raw = collect-lams-expr(body, empty).reverse()   # source order
      dreg = collect-data-expr(body, empty)                 # registry (ids by encounter)
      gvars = collect-gvars-expr(body, empty)               # a-var-bound keys
      num-rt = length(RT-FUNS)
      num-ctors = length(dreg)
      ordered = ctors-by-id(dreg, 0, num-ctors)             # ctors in id order
      # globals: [runtime block 0..NUM-RT-GLOBALS-1][$variant_names][top-level...].
      # $variant_names is ALWAYS emitted at GI-VARIANT-NAMES (empty $Fields when no
      # variants) because the $variant_field_by_name kernel references it
      # unconditionally; top-level globals follow it (gbase = NUM-RT-GLOBALS + 1).
      # globals: [runtime block][$variant_names @ NUM-RT-GLOBALS][$variant_methods @ +1]
      # [top-level globals @ +2 ...].
      gbase = R.NUM-RT-GLOBALS + 2
      tl-keys = collect-toplevel(body, empty).reverse()
      num-tl = length(tl-keys)
      gmap = map2(lam(k, gi): {k: k, gi: gbase + gi} end, tl-keys, range(0, num-tl))
      # top-level names are resolved via globals, so DON'T capture them into closures.
      lams = lams-raw.map(lam(lr): {key: lr.key, args: lr.args, body: lr.body, fvs: fv-subtract(lr.fvs, tl-keys)} end)
      lam-map = index-pairs(lams, 0, empty)
      num-lams = length(lams)
      # funcidx space: [imports 0..NUM-IMPORTS-1][runtime][lambdas][ctors][main].
      main-funcidx = NUM-IMPORTS + (((num-rt + num-lams) + num-ctors))

      # ----- main (() -> anyref), the lambda bodies, and the ctor bodies -----
      main-ctx = ctx(empty, 0, empty, gmap, lam-map, dreg, gvars, num-lams)
      # set $link_id/$empty_id from the data registry before running the program body.
      list-id-init = gid-init(dreg, "link", R.GI-LINK-ID).append(gid-init(dreg, "empty", R.GI-EMPTY-ID))
      # allocate $variant_methods = array of `num-ctors` nulls (each a-data-expr fills its
      # variants' slots in scope). Skip when there are no variants.
      vm-init = if num-ctors == 0: empty
                else:
                  E.concat-bytes(range(0, num-ctors).map(lam(_): E.i-ref-null(110) end))
                    .append(E.array-new-fixed(T-FIELDS, num-ctors))
                    .append(E.global-set(R.GI-VARIANT-METHODS))
                end
      # Body is compiled NON-tail so we can run the check summary after it and still
      # return the program value. If any `check:` ran ($total > 0), call the host
      # check_summary($passed,$total); otherwise (normal programs) skip it (no spurious
      # "0 tests passed" line). The program value V stays on the stack across the `if`.
      check-summary-instrs =
        E.global-get(R.GI-TOTAL).append(E.i32-const(0)).append(E.i32-gt-s)
          .append(E.i-if(E.bt-empty))
          .append(E.global-get(R.GI-PASSED)).append(E.global-get(R.GI-TOTAL))
          .append(E.i-call(host-funcidx("check_summary")))
          .append(E.end-instr)
      # NB: assemble with concat-bytes (tail-recursive), NOT `huge-body.append(...)` —
      # appending onto the whole compiled body recurses to its length and overflows.
      # build main's body FIRST (updating max-local-used), THEN read it for locals-decl.
      main-body-bytes = block:
        max-local-used := 0   # main() has no params
        E.concat-bytes([list: list-id-init, vm-init,
          compile-aexpr(body, main-ctx, false), check-summary-instrs])
      end
      main-code = E.code-entry(locals-decl(0), main-body-bytes)
      # ----- resume (() -> anyref): tail-call the captured continuation ($paused-thunk).
      # The JS trampoline (run-stoppable.ts) calls the exported `resume` after each pause
      # (do_pause throw). 0 locals; validates even with no closures (the table is always
      # declared). Sits right after main in the funcidx space. Mirrors the seed's $resume.
      resume-funcidx = main-funcidx + 1
      resume-body = E.concat-bytes([list:
        E.global-get(R.GI-PAUSED-THUNK),                                    # arg0: the thunk closure
        E.array-new-fixed(T-FIELDS, 0),                                     # arg1: empty $Fields
        E.global-get(R.GI-PAUSED-THUNK), E.ref-cast(T-CLOSURE), E.struct-get(T-CLOSURE, 0),  # selector
        E.i-return-call-indirect(closure-call-type-idx(), 0) ])
      resume-code = E.code-entry(empty, resume-body)
      lam-code = lams.map(lam(lr): compile-lam(lr, lam-map, dreg, gvars, num-lams, gmap) end)
      ctor-code = ordered.map(lam(d): compile-ctor(d) end)
      # runtime bodies already end with `end`, so build their code entries raw (code-entry
      # would append a second `end`).
      # NB: `map(f, RT-FUNS)` (function form), NOT `RT-FUNS.map(...)` — method dispatch on the
      # global RT-FUNS (built by build-runtime) currently mis-resolves under self-hosting; the
      # function form is equivalent and works. TODO: root-cause the a-method-app-on-global path.
      rt-code = map(lam(rf): E.byte-vec(E.vec(rf.locals).append(rf.body)) end, RT-FUNS)

      # ----- type section: GC rec-group ++ a func type per runtime fn ++ closure ++ main
      #       ++ one func type per host import (referenced by the import section) -----
      rt-types = map(lam(rf): E.func-type-vt(rf.params, rf.results) end, RT-FUNS)
      closure-type = E.func-type-vt([list: E.anyref, E.reftnull(T-FIELDS)], [list: E.anyref])
      main-type = E.func-type-vt(empty, [list: E.anyref])
      import-types = R.host-imports.map(lam(hi): E.func-type-vt(hi.params, hi.results) end)
      type-c = E.vec(link(gc-rec-group(), rt-types.append([list: closure-type, main-type]).append(import-types)))

      # ----- func section: a type index per function (runtime ++ lambdas ++ ctors ++ main) -----
      rt-func-decls = range(0, num-rt).map(lam(i): E.leb-u(NUM-GC-TYPES + i) end)
      lam-func-decls = range(0, num-lams).map(lam(_): E.leb-u(closure-call-type-idx()) end)
      ctor-func-decls = range(0, num-ctors).map(lam(_): E.leb-u(closure-call-type-idx()) end)
      func-c = E.vec(rt-func-decls.append(lam-func-decls).append(ctor-func-decls).append([list: E.leb-u(main-type-idx()), E.leb-u(main-type-idx())]))

      # ----- table + element segment: lambda funcidxs then ctor funcidxs -----
      # ALWAYS declare table 0 (even size 0): the runtime kernels themselves use
      # call_indirect (closure dispatch), so `call_indirect` must validate even when the
      # user program defines no lambdas/ctors. An empty table validates fine; it's only
      # indexed at runtime when a real closure exists.
      num-slots = num-lams + num-ctors
      table-c = E.vec([list: E.table-entry([list: 112], num-slots)])   # 112 = funcref
      lam-funcidxs = range(0, num-lams).map(lam(i): NUM-IMPORTS + (num-rt + i) end)
      ctor-funcidxs = range(0, num-ctors).map(lam(j): NUM-IMPORTS + ((num-rt + num-lams) + j) end)
      all-slots = lam-funcidxs.append(ctor-funcidxs)
      elem-c = if num-slots == 0: empty
               else: E.vec([list: E.elem-active-funcs(E.i32-const(0), all-slots)]) end

      # ----- globals: $variant_names ALWAYS at global 0 (empty $Fields when no
      #       variants), then one mutable anyref global per top-level binding
      #       (null-init; set in main) -----
      vn-global = [list: E.global-entry(E.reft(T-FIELDS), 0, variant-names-init(ordered))]
      # $variant_methods: mutable (ref null $Fields), null-init; main allocates it (vm-init)
      # and each a-data-expr fills its variants' slots.
      vm-global = [list: E.global-entry(E.reftnull(T-FIELDS), 1, E.i-ref-null(T-FIELDS))]
      tl-globals = range(0, num-tl).map(lam(_): E.global-entry(E.anyref, 1, E.i-ref-null(110)) end)
      # runtime globals ($link_id/$empty_id/$passed/$total) occupy the lowest indices.
      all-globals = R.rt-globals().append(vn-global.append(vm-global.append(tl-globals)))
      global-c = if is-empty(all-globals): empty else: E.vec(all-globals) end

      # ----- import section: host functions, module "host" (occupy the low funcidxs) -----
      import-c = E.vec(map2(lam(hi, k): E.import-func("host", hi.name, import-type-idx(k)) end,
                            R.host-imports, range(0, NUM-IMPORTS)))

      # ----- linear memory (scratch for string marshalling): 1..256 pages, exported -----
      mem-c = E.vec([list: E.mem-type(1, 256)])

      # ----- exports: main (func 0) + the memory (so the host reads rendered strings) -----
      export-c = E.vec([list: E.export-entry("main", 0, main-funcidx),
                              E.export-entry("resume", 0, resume-funcidx),
                              E.export-entry("memory", 2, 0)])

      # ----- code section -----
      code-c = E.vec(rt-code.append(lam-code).append(ctor-code).append([list: main-code, resume-code]))

      E.wasm-module-of(type-c, import-c, func-c, table-c, mem-c, global-c, export-c, elem-c, code-c)
  end
end
