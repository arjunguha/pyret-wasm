#lang pyret

provide *
provide-types *
import ast as A

### ===========================================================================
### A PURE-PYRET Pyret parser (NO JavaScript).
###
### This is the START of a hand-rolled tokenizer + recursive-descent parser that
### turns Pyret source text into the `ast.arr` AST (the same AST the real Pyret
### front-end consumes).  It exists to eventually REPLACE the temporary JS GLR
### parser the self-hosted compiler currently leans on: the self-hosting goal
### requires that the in-Pyret compiler parse Pyret *in Pyret*, with no JS.
###
### References mirrored:
###   * grammar : pyret/lang/src/js/base/pyret-grammar.bnf
###   * lexer   : pyret/lang/src/js/base/pyret-tokenizer.js
###   * AST     : self-compiler/trove/ast.arr
###
### COVERAGE (this is a START, not the whole grammar):
###   tokenizer : numbers (int / fraction / decimal-best-effort / ~rough),
###               strings ("..." and '...' with common escapes), names with
###               internal dashes, line + block comments, all the operators and
###               punctuation the core needs, and the whitespace-before flag on
###               `(` so application can be told apart from grouping.
###   parser    : program + prelude (import / include / provide), and a solid
###               expression/statement core: fun / lam / method / data / cases /
###               if / ask / when / for / let / var / rec / assign / check /
###               binops (left-assoc, parens-for-mixed is the caller's job) /
###               application / dot / method-call / get-bang / extend / update /
###               tuple-get / [list: ...] constructs / {obj} / {tuple} / literals.
###
### Things deliberately left as `# TODO(grammar)`: type/newtype/type-let,
### contract statements, spy, tables/reactor/load-table, full annotation grammar
### (arrow/record/app/pred/tuple anns), real source locations (we use dummy-loc),
### and the precedence-free *rejection* of mixed operators (we parse them
### left-assoc; well-formedness in the real pipeline is where that is enforced).
### See self-host/pyret-parser-notes.md for the plan to reach the full grammar.
### ===========================================================================

dl = A.dummy-loc

### ---- character codes ------------------------------------------------------
fun cc(s :: String) -> Number:
  cases(List) string-to-code-points(s):
    | empty => 0
    | link(f, _) => f
  end
end

c-tab    = 9
c-nl     = 10
c-vtab   = 11
c-ff     = 12
c-cr     = 13
c-space  = 32
c-bang   = cc("!")
c-dquote = cc("\"")
c-hash   = cc("#")
c-percent = cc("%")
c-squote = cc("'")
c-lparen = cc("(")
c-rparen = cc(")")
c-star   = cc("*")
c-plus   = cc("+")
c-comma  = cc(",")
c-dash   = cc("-")
c-dot    = cc(".")
c-slash  = cc("/")
c-0      = cc("0")
c-9      = cc("9")
c-colon  = cc(":")
c-semi   = cc(";")
c-lt     = cc("<")
c-eq     = cc("=")
c-gt     = cc(">")
c-at     = cc("@")
c-A      = cc("A")
c-Z      = cc("Z")
c-lbrack = cc("[")
c-bslash = cc("\\")
c-rbrack = cc("]")
c-caret  = cc("^")
c-under  = cc("_")
c-bquote = cc("`")
c-a      = cc("a")
c-z      = cc("z")
c-lbrace = cc("{")
c-bar    = cc("|")
c-rbrace = cc("}")
c-tilde  = cc("~")

fun is-ws(c :: Number) -> Boolean:
  (c == c-space) or (c == c-tab) or (c == c-nl) or (c == c-cr) or (c == c-ff) or (c == c-vtab)
end
fun is-digit(c :: Number) -> Boolean: (c >= c-0) and (c <= c-9) end
fun is-alpha(c :: Number) -> Boolean:
  ((c >= c-A) and (c <= c-Z)) or ((c >= c-a) and (c <= c-z))
end
fun is-ident-start(c :: Number) -> Boolean: is-alpha(c) or (c == c-under) end
fun is-ident-cont(c :: Number) -> Boolean: is-ident-start(c) or is-digit(c) end

fun cp-str(c :: Number) -> String: string-from-code-point(c) end

### ---- tokens ---------------------------------------------------------------
### kind is one of:
###   "NAME" "NUMBER" "ROUGHNUMBER" "STRING"
###   "OP"           (value is the operator text: + - * / ^ < > <= >= == =~ <> <=>)
###   "LPAREN" "RPAREN" "LBRACK" "RBRACK" "LBRACE" "RBRACE"
###   "COLON" "COLONCOLON" "COLONEQUALS" "COMMA" "SEMI" "DOT" "BANG"
###   "EQUALS" "THINARROW" "THICKARROW" "BAR" "DOTDOTDOT" "EOF"
### ws-before is true when whitespace / a comment / a newline preceded this token;
### it is what lets `f(x)` (application) be told apart from `f (x)` (grouping).
data Token:
  | tok(kind :: String, value :: String, ws-before :: Boolean)
end

tok-eof = tok("EOF", "", true)

### A small carrier for "I consumed some prefix, here is the rest".
data Span:
  | span(text :: String, rest :: List<Number>)
end

fun cp-nth(cps :: List<Number>, i :: Number) -> Number:
  cases(List) cps:
    | empty => -1
    | link(f, r) => if i <= 0: f else: cp-nth(r, i - 1) end
  end
end

### scan identifier continuation (the first char was already classified as start).
### Pyret identifiers allow internal dashes: a `-` is part of the name when the
### following character continues an identifier (e.g. is-empty, string-length).
fun scan-ident-rest(cps :: List<Number>) -> Span:
  cases(List) cps:
    | empty => span("", empty)
    | link(c, r) =>
      if is-ident-cont(c):
        s = scan-ident-rest(r)
        span(cp-str(c) + s.text, s.rest)
      else if (c == c-dash) and is-ident-cont(cp-nth(r, 0)):
        s = scan-ident-rest(r)
        span("-" + s.text, s.rest)
      else:
        span("", cps)
      end
  end
end

### scan a run of digits.
fun scan-digits(cps :: List<Number>) -> Span:
  cases(List) cps:
    | empty => span("", empty)
    | link(c, r) =>
      if is-digit(c):
        s = scan-digits(r)
        span(cp-str(c) + s.text, s.rest)
      else:
        span("", cps)
      end
  end
end

### scan a number after an optional leading `~`.  Handles integers, fractions
### (a/b), decimals (a.b) and a trailing exponent (eE).  Returns the literal text
### (without the `~`); the caller tags rough/exact.
fun scan-number(cps :: List<Number>) -> Span:
  int-part = scan-digits(cps)
  after = int-part.rest
  c0 = cp-nth(after, 0)
  c1 = cp-nth(after, 1)
  if (c0 == c-slash) and is-digit(c1):
    # fraction a/b
    den = scan-digits(after.rest)
    span(int-part.text + "/" + den.text, den.rest)
  else if (c0 == c-dot) and is-digit(c1):
    # decimal a.b
    frac = scan-digits(after.rest)
    rest2 = frac.rest
    scan-number-exp(int-part.text + "." + frac.text, rest2)
  else:
    scan-number-exp(int-part.text, after)
  end
end

fun scan-number-exp(so-far :: String, cps :: List<Number>) -> Span:
  c0 = cp-nth(cps, 0)
  if (c0 == cc("e")) or (c0 == cc("E")):
    c1 = cp-nth(cps, 1)
    if (c1 == c-plus) or (c1 == c-dash):
      if is-digit(cp-nth(cps, 2)):
        d = scan-digits(cps.rest.rest)
        span(so-far + "e" + cp-str(c1) + d.text, d.rest)
      else:
        span(so-far, cps)
      end
    else if is-digit(c1):
      d = scan-digits(cps.rest)
      span(so-far + "e" + d.text, d.rest)
    else:
      span(so-far, cps)
    end
  else:
    span(so-far, cps)
  end
end

### scan a quoted string up to the matching quote, handling common escapes.
fun scan-string(cps :: List<Number>, q :: Number) -> Span:
  cases(List) cps:
    | empty => span("", empty)  # TODO(grammar): unterminated-string error
    | link(c, r) =>
      if c == q:
        span("", r)
      else if c == c-bslash:
        cases(List) r:
          | empty => span("", empty)
          | link(e, r2) =>
            s = scan-string(r2, q)
            span(unescape(e) + s.text, s.rest)
        end
      else:
        s = scan-string(r, q)
        span(cp-str(c) + s.text, s.rest)
      end
  end
end

fun unescape(e :: Number) -> String:
  if e == cc("n"): "\n"
  else if e == cc("t"): "\t"
  else if e == cc("r"): "\r"
  else if e == c-dquote: "\""
  else if e == c-squote: "'"
  else if e == c-bslash: "\\"
  else: cp-str(e)  # TODO(grammar): \uXXXX \xXX \NNN octal
  end
end

### skip a line comment (`# ...`) up to (not including) the newline.
fun skip-line(cps :: List<Number>) -> List<Number>:
  cases(List) cps:
    | empty => empty
    | link(c, r) => if c == c-nl: cps else: skip-line(r) end
  end
end

### skip a block comment `#| ... |#` (no nesting yet). `cps` starts just after `#|`.
fun skip-block(cps :: List<Number>) -> List<Number>:
  cases(List) cps:
    | empty => empty
    | link(c, r) =>
      if (c == c-bar) and (cp-nth(r, 0) == c-hash): r.rest
      else: skip-block(r)
      end
  end
end

### ---- the tokenizer --------------------------------------------------------
fun tokenize(src :: String) -> List<Token>:
  lex(string-to-code-points(src), true)
end

fun lex(cps :: List<Number>, ws :: Boolean) -> List<Token>:
  cases(List) cps:
    | empty => link(tok-eof, empty)
    | link(c, r) =>
      if is-ws(c):
        lex(r, true)
      else if c == c-hash:
        if cp-nth(r, 0) == c-bar:
          lex(skip-block(r.rest), true)
        else:
          lex(skip-line(r), true)
        end
      else if is-digit(c):
        s = scan-number(cps)
        link(tok("NUMBER", s.text, ws), lex(s.rest, false))
      else if (c == c-tilde) and is-digit(cp-nth(r, 0)):
        s = scan-number(r)
        link(tok("ROUGHNUMBER", s.text, ws), lex(s.rest, false))
      else if is-ident-start(c):
        s = scan-ident-rest(r)
        link(tok("NAME", cp-str(c) + s.text, ws), lex(s.rest, false))
      else if (c == c-dquote) or (c == c-squote):
        s = scan-string(r, c)
        link(tok("STRING", s.text, ws), lex(s.rest, false))
      else:
        lex-punct(cps, ws)
      end
  end
end

### operators and punctuation, longest-match first.
fun lex-punct(cps :: List<Number>, ws :: Boolean) -> List<Token>:
  c0 = cp-nth(cps, 0)
  c1 = cp-nth(cps, 1)
  c2 = cp-nth(cps, 2)
  fun emit(k :: String, v :: String, n :: Number):
    link(tok(k, v, ws), lex(drop-n(cps, n), false))
  end
  # 3-char
  if (c0 == c-lt) and (c1 == c-eq) and (c2 == c-gt): emit("OP", "<=>", 3)
  else if (c0 == c-dot) and (c1 == c-dot) and (c2 == c-dot): emit("DOTDOTDOT", "...", 3)
  # 2-char
  else if (c0 == c-lt) and (c1 == c-eq): emit("OP", "<=", 2)
  else if (c0 == c-gt) and (c1 == c-eq): emit("OP", ">=", 2)
  else if (c0 == c-eq) and (c1 == c-eq): emit("OP", "==", 2)
  else if (c0 == c-eq) and (c1 == c-tilde): emit("OP", "=~", 2)
  else if (c0 == c-lt) and (c1 == c-gt): emit("OP", "<>", 2)
  else if (c0 == c-dash) and (c1 == c-gt): emit("THINARROW", "->", 2)
  else if (c0 == c-eq) and (c1 == c-gt): emit("THICKARROW", "=>", 2)
  else if (c0 == c-colon) and (c1 == c-eq): emit("COLONEQUALS", ":=", 2)
  else if (c0 == c-colon) and (c1 == c-colon): emit("COLONCOLON", "::", 2)
  # 1-char operators
  else if c0 == c-plus: emit("OP", "+", 1)
  else if c0 == c-dash: emit("OP", "-", 1)
  else if c0 == c-star: emit("OP", "*", 1)
  else if c0 == c-slash: emit("OP", "/", 1)
  else if c0 == c-caret: emit("OP", "^", 1)
  else if c0 == c-lt: emit("OP", "<", 1)
  else if c0 == c-gt: emit("OP", ">", 1)
  # 1-char punctuation
  else if c0 == c-lparen: emit("LPAREN", "(", 1)
  else if c0 == c-rparen: emit("RPAREN", ")", 1)
  else if c0 == c-lbrack: emit("LBRACK", "[", 1)
  else if c0 == c-rbrack: emit("RBRACK", "]", 1)
  else if c0 == c-lbrace: emit("LBRACE", "{", 1)
  else if c0 == c-rbrace: emit("RBRACE", "}", 1)
  else if c0 == c-colon: emit("COLON", ":", 1)
  else if c0 == c-comma: emit("COMMA", ",", 1)
  else if c0 == c-semi: emit("SEMI", ";", 1)
  else if c0 == c-dot: emit("DOT", ".", 1)
  else if c0 == c-bang: emit("BANG", "!", 1)
  else if c0 == c-percent: emit("PERCENT", "%", 1)
  else if c0 == c-eq: emit("EQUALS", "=", 1)
  else if c0 == c-bar: emit("BAR", "|", 1)
  else:
    # TODO(grammar): BAD-OPER / UNKNOWN — for now, skip the offending char.
    lex(drop-n(cps, 1), false)
  end
end

fun drop-n(cps :: List<Number>, n :: Number) -> List<Number>:
  if n <= 0: cps
  else:
    cases(List) cps:
      | empty => empty
      | link(_, r) => drop-n(r, n - 1)
    end
  end
end

### ===========================================================================
### Parser state: a mutable cursor over the token list.  The cursor is a single
### top-level `var` (the remaining tokens); every parse function takes a `PState`
### handle for readability, but the real state lives in `tok-stream`.  (We use a
### top-level var rather than a mutable record field because the seed compiler
### does not yet support ref-field reads.)  NB: this makes parsing single-shot,
### which is fine for our use (one `parse` call at a time).
### ===========================================================================
data PState:
  | p-state
end

var tok-stream :: List<Token> = empty

fun p-peek(st :: PState) -> Token:
  cases(List) tok-stream:
    | empty => tok-eof
    | link(f, _) => f
  end
end

fun p-peek2(st :: PState) -> Token:
  cases(List) tok-stream:
    | empty => tok-eof
    | link(_, r) =>
      cases(List) r:
        | empty => tok-eof
        | link(g, _) => g
      end
  end
end

fun p-advance(st :: PState) -> Token:
  cases(List) tok-stream:
    | empty => tok-eof
    | link(f, r) =>
      tok-stream := r
      f
  end
end

fun at-kind(st :: PState, k :: String) -> Boolean: p-peek(st).kind == k end
fun at-eof(st :: PState) -> Boolean: at-kind(st, "EOF") end
fun at-name(st :: PState, v :: String) -> Boolean:
  t = p-peek(st)
  (t.kind == "NAME") and (t.value == v)
end
fun at-op(st :: PState, v :: String) -> Boolean:
  t = p-peek(st)
  (t.kind == "OP") and (t.value == v)
end
fun peek2-name(st :: PState, v :: String) -> Boolean:
  t = p-peek2(st)
  (t.kind == "NAME") and (t.value == v)
end
fun peek2-kind(st :: PState, k :: String) -> Boolean: p-peek2(st).kind == k end

fun expect(st :: PState, k :: String) -> Token:
  if at-kind(st, k): p-advance(st)
  else: raise("parse error: expected " + k + " but got " + p-peek(st).kind + " '" + p-peek(st).value + "'")
  end
end

fun expect-name(st :: PState, v :: String) -> Token:
  if at-name(st, v): p-advance(st)
  else: raise("parse error: expected '" + v + "' but got '" + p-peek(st).value + "'")
  end
end

### `block:` => true (blocky), `:` => false.  Consumes the separator.
fun parse-block-or-colon(st :: PState) -> Boolean:
  if at-name(st, "block") and peek2-kind(st, "COLON"):
    p-advance(st)
    p-advance(st)
    true
  else:
    expect(st, "COLON")
    false
  end
end

### ---- annotations (minimal) ------------------------------------------------
### TODO(grammar): arrow / record / app / pred / tuple annotations.
fun parse-ann(st :: PState) -> A.Ann:
  if at-kind(st, "NAME"):
    n1 = p-advance(st).value
    if at-kind(st, "DOT"):
      p-advance(st)
      n2 = expect(st, "NAME").value
      A.a-dot(dl, A.s-name(dl, n1), n2)
    else:
      A.a-name(dl, A.s-name(dl, n1))
    end
  else:
    A.a-blank
  end
end

### ---- bindings -------------------------------------------------------------
### name-binding: [SHADOW] NAME [:: ann].  TODO(grammar): tuple-binding.
fun parse-binding(st :: PState) -> A.Bind:
  shadows = if at-name(st, "shadow"): p-advance(st) true else: false end
  nm = expect(st, "NAME").value
  ann = if at-kind(st, "COLONCOLON"):
    p-advance(st)
    parse-ann(st)
  else:
    A.a-blank
  end
  A.s-bind(dl, shadows, A.s-name(dl, nm), ann)
end

### ty-params: [< NAME (, NAME)* >]
fun parse-ty-params(st :: PState) -> List<A.Name>:
  if at-op(st, "<"):
    p-advance(st)
    names = parse-ty-param-names(st)
    if at-op(st, ">"): p-advance(st) names
    else: expect(st, "OP") names  # tolerate
    end
  else:
    empty
  end
end
fun parse-ty-param-names(st :: PState) -> List<A.Name>:
  if at-op(st, ">"): empty
  else:
    n = A.s-name(dl, expect(st, "NAME").value)
    if at-kind(st, "COMMA"):
      p-advance(st)
      link(n, parse-ty-param-names(st))
    else:
      link(n, empty)
    end
  end
end

### args: ( [binding (, binding)*] )
fun parse-args(st :: PState) -> List<A.Bind>:
  expect(st, "LPAREN")
  if at-kind(st, "RPAREN"): p-advance(st) empty
  else:
    bs = parse-binding-list(st)
    expect(st, "RPAREN")
    bs
  end
end
fun parse-binding-list(st :: PState) -> List<A.Bind>:
  b = parse-binding(st)
  if at-kind(st, "COMMA"):
    p-advance(st)
    link(b, parse-binding-list(st))
  else:
    link(b, empty)
  end
end

fun parse-return-ann(st :: PState) -> A.Ann:
  if at-kind(st, "THINARROW"):
    p-advance(st)
    parse-ann(st)
  else:
    A.a-blank
  end
end

fun parse-doc(st :: PState) -> String:
  if at-name(st, "doc") and peek2-kind(st, "COLON"):
    p-advance(st)
    p-advance(st)
    expect(st, "STRING").value
  else:
    ""
  end
end

### where-clause -> {_check-loc; _check}
fun parse-where(st :: PState) -> Option:
  if at-name(st, "where") and peek2-kind(st, "COLON"):
    p-advance(st)
    p-advance(st)
    some(parse-block(st))
  else:
    none
  end
end

### ===========================================================================
### Expressions
### ===========================================================================

### binop-expr: parsed left-associative.  Pyret has NO operator precedence, and
### mixing operators without parens is a *well-formedness* error in the real
### pipeline — so here we simply chain left-to-right and leave that check to wf.
fun parse-binop(st :: PState) -> A.Expr:
  left = parse-postfix(st)
  parse-binop-rest(st, left)
end

fun cur-binop(st :: PState) -> Option<String>:
  if at-op(st, "+"): some("op+")
  else if at-op(st, "-"): some("op-")
  else if at-op(st, "*"): some("op*")
  else if at-op(st, "/"): some("op/")
  else if at-op(st, "^"): some("op^")
  else if at-op(st, "<"): some("op<")
  else if at-op(st, ">"): some("op>")
  else if at-op(st, "<="): some("op<=")
  else if at-op(st, ">="): some("op>=")
  else if at-op(st, "=="): some("op==")
  else if at-op(st, "=~"): some("op=~")
  else if at-op(st, "<>"): some("op<>")
  else if at-op(st, "<=>"): some("op<=>")
  else if at-name(st, "and"): some("opand")
  else if at-name(st, "or"): some("opor")
  else: none
  end
end

fun parse-binop-rest(st :: PState, left :: A.Expr) -> A.Expr:
  cases(Option) cur-binop(st):
    | none => left
    | some(opname) =>
      p-advance(st)
      right = parse-postfix(st)
      parse-binop-rest(st, A.s-op(dl, dl, opname, left, right))
  end
end

### postfix chain: application, dot, method-call, get-bang, extend, update, tuple-get.
fun parse-postfix(st :: PState) -> A.Expr:
  parse-postfix-rest(st, parse-atom(st))
end

fun parse-postfix-rest(st :: PState, e :: A.Expr) -> A.Expr:
  if at-kind(st, "LPAREN") and not(p-peek(st).ws-before):
    args = parse-app-args(st)
    parse-postfix-rest(st, A.s-app(dl, e, args))
  else if at-kind(st, "DOT"):
    p-advance(st)
    if at-kind(st, "LBRACE"):
      # tuple-get  e.{N}   OR   extend  e.{fields}
      p-advance(st)
      if at-kind(st, "NUMBER"):
        idx = num-of(p-advance(st).value)
        expect(st, "RBRACE")
        parse-postfix-rest(st, A.s-tuple-get(dl, e, idx, dl))
      else:
        fields = parse-fields(st)
        expect(st, "RBRACE")
        parse-postfix-rest(st, A.s-extend(dl, e, fields))
      end
    else:
      fld = expect(st, "NAME").value
      parse-postfix-rest(st, A.s-dot(dl, e, fld))
    end
  else if at-kind(st, "BANG"):
    p-advance(st)
    if at-kind(st, "LBRACE"):
      p-advance(st)
      fields = parse-fields(st)
      expect(st, "RBRACE")
      parse-postfix-rest(st, A.s-update(dl, e, fields))
    else:
      fld = expect(st, "NAME").value
      parse-postfix-rest(st, A.s-get-bang(dl, e, fld))
    end
  else:
    e
  end
end

### app-args: ( [binop (, binop)*] )   -- the `(` is adjacent (no ws before)
fun parse-app-args(st :: PState) -> List<A.Expr>:
  expect(st, "LPAREN")
  if at-kind(st, "RPAREN"): p-advance(st) empty
  else:
    args = parse-comma-binops(st)
    expect(st, "RPAREN")
    args
  end
end

fun parse-comma-binops(st :: PState) -> List<A.Expr>:
  e = parse-binop(st)
  if at-kind(st, "COMMA"):
    p-advance(st)
    if at-kind(st, "RPAREN") or at-kind(st, "RBRACK"):
      link(e, empty)  # trailing comma
    else:
      link(e, parse-comma-binops(st))
    end
  else:
    link(e, empty)
  end
end

### atoms / primary expressions
fun parse-atom(st :: PState) -> A.Expr:
  t = p-peek(st)
  if t.kind == "NUMBER":
    p-advance(st)
    make-number(t.value)
  else if t.kind == "ROUGHNUMBER":
    p-advance(st)
    make-number(t.value)  # TODO(grammar): rough literals (s-num is exact)
  else if t.kind == "STRING":
    p-advance(st)
    A.s-str(dl, t.value)
  else if t.kind == "NAME":
    parse-name-atom(st, t.value)
  else if t.kind == "LPAREN":
    p-advance(st)
    e = parse-binop(st)
    expect(st, "RPAREN")
    A.s-paren(dl, e)
  else if t.kind == "LBRACK":
    parse-construct(st)
  else if t.kind == "LBRACE":
    parse-brace(st)
  else if t.kind == "DOTDOTDOT":
    p-advance(st)
    A.s-template(dl)
  else:
    raise("parse error: unexpected " + t.kind + " '" + t.value + "' at start of expression")
  end
end

fun parse-name-atom(st :: PState, v :: String) -> A.Expr:
  if v == "true": p-advance(st) A.s-bool(dl, true)
  else if v == "false": p-advance(st) A.s-bool(dl, false)
  else if v == "lam": parse-lam(st)
  else if v == "method": parse-method-expr(st)
  else if v == "if": parse-if(st)
  else if v == "ask": parse-ask(st)
  else if v == "cases": parse-cases(st)
  else if v == "for": parse-for(st)
  else if (v == "block") and peek2-kind(st, "COLON"):
    p-advance(st)
    p-advance(st)
    body = parse-block(st)
    expect-name(st, "end")
    A.s-user-block(dl, body)
  else:
    p-advance(st)
    A.s-id(dl, A.s-name(dl, v))
  end
end

fun make-number(txt :: String) -> A.Expr:
  if string-contains(txt, "/"):
    idx = string-index-of(txt, "/")
    n = int-of(string-substring(txt, 0, idx))
    d = int-of(string-substring(txt, idx + 1, string-length(txt)))
    A.s-frac(dl, n, d)
  else if string-contains(txt, "."):
    # TODO(grammar): real decimals; for now use the integer part.
    idx = string-index-of(txt, ".")
    A.s-num(dl, int-of(string-substring(txt, 0, idx)))
  else:
    A.s-num(dl, int-of(txt))
  end
end

fun int-of(s :: String) -> Number:
  cases(Option) string-to-number(s):
    | some(n) => n
    | none => 0
  end
end
fun num-of(s :: String) -> Number: int-of(s) end

### construct-expr / list literal:  [ [lazy] constructor : elt, ... ]
fun parse-construct(st :: PState) -> A.Expr:
  expect(st, "LBRACK")
  modifier = if at-name(st, "lazy"): p-advance(st) A.s-construct-lazy else: A.s-construct-normal end
  ctor = parse-binop(st)
  expect(st, "COLON")
  values = if at-kind(st, "RBRACK"): empty else: parse-comma-binops(st) end
  expect(st, "RBRACK")
  A.s-construct(dl, modifier, ctor, values)
end

### brace: distinguish {obj-fields} from {tuple ; ...}
fun parse-brace(st :: PState) -> A.Expr:
  expect(st, "LBRACE")
  if at-kind(st, "RBRACE"):
    p-advance(st)
    A.s-obj(dl, empty)
  else if (p-peek(st).kind == "NAME") and peek2-kind(st, "COLON"):
    fields = parse-fields(st)
    expect(st, "RBRACE")
    A.s-obj(dl, fields)
  else if at-name(st, "method"):
    fields = parse-fields(st)
    expect(st, "RBRACE")
    A.s-obj(dl, fields)
  else:
    # tuple
    items = parse-tuple-items(st)
    expect(st, "RBRACE")
    A.s-tuple(dl, items)
  end
end

fun parse-tuple-items(st :: PState) -> List<A.Expr>:
  e = parse-binop(st)
  if at-kind(st, "SEMI"):
    p-advance(st)
    if at-kind(st, "RBRACE"): link(e, empty)  # trailing semi
    else: link(e, parse-tuple-items(st))
    end
  else:
    link(e, empty)
  end
end

### fields: field (, field)* [,]    where field = key : value | method ...
fun parse-fields(st :: PState) -> List<A.Member>:
  f = parse-field(st)
  if at-kind(st, "COMMA"):
    p-advance(st)
    if at-kind(st, "RBRACE"): link(f, empty)
    else: link(f, parse-fields(st))
    end
  else:
    link(f, empty)
  end
end

fun parse-field(st :: PState) -> A.Member:
  if at-name(st, "method"):
    p-advance(st)
    key = expect(st, "NAME").value
    params = parse-ty-params(st)
    args = parse-args(st)
    ret = parse-return-ann(st)
    blocky = parse-block-or-colon(st)
    doc = parse-doc(st)
    body = parse-block(st)
    wc = parse-where(st)
    expect-name(st, "end")
    A.s-method-field(dl, key, params, args, ret, doc, body, where-loc(wc), wc, blocky)
  else:
    key = expect(st, "NAME").value
    expect(st, "COLON")
    value = parse-binop(st)
    A.s-data-field(dl, key, value)
  end
end

fun where-loc(wc :: Option) -> Option:
  cases(Option) wc:
    | none => none
    | some(_) => some(dl)
  end
end

### lam / method expressions
fun parse-lam(st :: PState) -> A.Expr:
  expect-name(st, "lam")
  params = parse-ty-params(st)
  args = parse-args(st)
  ret = parse-return-ann(st)
  blocky = parse-block-or-colon(st)
  doc = parse-doc(st)
  body = parse-block(st)
  wc = parse-where(st)
  expect-name(st, "end")
  A.s-lam(dl, "", params, args, ret, doc, body, where-loc(wc), wc, blocky)
end

fun parse-method-expr(st :: PState) -> A.Expr:
  expect-name(st, "method")
  params = parse-ty-params(st)
  args = parse-args(st)
  ret = parse-return-ann(st)
  blocky = parse-block-or-colon(st)
  doc = parse-doc(st)
  body = parse-block(st)
  wc = parse-where(st)
  expect-name(st, "end")
  A.s-method(dl, "", params, args, ret, doc, body, where-loc(wc), wc, blocky)
end

### if / else if / else
fun parse-if(st :: PState) -> A.Expr:
  expect-name(st, "if")
  test = parse-binop(st)
  blocky = parse-block-or-colon(st)
  body = parse-block(st)
  first = A.s-if-branch(dl, test, body)
  branches = link(first, parse-else-ifs(st))
  if at-name(st, "else") and peek2-kind(st, "COLON"):
    p-advance(st)
    p-advance(st)
    eb = parse-block(st)
    expect-name(st, "end")
    A.s-if-else(dl, branches, eb, blocky)
  else:
    expect-name(st, "end")
    A.s-if(dl, branches, blocky)
  end
end

fun parse-else-ifs(st :: PState) -> List<A.IfBranch>:
  if at-name(st, "else") and peek2-name(st, "if"):
    p-advance(st)  # else
    p-advance(st)  # if
    test = parse-binop(st)
    expect(st, "COLON")
    body = parse-block(st)
    link(A.s-if-branch(dl, test, body), parse-else-ifs(st))
  else:
    empty
  end
end

### ask:  | test then: body   ...  | otherwise: body
fun parse-ask(st :: PState) -> A.Expr:
  expect-name(st, "ask")
  blocky = parse-block-or-colon(st)
  res = parse-ask-branches(st)
  expect-name(st, "end")
  cases(Option) res.{1}:
    | none => A.s-if-pipe(dl, res.{0}, blocky)
    | some(eb) => A.s-if-pipe-else(dl, res.{0}, eb, blocky)
  end
end

fun parse-ask-branches(st :: PState):
  if at-kind(st, "BAR"):
    p-advance(st)
    if at-name(st, "otherwise") and peek2-kind(st, "COLON"):
      p-advance(st)
      p-advance(st)
      eb = parse-block(st)
      {empty; some(eb)}
    else:
      test = parse-binop(st)
      expect-name(st, "then")
      expect(st, "COLON")
      body = parse-block(st)
      rest = parse-ask-branches(st)
      {link(A.s-if-pipe-branch(dl, test, body), rest.{0}); rest.{1}}
    end
  else:
    {empty; none}
  end
end

### cases ( Ann ) val : | Variant(args) => body  ...  | else => body
fun parse-cases(st :: PState) -> A.Expr:
  expect-name(st, "cases")
  expect(st, "LPAREN")
  typ = parse-ann(st)
  expect(st, "RPAREN")
  val = parse-binop(st)
  blocky = parse-block-or-colon(st)
  res = parse-cases-branches(st)
  expect-name(st, "end")
  cases(Option) res.{1}:
    | none => A.s-cases(dl, typ, val, res.{0}, blocky)
    | some(eb) => A.s-cases-else(dl, typ, val, res.{0}, eb, blocky)
  end
end

fun parse-cases-branches(st :: PState):
  if at-kind(st, "BAR"):
    p-advance(st)
    if at-name(st, "else"):
      p-advance(st)
      expect(st, "THICKARROW")
      eb = parse-block(st)
      {empty; some(eb)}
    else:
      nm = expect(st, "NAME").value
      args = if at-kind(st, "LPAREN"): parse-cases-args(st) else: empty end
      expect(st, "THICKARROW")
      body = parse-block(st)
      rest = parse-cases-branches(st)
      {link(A.s-cases-branch(dl, dl, nm, args, body), rest.{0}); rest.{1}}
    end
  else:
    {empty; none}
  end
end

fun parse-cases-args(st :: PState) -> List<A.CasesBind>:
  expect(st, "LPAREN")
  if at-kind(st, "RPAREN"): p-advance(st) empty
  else:
    bs = parse-cases-bind-list(st)
    expect(st, "RPAREN")
    bs
  end
end
fun parse-cases-bind-list(st :: PState) -> List<A.CasesBind>:
  is-ref = if at-name(st, "ref"): p-advance(st) true else: false end
  b = parse-binding(st)
  cb = A.s-cases-bind(dl, if is-ref: A.s-cases-bind-ref else: A.s-cases-bind-normal end, b)
  if at-kind(st, "COMMA"):
    p-advance(st)
    link(cb, parse-cases-bind-list(st))
  else:
    link(cb, empty)
  end
end

### for iterator(bind from coll, ...) [-> ann] : body end
fun parse-for(st :: PState) -> A.Expr:
  expect-name(st, "for")
  iter = parse-postfix(st)  # the iterator function expression (no app args yet)
  expect(st, "LPAREN")
  binds = if at-kind(st, "RPAREN"): empty else: parse-for-binds(st) end
  expect(st, "RPAREN")
  ret = parse-return-ann(st)
  blocky = parse-block-or-colon(st)
  body = parse-block(st)
  expect-name(st, "end")
  A.s-for(dl, iter, binds, ret, body, blocky)
end
fun parse-for-binds(st :: PState) -> List<A.ForBind>:
  b = parse-binding(st)
  expect-name(st, "from")
  v = parse-binop(st)
  fb = A.s-for-bind(dl, b, v)
  if at-kind(st, "COMMA"):
    p-advance(st)
    link(fb, parse-for-binds(st))
  else:
    link(fb, empty)
  end
end

### ===========================================================================
### Statements and blocks
### ===========================================================================
fun parse-block(st :: PState) -> A.Expr:
  A.s-block(dl, parse-stmts(st))
end

fun at-block-end(st :: PState) -> Boolean:
  at-eof(st) or at-name(st, "end") or at-name(st, "else")
    or at-name(st, "sharing") or at-name(st, "where") or at-kind(st, "BAR")
end

fun parse-stmts(st :: PState) -> List<A.Expr>:
  if at-block-end(st): empty
  else:
    s = parse-stmt(st)
    link(s, parse-stmts(st))
  end
end

fun parse-stmt(st :: PState) -> A.Expr:
  if at-name(st, "fun"): parse-fun(st)
  else if at-name(st, "data"): parse-data(st)
  else if at-name(st, "var"): parse-var(st)
  else if at-name(st, "rec"): parse-rec(st)
  else if at-name(st, "when"): parse-when(st)
  else if at-name(st, "check") or at-name(st, "examples"): parse-check(st)
  else if at-kind(st, "NAME") and peek2-kind(st, "COLONEQUALS"):
    nm = p-advance(st).value
    p-advance(st)
    v = parse-binop(st)
    A.s-assign(dl, A.s-name(dl, nm), v)
  else if is-let-start(st):
    parse-let(st)
  else:
    # a bare expression statement, possibly a check-test (`lhs is rhs`)
    e = parse-binop(st)
    parse-check-test-rest(st, e)
  end
end

### A let-binding starts with `shadow`, or with `NAME =` / `NAME ::` (a binding,
### not the start of a larger expression like `NAME.field` or `NAME(args)`).
fun is-let-start(st :: PState) -> Boolean:
  if at-name(st, "shadow"): true
  else if at-kind(st, "NAME"):
    peek2-kind(st, "EQUALS") or peek2-kind(st, "COLONCOLON")
  else:
    false
  end
end

fun parse-let(st :: PState) -> A.Expr:
  b = parse-binding(st)
  expect(st, "EQUALS")
  v = parse-binop(st)
  A.s-let(dl, b, v, false)
end

fun parse-var(st :: PState) -> A.Expr:
  expect-name(st, "var")
  b = parse-binding(st)
  expect(st, "EQUALS")
  v = parse-binop(st)
  A.s-var(dl, b, v)
end

fun parse-rec(st :: PState) -> A.Expr:
  expect-name(st, "rec")
  b = parse-binding(st)
  expect(st, "EQUALS")
  v = parse-binop(st)
  A.s-rec(dl, b, v)
end

fun parse-when(st :: PState) -> A.Expr:
  expect-name(st, "when")
  test = parse-binop(st)
  blocky = parse-block-or-colon(st)
  body = parse-block(st)
  expect-name(st, "end")
  A.s-when(dl, test, body, blocky)
end

fun parse-check(st :: PState) -> A.Expr:
  keyword-check = at-name(st, "check")
  p-advance(st)
  nm = if at-kind(st, "STRING"): some(p-advance(st).value) else: none end
  expect(st, "COLON")
  body = parse-block(st)
  expect-name(st, "end")
  A.s-check(dl, nm, body, keyword-check)
end

### check-test: lhs [check-op rhs].  Supports is / is-not / is== / raises / satisfies.
fun parse-check-test-rest(st :: PState, left :: A.Expr) -> A.Expr:
  cases(Option) cur-check-op(st):
    | none => left
    | some(op) =>
      right = parse-binop(st)
      A.s-check-test(dl, op, none, left, some(right), none)
  end
end

fun cur-check-op(st :: PState) -> Option:
  if at-name(st, "is"):
    p-advance(st)
    if at-op(st, "=="): p-advance(st) some(A.s-op-is-op(dl, "op=="))
    else: some(A.s-op-is(dl))
    end
  else if at-name(st, "is-not"):
    p-advance(st)
    some(A.s-op-is-not(dl))
  else if at-name(st, "raises"):
    p-advance(st)
    some(A.s-op-raises(dl))
  else if at-name(st, "satisfies"):
    p-advance(st)
    some(A.s-op-satisfies(dl))
  else:
    none  # TODO(grammar): is=~ is<=> is-roughly raises-satisfies because ...
  end
end

### ---- fun / data ----------------------------------------------------------
fun parse-fun(st :: PState) -> A.Expr:
  expect-name(st, "fun")
  fname = expect(st, "NAME").value
  params = parse-ty-params(st)
  args = parse-args(st)
  ret = parse-return-ann(st)
  blocky = parse-block-or-colon(st)
  doc = parse-doc(st)
  body = parse-block(st)
  wc = parse-where(st)
  expect-name(st, "end")
  A.s-fun(dl, fname, params, args, ret, doc, body, where-loc(wc), wc, blocky)
end

fun parse-data(st :: PState) -> A.Expr:
  expect-name(st, "data")
  name = expect(st, "NAME").value
  params = parse-ty-params(st)
  expect(st, "COLON")
  variants = parse-variants(st)
  shared = if at-name(st, "sharing") and peek2-kind(st, "COLON"):
    p-advance(st)
    p-advance(st)
    parse-fields(st)
  else:
    empty
  end
  wc = parse-where(st)
  expect-name(st, "end")
  A.s-data(dl, name, params, empty, variants, shared, where-loc(wc), wc)
end

fun at-variants-end(st :: PState) -> Boolean:
  at-name(st, "end") or at-name(st, "sharing") or at-name(st, "where") or at-eof(st)
end

fun parse-variants(st :: PState) -> List<A.Variant>:
  if at-variants-end(st): empty
  else:
    if at-kind(st, "BAR"): p-advance(st) else: nothing end
    first = parse-variant(st)
    link(first, parse-variant-rest(st))
  end
end

fun parse-variant-rest(st :: PState) -> List<A.Variant>:
  if at-kind(st, "BAR"):
    p-advance(st)
    link(parse-variant(st), parse-variant-rest(st))
  else:
    empty
  end
end

fun parse-variant(st :: PState) -> A.Variant:
  vname = expect(st, "NAME").value
  if at-kind(st, "LPAREN"):
    members = parse-variant-members(st)
    withs = parse-variant-with(st)
    A.s-variant(dl, dl, vname, members, withs)
  else:
    withs = parse-variant-with(st)
    A.s-singleton-variant(dl, vname, withs)
  end
end

fun parse-variant-with(st :: PState) -> List<A.Member>:
  if at-name(st, "with") and peek2-kind(st, "COLON"):
    p-advance(st)
    p-advance(st)
    parse-fields(st)
  else:
    empty
  end
end

fun parse-variant-members(st :: PState) -> List<A.VariantMember>:
  expect(st, "LPAREN")
  if at-kind(st, "RPAREN"): p-advance(st) empty
  else:
    ms = parse-variant-member-list(st)
    expect(st, "RPAREN")
    ms
  end
end
fun parse-variant-member-list(st :: PState) -> List<A.VariantMember>:
  is-ref = if at-name(st, "ref"): p-advance(st) true else: false end
  b = parse-binding(st)
  vm = A.s-variant-member(dl, if is-ref: A.s-mutable else: A.s-normal end, b)
  if at-kind(st, "COMMA"):
    p-advance(st)
    link(vm, parse-variant-member-list(st))
  else:
    link(vm, empty)
  end
end

### ===========================================================================
### Prelude (imports / includes / provides) and the whole program
### ===========================================================================
fun parse-program(st :: PState) -> A.Program:
  preludes = parse-prelude(st)
  body = parse-block(st)
  A.s-program(dl, none, preludes.{0}, A.s-provide-types-none(dl), empty, preludes.{1}, body)
end

### Returns {provide; imports}.  Multiple `provide` statements collapse to the
### last one seen (s-provide-all if any `provide *`, else s-provide-none).
fun parse-prelude(st :: PState):
  parse-prelude-loop(st, A.s-provide-none(dl), empty)
end

fun parse-prelude-loop(st :: PState, prov :: A.Provide, imps :: List<A.Import>):
  if at-name(st, "import"):
    p-advance(st)
    imp = parse-import(st)
    parse-prelude-loop(st, prov, imps + link(imp, empty))
  else if at-name(st, "include"):
    p-advance(st)
    src = parse-import-source(st)
    parse-prelude-loop(st, prov, imps + link(A.s-include(dl, src), empty))
  else if at-name(st, "provide"):
    p-advance(st)
    new-prov = if at-op(st, "*") or at-op(st, "<>"):
      p-advance(st) A.s-provide-all(dl)
    else if at-name(st, "star"):
      p-advance(st) A.s-provide-all(dl)
    else:
      # `provide ... end` / `provide: ... end` — TODO(grammar): parse the block.
      skip-to-end(st)
      A.s-provide-all(dl)
    end
    parse-prelude-loop(st, new-prov, imps)
  else if at-name(st, "provide-types"):
    p-advance(st)
    if at-op(st, "*"): p-advance(st) else: skip-to-end(st) end
    parse-prelude-loop(st, prov, imps)
  else if at-name(st, "use"):
    # use-stmt: USE NAME import-source  -- TODO(grammar): represent s-use
    p-advance(st)
    p-advance(st)
    _ = parse-import-source(st)
    parse-prelude-loop(st, prov, imps)
  else:
    {prov; imps}
  end
end

### import-stmt:  IMPORT import-source AS NAME   (the common form)
fun parse-import(st :: PState) -> A.Import:
  src = parse-import-source(st)
  expect-name(st, "as")
  nm = expect(st, "NAME").value
  A.s-import(dl, src, A.s-name(dl, nm))
end

### import-source: import-special (NAME ( STRING, ... )) | import-name (NAME)
fun parse-import-source(st :: PState) -> A.ImportType:
  nm = expect(st, "NAME").value
  if at-kind(st, "LPAREN"):
    p-advance(st)
    args = parse-string-args(st)
    expect(st, "RPAREN")
    A.s-special-import(dl, nm, args)
  else:
    A.s-const-import(dl, nm)
  end
end

fun parse-string-args(st :: PState) -> List<String>:
  s = expect(st, "STRING").value
  if at-kind(st, "COMMA"):
    p-advance(st)
    link(s, parse-string-args(st))
  else:
    link(s, empty)
  end
end

### consume tokens up to and including a matching `end` (shallow; for prelude
### productions we do not yet model).
fun skip-to-end(st :: PState):
  if at-eof(st): nothing
  else if at-name(st, "end"): p-advance(st) nothing
  else: p-advance(st) skip-to-end(st)
  end
end

### ===========================================================================
### Entry point
### ===========================================================================
fun parse(src :: String) -> A.Program:
  tok-stream := tokenize(src)
  parse-program(p-state)
end

### parse just an expression (handy for tests / REPL-ish uses).
fun parse-expr-string(src :: String) -> A.Expr:
  tok-stream := tokenize(src)
  parse-binop(p-state)
end
