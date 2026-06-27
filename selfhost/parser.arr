provide *
# Recursive-descent parser for the self-hosted Pyret->WASM compiler:
# List<Tok> -> Prog (fun defs + a trailing expression). Uses ast.arr.

fun parse-args(toks, acc):   # after '(' ; collect comma-separated args until ')'
  cases(List) toks:
    | empty => raise("expected )")
    | link(t, rest) =>
      cases(Tok) t:
        | trparen => {reverse(acc); rest}
        | else =>
          a = parse-cmp(toks)
          cases(List) a.{1}:
            | empty => raise("expected , or )")
            | link(t2, r2) =>
              cases(Tok) t2:
                | tcomma => parse-args(r2, link(a.{0}, acc))
                | trparen => {reverse(link(a.{0}, acc)); r2}
                | else => raise("expected , or )")
              end
          end
      end
  end
end
fun parse-let(toks):
  cases(List) toks:
    | empty => raise("name after let")
    | link(nt, r1) =>
      cases(Tok) nt:
        | tid(nm) =>
          cases(List) r1:
            | empty => raise("expected =")
            | link(eqt, r2) =>
              cases(Tok) eqt:
                | teq =>
                  ve = parse-cmp(r2)
                  cases(List) ve.{1}:
                    | empty => raise("expected in")
                    | link(it, r3) =>
                      cases(Tok) it:
                        | tin =>
                          be = parse-cmp(r3)
                          cases(List) be.{1}:
                            | empty => raise("expected end")
                            | link(et, r4) =>
                              cases(Tok) et: | tend => {letx(nm, ve.{0}, be.{0}); r4} | else => raise("expected end") end
                          end
                        | else => raise("expected in")
                      end
                  end
                | else => raise("expected =")
              end
          end
        | else => raise("name after let")
      end
  end
end
fun parse-if(toks):   # real Pyret syntax:  if <cmp>: <cmp> else: <cmp> end
  c = parse-cmp(toks)
  cases(List) c.{1}:
    | empty => raise("expected :")
    | link(t1, r1) =>
      cases(Tok) t1:
        | tcolon =>
          th = parse-cmp(r1)
          cases(List) th.{1}:
            | empty => raise("expected else")
            | link(t2, r2) =>
              cases(Tok) t2:
                | telse =>
                  cases(List) r2:
                    | empty => raise("expected : after else")
                    | link(t3, r3) =>
                      cases(Tok) t3:
                        | tcolon =>
                          el = parse-cmp(r3)
                          cases(List) el.{1}:
                            | empty => raise("expected end")
                            | link(t4, r4) =>
                              cases(Tok) t4: | tend => {iff(c.{0}, th.{0}, el.{0}); r4} | else => raise("expected end") end
                          end
                        | else => raise("expected : after else")
                      end
                  end
                | else => raise("expected else")
              end
          end
        | else => raise("expected :")
      end
  end
end
fun parse-factor(toks):
  cases(List) toks:
    | empty => raise("unexpected end")
    | link(t, rest) =>
      cases(Tok) t:
        | tnum(v) => {num(v); rest}
        | tif => parse-if(rest)
        | tlet => parse-let(rest)
        | tid(nm) =>
          cases(List) rest:
            | empty => {vref(nm); rest}
            | link(t2, r2) =>
              cases(Tok) t2:
                | tlparen =>
                  a = parse-args(r2, empty)
                  {app(nm, a.{0}); a.{1}}
                | else => {vref(nm); rest}
              end
          end
        | tlparen =>
          inner = parse-cmp(rest)
          cases(List) inner.{1}:
            | empty => raise("missing )")
            | link(rp, after) => {inner.{0}; after}
          end
        | else => raise("parse error")
      end
  end
end
fun parse-term-rest(acc, toks):
  cases(List) toks: | empty => {acc; toks}
    | link(t, rest) => cases(Tok) t: | ttimes => r = parse-factor(rest)
                                          parse-term-rest(mul(acc, r.{0}), r.{1})
                                      | else => {acc; toks} end end
end
fun parse-term(toks): f = parse-factor(toks)
  parse-term-rest(f.{0}, f.{1}) end
fun parse-add-rest(acc, toks):
  cases(List) toks: | empty => {acc; toks}
    | link(t, rest) => cases(Tok) t:
        | tplus => r = parse-term(rest)
                   parse-add-rest(add(acc, r.{0}), r.{1})
        | tminus => r = parse-term(rest)
                    parse-add-rest(sub(acc, r.{0}), r.{1})
        | else => {acc; toks} end end
end
fun parse-add(toks): t = parse-term(toks)
  parse-add-rest(t.{0}, t.{1}) end
fun parse-cmp(toks):
  a = parse-add(toks)
  cases(List) a.{1}: | empty => a
    | link(t, rest) => cases(Tok) t:
        | tlt => r = parse-add(rest)
                 {lt(a.{0}, r.{0}); r.{1}}
        | tgt => r = parse-add(rest)
                 {gt(a.{0}, r.{0}); r.{1}}
        | else => a end end
end
# function definitions: fun NAME ( params ) : body end
fun parse-params(toks, acc):   # after '(' ; comma-separated names until ')'
  cases(List) toks:
    | empty => raise("expected )")
    | link(t, rest) =>
      cases(Tok) t:
        | trparen => {reverse(acc); rest}
        | tid(nm) =>
          cases(List) rest:
            | empty => raise("expected , or )")
            | link(t2, r2) =>
              cases(Tok) t2:
                | tcomma => parse-params(r2, link(nm, acc))
                | trparen => {reverse(link(nm, acc)); r2}
                | else => raise("expected , or )")
              end
          end
        | else => raise("expected param name")
      end
  end
end
fun expect-tok-after(toks, which):   # which: 0=lparen 1=colon 2=end
  cases(List) toks:
    | empty => raise("unexpected end of def")
    | link(t, rest) =>
      cases(Tok) t:
        | tlparen => if which == 0: rest else: raise("expected (") end
        | tcolon => if which == 1: rest else: raise("expected :") end
        | tend => if which == 2: rest else: raise("expected end") end
        | else => raise("unexpected token in def")
      end
  end
end
fun parse-fundef(toks):   # after 'fun'
  cases(List) toks:
    | empty => raise("expected function name")
    | link(nt, r1) =>
      cases(Tok) nt:
        | tid(nm) =>
          r2 = expect-tok-after(r1, 0)        # (
          ps = parse-params(r2, empty)
          r3 = expect-tok-after(ps.{1}, 1)    # :
          body = parse-cmp(r3)
          r4 = expect-tok-after(body.{1}, 2)  # end
          {fundef(nm, ps.{0}, body.{0}); r4}
        | else => raise("expected function name")
      end
  end
end
fun parse-defs(toks, acc):
  cases(List) toks:
    | empty => {reverse(acc); toks}
    | link(t, rest) =>
      cases(Tok) t:
        | tfun => d = parse-fundef(rest)
                  parse-defs(d.{1}, link(d.{0}, acc))
        | else => {reverse(acc); toks}
      end
  end
end
fun parse-prog(toks):
  ds = parse-defs(toks, empty)
  mainx = parse-cmp(ds.{1})
  prog(ds.{0}, mainx.{0})
end
