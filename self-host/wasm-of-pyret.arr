provide *
# wasm-of-pyret: the ANF -> WebAssembly backend for the self-hosted compiler. It
# REPLACES js-of-pyret.arr — instead of emitting JS, it walks Pyret's A-Normal-Form IR
# (ast-anf.arr) and emits a WASM-GC module via encoder.arr, on top of the value model /
# runtime emitted by runtime.arr. Mirrors the STRUCTURE of anf-loop-compiler.arr /
# js-of-pyret.arr (the real backend) so later diffing is easy.
#
# STATUS: faithful structural SKETCH. The value-model leaf forms (num/bool/str/tuple/
# obj/dot/var-cell/assign) emit real encoder bytes against the runtime's GC type indices
# (T-* from runtime.arr/types.ts). The deeper forms (closure-calling convention with a
# temp local, a-lam function-table collection, a-cases vtag dispatch + field binds,
# a-data-expr runtime registration, and the compile-prog section ASSEMBLER tie-in to
# runtime.arr's build-runtime) are `# TODO(port)` — they need the lambda-collection pass
# and the runtime index map. It parses; it does NOT run end-to-end yet.

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

# ===== runtime-function indices =====
# The function index space is [runtime fns ++ user lambdas ++ main] (no imports yet).
# So a runtime fn's func index == its position in build-runtime(). We resolve by name
# against the real list runtime.arr emits, so the idx-* below stay correct as the
# runtime grows/reorders.  NUM-GC-TYPES type-section entries precede the func types.
NUM-GC-TYPES = 13
RT-FUNS = R.build-runtime()
fun rt-index(name :: String) -> Number: rt-index-from(RT-FUNS, name, 0) end
fun rt-index-from(fs, name :: String, i :: Number) -> Number:
  cases(List) fs:
    | empty => raise("wasm-of-pyret: no runtime fn named " + name)
    | link(f, r) => if f.name == name: i else: rt-index-from(r, name, i + 1) end
  end
end
fun idx-make-fix(): rt-index("$make_fix") end
fun idx-make-object(): rt-index("$make_object") end
fun idx-obj-get(): rt-index("$obj_get") end
fun idx-obj-extend(): rt-index("$obj_extend") end
fun idx-variant-field-by-name(): rt-index("$variant_field_by_name") end
fun idx-variant-id(): rt-index("$variant_id") end
# no $truthy / $raise runtime fn yet: bools are i31 (inline i31.get_u eventually); raise
# will be a host import. Keep placeholders so callers still type-check. TODO(port).
fun idx-truthy(): 0 end
fun idx-raise(): 0 end

# ===== compile context =====
# locals: List<{k; i}> A.Name-key -> wasm local index. vars: keys that are BOXED (a-var)
# so a-id-var/a-assign go through the 1-cell. fenv: List<{k; i}> fn-name -> table index.
# lams: List<{k; i}> lambda-loc-key -> fnIndex(=table slot), from the collect-lambdas pass.
# dreg: List<{name; id; arity}> the data registry from the collect-data pass (variant-name
# -> global variant id + field count), used by a-cases vtag dispatch + a-data-expr.
data Ctx: ctx(locals, next-local :: Number, vars, fenv, lams, dreg) end
fun name-key(n): tostring(n) end          # TODO(port): use A.Name's .key()
fun bind-local(c :: Ctx, key, idx :: Number) -> Ctx:
  ctx(link({k: key, i: idx}, c.locals), num-max(c.next-local, idx + 1), c.vars, c.fenv, c.lams, c.dreg)
end
fun bind-var(c :: Ctx, key, idx :: Number) -> Ctx:
  ctx(link({k: key, i: idx}, c.locals), num-max(c.next-local, idx + 1), link(key, c.vars), c.fenv, c.lams, c.dreg)
end
fun is-var(c :: Ctx, key) -> Boolean: c.vars.member(key) end
fun lookup-local(c :: Ctx, key):
  cases(List) c.locals:
    | empty => raise("wasm-of-pyret: unbound local " + key)
    | link(f, r) => if f.k == key: f.i else: lookup-local(ctx(r, c.next-local, c.vars, c.fenv, c.lams, c.dreg), key) end
  end
end
# variant-name -> {id; arity} option, from the data registry.
fun data-lookup(c :: Ctx, name :: String):
  cases(List) c.dreg:
    | empty => none
    | link(f, r) => if f.name == name: some(f) else: data-lookup(ctx(c.locals, c.next-local, c.vars, c.fenv, c.lams, r), name) end
  end
end
# lambda-loc-key -> its collected fnIndex (== table slot).
fun lookup-lam(c :: Ctx, key) -> Number: lookup-pair(c.lams, key) end
fun lookup-pair(ps, key) -> Number:
  cases(List) ps:
    | empty => raise("wasm-of-pyret: lambda not collected " + key)
    | link(f, r) => if f.k == key: f.i else: lookup-pair(r, key) end
  end
end

# ===== a $Str (array i8) from a Pyret string's code points =====
fun emit-str(s :: String) -> List<Number>:
  cps = string-to-code-points(s)
  E.concat(cps.map(lam(cp): E.i32-const(cp) end)).append(E.array-new-fixed(T-STR, length(cps)))
end
# read the boxed-var 1-cell at local `idx` -> its value
fun box-read(idx :: Number) -> List<Number>:
  E.local-get(idx).append(E.i32-const(0)).append(E.array-get(T-FIELDS))
end

# ===== AVal -> instructions (leaves one anyref on the stack) =====
fun compile-aval(v, c :: Ctx) -> List<Number>:
  cases(N.AVal) v:
    | a-num(l, n) =>
      # exact small ints -> $make_fix(i64). TODO(port): rationals/roughnums/bignum literals.
      E.i64-const(n).append(E.i-call(idx-make-fix()))
    | a-str(l, s) => emit-str(s)
    | a-bool(l, b) => E.i32-const(if b: 1 else: 0 end).append(E.ref-i31)
    | a-id(l, id) =>
      k = name-key(id)
      if is-var(c, k): box-read(lookup-local(c, k)) else: E.local-get(lookup-local(c, k)) end
    | a-srcloc(l, loc) => E.i-ref-null(110)                                # TODO(port): srcloc value
    | a-undefined(l) => E.i-ref-null(110)
    | a-prim-val(l, name) => E.i-ref-null(110)                             # TODO(port): primitive globals
  end
end

fun compile-avals(vs, c :: Ctx) -> List<Number>:
  E.concat(vs.map(lam(v): compile-aval(v, c) end))
end
# pack a list of already-on-stack values into a $Fields array (caller pushed them)
fun pack-fields(vs, c :: Ctx) -> List<Number>:
  compile-avals(vs, c).append(E.array-new-fixed(T-FIELDS, length(vs)))
end
# a $Names array of $Str from field names
fun emit-names(flds) -> List<Number>:
  E.concat(flds.map(lam(f): emit-str(f.name) end)).append(E.array-new-fixed(T-NAMES, length(flds)))
end

# ===== ALettable -> instructions (leaves the value; `tail` => return_call) =====
fun compile-lettable(lt, c :: Ctx, tail :: Boolean) -> List<Number>:
  cases(N.ALettable) lt:
    | a-val(l, v) => compile-aval(v, c)
    | a-id-var(l, id) =>
      k = name-key(id)
      if is-var(c, k): box-read(lookup-local(c, k)) else: E.local-get(lookup-local(c, k)) end
    | a-id-letrec(l, id, safe) => E.local-get(lookup-local(c, name-key(id)))
    | a-id-var-modref(l, id, uri, name) => E.i-ref-null(110)               # TODO(port): module ref
    | a-app(l, f, args, info) =>
      # closure-calling convention: (closure-as-anyref, $Fields)->anyref via table 0.
      # The closure is used twice (passed as arg0 AND its fnIndex is the table selector),
      # so stash it in a temp local. Stack order for call_indirect: [arg0=closure,
      # arg1=fields, selector=closure.fnIndex].  tyidx = the closure-call func type.
      cl = c.next-local
      tyidx = closure-call-type-idx()
      compile-aval(f, c)
        .append(E.local-set(cl))
        .append(E.local-get(cl))                                  # arg0: the closure
        .append(pack-fields(args, c))                             # arg1: args as $Fields
        .append(E.local-get(cl)).append(E.ref-cast(T-CLOSURE)).append(E.struct-get(T-CLOSURE, 0))  # selector
        .append(if tail: E.i-return-call-indirect(tyidx, 0) else: E.i-call-indirect(tyidx, 0) end)
    | a-prim-app(l, fname, args, info) =>
      compile-avals(args, c).append(E.i-call(prim-index(fname)))
    | a-if(l, cnd, t, e) =>
      compile-aval(cnd, c)
        .append(E.i-call(idx-truthy()))
        .append(E.i-if(ANYREF-BT))
        .append(compile-aexpr(t, c, tail))
        .append(E.i-else)
        .append(compile-aexpr(e, c, tail))
        .append(E.i-end)
    | a-lam(l, name, args, ret, body) =>
      # closure value: struct.new $Closure {fnIndex, caps}.  fnIndex is the table slot the
      # collect-lambdas pass assigned this lambda (so call_indirect can reach its compiled
      # body, emitted as a separate function by the assembler).
      # TODO(port): caps = the captured free vars packed into a $Fields (currently null, so
      # only closed lambdas run); the function body reads caps from local 0.
      E.i32-const(lookup-lam(c, tostring(l))).append(E.i-ref-null(T-FIELDS)).append(E.struct-new(T-CLOSURE))
    | a-method(l, name, args, ret, body) =>
      E.i32-const(lookup-lam(c, tostring(l))).append(E.i-ref-null(T-FIELDS)).append(E.struct-new(T-CLOSURE)).append(E.struct-new(T-METHOD))
    | a-obj(l, fields) =>
      # $make_object(names, values)
      emit-names(fields)
        .append(pack-fields(fields.map(lam(f): f.value end), c))
        .append(E.i-call(idx-make-object()))
    | a-extend(l, supe, fields) =>
      compile-aval(supe, c)
        .append(emit-names(fields))
        .append(pack-fields(fields.map(lam(f): f.value end), c))
        .append(E.i-call(idx-obj-extend()))
    | a-update(l, supe, fields) => compile-aval(supe, c)                    # TODO(port): mutable update
    | a-dot(l, obj, field) =>
      compile-aval(obj, c).append(emit-str(field)).append(E.i-call(idx-obj-get()))
    | a-colon(l, obj, field) => compile-aval(obj, c)                        # TODO(port): method/field colon
    | a-get-bang(l, obj, field) =>
      # read the ref-cell field by name, then unbox the cell. TODO(port): unbox.
      compile-aval(obj, c).append(emit-str(field)).append(E.i-call(idx-variant-field-by-name()))
    | a-tuple(l, fields) =>
      # tuple = $Variant id 0, name "tuple", fields.
      E.i32-const(0).append(emit-str("tuple")).append(pack-fields(fields, c)).append(E.struct-new(T-VARIANT))
    | a-tuple-get(l, tup, index) =>
      compile-aval(tup, c)
        .append(E.ref-cast(T-VARIANT))
        .append(E.struct-get(T-VARIANT, 2))   # the $Fields
        .append(E.i32-const(index)).append(E.array-get(T-FIELDS))
    | a-cases(l, typ, val, branches, els) =>
      # vtag dispatch: stash val + its variant-id in temps, then a nested if-chain per
      # branch comparing the id (from the data registry); each matching branch binds its
      # args from the variant's $Fields by index, then runs its body; final else.
      vtmp = c.next-local
      idtmp = c.next-local + 1
      c2 = ctx(c.locals, c.next-local + 2, c.vars, c.fenv, c.lams, c.dreg)   # reserve 2 temps
      compile-aval(val, c)
        .append(E.local-set(vtmp))
        .append(E.local-get(vtmp)).append(E.i-call(idx-variant-id())).append(E.local-set(idtmp))
        .append(compile-branches(branches, vtmp, idtmp, c2, tail, els))
    | a-assign(l, id, value) =>
      # write the var's 1-cell: cell[0] := value ; assignment returns nothing.
      k = name-key(id)
      E.local-get(lookup-local(c, k))
        .append(E.i32-const(0))
        .append(compile-aval(value, c))
        .append(E.array-set(T-FIELDS))
        .append(E.i32-const(2)).append(E.ref-i31)
    | a-method-app(l, obj, meth, args) => compile-aval(obj, c)              # TODO(port): method dispatch
    | a-data-expr(l, name, namet, variants, shared) =>
      # the variant-name -> id/arity mapping is collected up front (collect-data, threaded
      # in Ctx.dreg) so a-cases can dispatch. TODO(port): emit the runtime side — per-variant
      # constructor closures (calling $make_variant with the registry id) + the $variant_names
      # global for $variant_field_by_name — and return the data value (tuple of constructors).
      E.i32-const(2).append(E.ref-i31)
    | a-ref(l, ann) => E.i-ref-null(110)                                   # TODO(port): bare ref
    | a-module(l, ans, dv, dt, prov, types, checks) => E.i-ref-null(110)   # TODO(port): module value
  end
end

# prim-app function name -> runtime index. TODO(port): exhaustive table (mirror
# js-of-pyret's prim dispatch + the seed's compileApp intrinsic ladder).
fun prim-index(fname :: String) -> Number:
  idx-raise()   # TODO(port)
end

# ===== a-cases branch chain =====
# Build a nested if/else over the variant id (in local `idtmp`), val in local `vtmp`.
fun compile-branches(branches, vtmp :: Number, idtmp :: Number, c :: Ctx, tail :: Boolean, els) -> List<Number>:
  cases(List) branches:
    | empty => compile-aexpr(els, c, tail)
    | link(br, rest) =>
      cases(N.ACasesBranch) br:
        | a-cases-branch(_, _, bname, bargs, bbody) =>
          cases(Option) data-lookup(c, bname):
            | none => compile-branches(rest, vtmp, idtmp, c, tail, els)     # unknown variant: skip
            | some(d) =>
              bound = bind-cases-args(bargs, 0, vtmp, c, empty)
              E.local-get(idtmp).append(E.i32-const(d.id)).append(E.i32-eq)
                .append(E.i-if(ANYREF-BT))
                .append(bound.code).append(compile-aexpr(bbody, bound.cx, tail))
                .append(E.i-else)
                .append(compile-branches(rest, vtmp, idtmp, c, tail, els))
                .append(E.i-end)
          end
        | a-singleton-cases-branch(_, _, bname, bbody) =>
          cases(Option) data-lookup(c, bname):
            | none => compile-branches(rest, vtmp, idtmp, c, tail, els)
            | some(d) =>
              E.local-get(idtmp).append(E.i32-const(d.id)).append(E.i32-eq)
                .append(E.i-if(ANYREF-BT))
                .append(compile-aexpr(bbody, c, tail))
                .append(E.i-else)
                .append(compile-branches(rest, vtmp, idtmp, c, tail, els))
                .append(E.i-end)
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
fun compile-aexpr(e, c :: Ctx, tail :: Boolean) -> List<Number>:
  cases(N.AExpr) e:
    | a-let(l, b, lt, body) =>
      idx = c.next-local
      compile-lettable(lt, c, false)
        .append(E.local-set(idx))
        .append(compile-aexpr(body, bind-local(c, name-key(b.id), idx), tail))
    | a-var(l, b, lt, body) =>
      # box the value into a 1-cell $Fields so closures share the mutation.
      idx = c.next-local
      compile-lettable(lt, c, false)
        .append(E.array-new-fixed(T-FIELDS, 1))
        .append(E.local-set(idx))
        .append(compile-aexpr(body, bind-var(c, name-key(b.id), idx), tail))
    | a-seq(l, e1, e2) =>
      compile-lettable(e1, c, false).append(E.i-drop).append(compile-aexpr(e2, c, tail))
    | a-lettable(l, lt) => compile-lettable(lt, c, tail)
    | a-type-let(l, bind, body) => compile-aexpr(body, c, tail)            # types erased
    | a-arr-let(l, b, idx2, lt, body) =>
      slot = c.next-local
      compile-lettable(lt, c, false)
        .append(E.local-set(slot))
        .append(compile-aexpr(body, bind-local(c, name-key(b.id), slot), tail))
  end
end

# ===== pre-pass: collect lambdas (so each gets a stable fnIndex/table slot) =====
# Walk the whole program collecting every a-lam/a-method in source order. Each record:
# { key: loc-string, args, body }. fnIndex == position in this list.
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
    | a-lam(l, _, args, _, body) => collect-lams-expr(body, link({key: tostring(l), args: args, body: body}, acc))
    | a-method(l, _, args, _, body) => collect-lams-expr(body, link({key: tostring(l), args: args, body: body}, acc))
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

# ===== pre-pass: collect the data registry (variant-name -> {id; arity}) =====
# Global, unique variant ids assigned in encounter order, used both by a-cases dispatch
# and (TODO) a-data-expr constructors.
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
          | a-variant(_, _, vname, members, _) => link({name: vname, id: length(a), arity: length(members)}, a)
          | a-singleton-variant(_, vname, _) => link({name: vname, id: length(a), arity: 0}, a)
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
    E.array-type(E.field(E.reft(6), 0)),                                               # 10 $Names
    E.struct-type([list: E.field(E.reft(10), 0), E.field(E.reft(7), 0)]),              # 11 $Object
    E.struct-type([list: E.field(E.reft(9), 0)]) ])                                    # 12 $Method
end

# type index of the closure-call func type ((closure-as-anyref, $Fields)->anyref): it
# follows the GC rec-group (NUM-GC-TYPES indices) and one func type per runtime fn.
fun closure-call-type-idx(): NUM-GC-TYPES + length(RT-FUNS) end
fun main-type-idx(): NUM-GC-TYPES + length(RT-FUNS) + 1 end

LOCAL-BUDGET = 512   # anyref locals declared per function (over-declared; unused are legal)

# assign each collected lambda its fnIndex (== source position) -> List<{k; i}>
fun index-pairs(items, i :: Number, acc):
  cases(List) items:
    | empty => acc.reverse()
    | link(f, r) => index-pairs(r, i + 1, link({k: f.key, i: i}, acc))
  end
end

# compile one lambda to a code entry: copy args out of the $Fields param (local 1) into
# fresh locals, then the body in tail position.  caps (free vars from local 0) are TODO.
fun compile-lam(lr, lam-map, dreg) -> List<Number>:
  bound = setup-args(lr.args, ctx(empty, 2, empty, empty, lam-map, dreg), empty)
  body-code = compile-aexpr(lr.body, bound.cx, true)
  E.code-entry([list: E.local-decl(LOCAL-BUDGET, E.anyref)], bound.code.append(body-code))
end
fun setup-args(args, c :: Ctx, code):
  cases(List) args:
    | empty => { code: code, cx: c }
    | link(ab, rest) =>
      slot = c.next-local
      c2 = bind-local(c, name-key(ab.id), slot)
      step = E.local-get(1).append(E.i32-const(slot - 2)).append(E.array-get(T-FIELDS)).append(E.local-set(slot))
      setup-args(rest, c2, code.append(step))
  end
end

# ===== program assembler =====
fun compile-prog(prog) -> List<Number>:
  cases(N.AProg) prog:
    | a-program(l, provides, imports, body) =>
      lams = collect-lams-expr(body, empty).reverse()       # source order
      dreg = collect-data-expr(body, empty)                 # registry (ids by encounter)
      lam-map = index-pairs(lams, 0, empty)
      num-rt = length(RT-FUNS)
      num-lams = length(lams)
      main-funcidx = num-rt + num-lams

      # ----- main (() -> anyref) and the lambda bodies -----
      main-ctx = ctx(empty, 0, empty, empty, lam-map, dreg)
      main-code = E.code-entry([list: E.local-decl(LOCAL-BUDGET, E.anyref)], compile-aexpr(body, main-ctx, true))
      lam-code = lams.map(lam(lr): compile-lam(lr, lam-map, dreg) end)
      # runtime bodies already end with `end`, so build their code entries raw (code-entry
      # would append a second `end`).
      rt-code = RT-FUNS.map(lam(rf): E.byte-vec(E.vec(rf.locals).append(rf.body)) end)

      # ----- type section: GC rec-group ++ a func type per runtime fn ++ closure ++ main -----
      rt-types = RT-FUNS.map(lam(rf): E.func-type-vt(rf.params, rf.results) end)
      closure-type = E.func-type-vt([list: E.anyref, E.reftnull(T-FIELDS)], [list: E.anyref])
      main-type = E.func-type-vt(empty, [list: E.anyref])
      type-c = E.vec(link(gc-rec-group(), rt-types.append([list: closure-type, main-type])))

      # ----- func section: a type index per function (runtime ++ lambdas ++ main) -----
      rt-func-decls = range(0, num-rt).map(lam(i): E.leb-u(NUM-GC-TYPES + i) end)
      lam-func-decls = range(0, num-lams).map(lam(_): E.leb-u(closure-call-type-idx()) end)
      func-c = E.vec(rt-func-decls.append(lam-func-decls).append([list: E.leb-u(main-type-idx())]))

      # ----- table + element segment: lambda funcidxs at slots 0..num-lams-1 -----
      table-c = E.vec([list: E.table-entry([list: 112], num-lams)])   # 112 = funcref
      lam-funcidxs = range(0, num-lams).map(lam(i): num-rt + i end)
      elem-c = if num-lams == 0: empty
               else: E.vec([list: E.elem-active-funcs(E.i32-const(0), lam-funcidxs)]) end

      # ----- export main -----
      export-c = E.vec([list: E.export-entry("main", 0, main-funcidx)])

      # ----- code section -----
      code-c = E.vec(rt-code.append(lam-code).append([list: main-code]))

      E.wasm-module-of(type-c, empty, func-c, table-c, empty, empty, export-c, elem-c, code-c)
  end
end
