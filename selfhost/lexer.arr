provide *
# Lexer for the self-hosted Pyret->WASM compiler: code points -> List<Tok>.
# (Uses list-eq from encoder.arr and the Tok type from ast.arr.)

fun lex-num(cps, acc):
  cases(List) cps: | empty => {tnum(acc); empty}
    | link(c, rest) => if (c >= 48) and (c <= 57): lex-num(rest, (acc * 10) + (c - 48)) else: {tnum(acc); cps} end end
end
fun lex-word(cps, acc):
  cases(List) cps: | empty => {acc; empty}
    | link(c, rest) => if (c >= 97) and (c <= 122): lex-word(rest, link(c, acc)) else: {acc; cps} end end
end
fun word-token(w):
  if list-eq(w, [list: 105, 102]): tif
  else if list-eq(w, [list: 116, 104, 101, 110]): tthen
  else if list-eq(w, [list: 101, 108, 115, 101]): telse
  else if list-eq(w, [list: 101, 110, 100]): tend
  else if list-eq(w, [list: 108, 101, 116]): tlet
  else if list-eq(w, [list: 105, 110]): tin
  else if list-eq(w, [list: 102, 117, 110]): tfun
  else: tid(w) end
end
fun lex(cps):
  cases(List) cps: | empty => empty
    | link(c, rest) =>
      if (c == 32) or (c == 10): lex(rest)
      else if c == 43: link(tplus, lex(rest))
      else if c == 45: link(tminus, lex(rest))
      else if c == 42: link(ttimes, lex(rest))
      else if c == 40: link(tlparen, lex(rest))
      else if c == 41: link(trparen, lex(rest))
      else if c == 60: link(tlt, lex(rest))
      else if c == 62: link(tgt, lex(rest))
      else if c == 61: link(teq, lex(rest))
      else if c == 58: link(tcolon, lex(rest))
      else if c == 44: link(tcomma, lex(rest))
      else if (c >= 97) and (c <= 122):
        w = lex-word(cps, empty)
        link(word-token(reverse(w.{0})), lex(w.{1}))
      else if (c >= 48) and (c <= 57):
        n = lex-num(cps, 0)
        link(n.{0}, lex(n.{1}))
      else: raise("lex error")
      end
  end
end
