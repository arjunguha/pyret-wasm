#lang pyret

provide *
provide-types *
import ast as A
import srcloc as S

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

### tail-recursive list reverse (constant stack via the seed's native tail calls).
### The prelude's `reverse` is non-tail AND O(n^2) (append-based), so it overflows
### / is quadratic on the long token + statement lists produced by large source
### files.  We accumulate forward results in reverse, then `rev` them in one tail
### loop — keeping the whole tokenize/parse pipeline constant-stack.
fun rev-onto(l, acc):
  cases(List) l:
    | empty => acc
    | link(f, r) => rev-onto(r, link(f, acc))
  end
end
fun rev(l): rev-onto(l, empty) end

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
### Each token carries its source span: start/end as (line, column, char-offset),
### with lines 1-based and columns/char-offsets 0-based (matching Pyret's srclocs).
data Token:
  | tok(
      kind :: String, value :: String, ws-before :: Boolean,
      s-line :: Number, s-col :: Number, s-char :: Number,
      e-line :: Number, e-col :: Number, e-char :: Number)
end

tok-eof = tok("EOF", "", true, 1, 0, 0, 1, 0, 0)

### a source position: line (1-based), column + char offset (0-based).
data Pos:
  | posn(line :: Number, col :: Number, char :: Number)
end

### advance a position over one code point (newline resets column, bumps line).
fun adv1(p :: Pos, c :: Number) -> Pos:
  if c == c-nl: posn(p.line + 1, 0, p.char + 1)
  else: posn(p.line, p.col + 1, p.char + 1)
  end
end
### advance a position over a run of code points.
fun adv(p :: Pos, cps :: List<Number>) -> Pos:
  cases(List) cps:
    | empty => p
    | link(c, r) => adv(adv1(p, c), r)
  end
end

### make a token spanning [s, e); make an EOF token at p.
fun mk(s :: Pos, e :: Pos, k :: String, v :: String, ws :: Boolean) -> Token:
  tok(k, v, ws, s.line, s.col, s.char, e.line, e.col, e.char)
end
fun eof-at(p :: Pos) -> Token:
  tok("EOF", "", true, p.line, p.col, p.char, p.line, p.col, p.char)
end

### A small carrier for "I consumed some prefix (`consumed`), here is the rest".
### `consumed` is kept so the lexer can advance source positions over it.
data Span:
  | span(text :: String, consumed :: List<Number>, rest :: List<Number>)
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
    | empty => span("", empty, empty)
    | link(c, r) =>
      if is-ident-cont(c):
        s = scan-ident-rest(r)
        span(cp-str(c) + s.text, link(c, s.consumed), s.rest)
      else if (c == c-dash) and is-ident-cont(cp-nth(r, 0)):
        s = scan-ident-rest(r)
        span("-" + s.text, link(c, s.consumed), s.rest)
      else:
        span("", empty, cps)
      end
  end
end

### scan a run of digits.
fun scan-digits(cps :: List<Number>) -> Span:
  cases(List) cps:
    | empty => span("", empty, empty)
    | link(c, r) =>
      if is-digit(c):
        s = scan-digits(r)
        span(cp-str(c) + s.text, link(c, s.consumed), s.rest)
      else:
        span("", empty, cps)
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
    span(int-part.text + "/" + den.text,
      int-part.consumed + link(c-slash, den.consumed), den.rest)
  else if (c0 == c-dot) and is-digit(c1):
    # decimal a.b (+ optional exponent)
    frac = scan-digits(after.rest)
    sn = scan-number-exp(int-part.text + "." + frac.text, frac.rest)
    span(sn.text, int-part.consumed + link(c-dot, frac.consumed) + sn.consumed, sn.rest)
  else:
    sn = scan-number-exp(int-part.text, after)
    span(sn.text, int-part.consumed + sn.consumed, sn.rest)
  end
end

### scan an optional exponent; `consumed` is just the exponent's code points.
fun scan-number-exp(so-far :: String, cps :: List<Number>) -> Span:
  c0 = cp-nth(cps, 0)
  if (c0 == cc("e")) or (c0 == cc("E")):
    c1 = cp-nth(cps, 1)
    if (c1 == c-plus) or (c1 == c-dash):
      if is-digit(cp-nth(cps, 2)):
        d = scan-digits(cps.rest.rest)
        span(so-far + "e" + cp-str(c1) + d.text, link(c0, link(c1, d.consumed)), d.rest)
      else:
        span(so-far, empty, cps)
      end
    else if is-digit(c1):
      d = scan-digits(cps.rest)
      span(so-far + "e" + d.text, link(c0, d.consumed), d.rest)
    else:
      span(so-far, empty, cps)
    end
  else:
    span(so-far, empty, cps)
  end
end

### scan a quoted string up to the matching quote, handling common escapes.
### `consumed` includes the closing quote (and any escape backslashes), so the
### caller can advance the source position correctly; the opening quote is added
### by the caller.
fun scan-string(cps :: List<Number>, q :: Number) -> Span:
  cases(List) cps:
    | empty => span("", empty, empty)  # TODO(grammar): unterminated-string error
    | link(c, r) =>
      if c == q:
        span("", link(c, empty), r)
      else if c == c-bslash:
        cases(List) r:
          | empty => span("", link(c, empty), empty)
          | link(e, r2) =>
            s = scan-string(r2, q)
            span(unescape(e) + s.text, link(c, link(e, s.consumed)), s.rest)
        end
      else:
        s = scan-string(r, q)
        span(cp-str(c) + s.text, link(c, s.consumed), s.rest)
      end
  end
end

### scan a triple-backtick string `` ```...``` ``: raw content up to the closing
### three backticks (no escape processing — matches Pyret's multi-line strings,
### used pervasively as `doc:` strings).  `cps` starts just after the opening ```.
fun scan-tquote(cps :: List<Number>) -> Span:
  cases(List) cps:
    | empty => span("", empty, empty)  # TODO(grammar): unterminated triple-string
    | link(c, r) =>
      if (c == c-bquote) and (cp-nth(r, 0) == c-bquote) and (cp-nth(r, 1) == c-bquote):
        span("", link(c-bquote, link(c-bquote, link(c-bquote, empty))), r.rest.rest)
      else:
        s = scan-tquote(r)
        span(cp-str(c) + s.text, link(c, s.consumed), s.rest)
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
### Returns {rest; consumed} so the lexer can advance the source position.
fun skip-line(cps :: List<Number>):
  cases(List) cps:
    | empty => {empty; empty}
    | link(c, r) =>
      if c == c-nl: {cps; empty}
      else:
        res = skip-line(r)
        {res.{0}; link(c, res.{1})}
      end
  end
end

### skip a block comment `#| ... |#` (no nesting yet). `cps` starts just after `#|`.
### Returns {rest; consumed} where consumed includes the closing `|#`.
fun skip-block(cps :: List<Number>):
  cases(List) cps:
    | empty => {empty; empty}
    | link(c, r) =>
      if (c == c-bar) and (cp-nth(r, 0) == c-hash):
        {r.rest; link(c-bar, link(c-hash, empty))}
      else:
        res = skip-block(r)
        {res.{0}; link(c, res.{1})}
      end
  end
end

### ---- the tokenizer --------------------------------------------------------
### `lex`/`lex-punct` are TAIL-RECURSIVE with a reverse accumulator (`acc`): each
### emitted token is consed onto `acc` and the loop tail-calls itself, so an entire
### file tokenizes in CONSTANT stack (the seed compiles native tail calls).  The
### accumulator holds tokens in reverse (EOF first); `tokenize` `rev`s to forward order.
fun tokenize(src :: String) -> List<Token>:
  rev(lex(string-to-code-points(src), true, posn(1, 0, 0), empty))
end

fun lex(cps :: List<Number>, ws :: Boolean, p :: Pos, acc :: List<Token>) -> List<Token>:
  cases(List) cps:
    | empty => link(eof-at(p), acc)
    | link(c, r) =>
      if is-ws(c):
        lex(r, true, adv1(p, c), acc)
      else if c == c-hash:
        if cp-nth(r, 0) == c-bar:
          res = skip-block(r.rest)
          # consumed: leading `#|` then res.{1} (which includes the closing `|#`)
          p2 = adv(adv1(adv1(p, c-hash), c-bar), res.{1})
          lex(res.{0}, true, p2, acc)
        else:
          res = skip-line(r)
          p2 = adv(adv1(p, c-hash), res.{1})
          lex(res.{0}, true, p2, acc)
        end
      else if is-digit(c):
        s = scan-number(cps)
        e = adv(p, s.consumed)
        lex(s.rest, false, e, link(mk(p, e, "NUMBER", s.text, ws), acc))
      else if (c == c-tilde) and is-digit(cp-nth(r, 0)):
        s = scan-number(r)
        e = adv(adv1(p, c-tilde), s.consumed)
        lex(s.rest, false, e, link(mk(p, e, "ROUGHNUMBER", s.text, ws), acc))
      else if is-ident-start(c):
        s = scan-ident-rest(r)
        e = adv(adv1(p, c), s.consumed)
        lex(s.rest, false, e, link(mk(p, e, "NAME", cp-str(c) + s.text, ws), acc))
      else if (c == c-bquote) and (cp-nth(r, 0) == c-bquote) and (cp-nth(r, 1) == c-bquote):
        s = scan-tquote(r.rest.rest)
        # consumed: opening ``` then s.consumed (which includes the closing ```)
        e = adv(adv1(adv1(adv1(p, c-bquote), c-bquote), c-bquote), s.consumed)
        lex(s.rest, false, e, link(mk(p, e, "STRING", s.text, ws), acc))
      else if (c == c-dquote) or (c == c-squote):
        s = scan-string(r, c)
        # consumed: opening quote (c) then s.consumed (which includes the close)
        e = adv(adv1(p, c), s.consumed)
        lex(s.rest, false, e, link(mk(p, e, "STRING", s.text, ws), acc))
      else:
        lex-punct(cps, ws, p, acc)
      end
  end
end

### operators and punctuation, longest-match first.
fun lex-punct(cps :: List<Number>, ws :: Boolean, p :: Pos, acc :: List<Token>) -> List<Token>:
  c0 = cp-nth(cps, 0)
  c1 = cp-nth(cps, 1)
  c2 = cp-nth(cps, 2)
  # punctuation never spans a newline, so the end is n columns/chars along.
  fun emit(k :: String, v :: String, n :: Number):
    e = posn(p.line, p.col + n, p.char + n)
    lex(drop-n(cps, n), false, e, link(mk(p, e, k, v, ws), acc))
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
    lex(drop-n(cps, 1), false, posn(p.line, p.col + 1, p.char + 1), acc)
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

### the source name used in built srclocs, and the most-recently-consumed token
### (so a node's location can span from its first token to its last).
var src-name :: String = "parser"
var last-tok :: Token = tok-eof

### a srcloc for a single token.
fun tok-loc(t :: Token) -> A.Loc:
  S.srcloc(src-name, t.s-line, t.s-col, t.s-char, t.e-line, t.e-col, t.e-char)
end

### a srcloc spanning from `start`'s beginning to the end of the last token
### consumed so far.  Call AFTER parsing the node's tokens.
fun node-loc(start :: Token) -> A.Loc:
  S.srcloc(src-name,
    start.s-line, start.s-col, start.s-char,
    last-tok.e-line, last-tok.e-col, last-tok.e-char)
end

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
      last-tok := f
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
  else:
    t = p-peek(st)
    raise("parse error: expected " + k + " but got " + t.kind + " '" + t.value
        + "' at line " + to-string(t.s-line) + " col " + to-string(t.s-col))
  end
end

fun expect-name(st :: PState, v :: String) -> Token:
  if at-name(st, v): p-advance(st)
  else:
    t = p-peek(st)
    raise("parse error: expected '" + v + "' but got '" + t.value
        + "' at line " + to-string(t.s-line) + " col " + to-string(t.s-col))
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

### ---- annotations ----------------------------------------------------------
### Full annotation grammar: name / dot / app (`List<T>`) / arrow (`(A -> B)`) /
### record (`{x :: A}`) / tuple (`{A; B}`) / pred (`Ann%(expr)`) / `Any`.
fun parse-ann(st :: PState) -> A.Ann:
  base = parse-ann-base(st)
  parse-ann-pred(st, base)
end

### trailing refinement(s):  Ann %(expr)
fun parse-ann-pred(st :: PState, base :: A.Ann) -> A.Ann:
  if at-kind(st, "PERCENT"):
    p-advance(st)
    expect(st, "LPAREN")
    e = parse-binop(st)
    expect(st, "RPAREN")
    parse-ann-pred(st, A.a-pred(dl, base, e))
  else:
    base
  end
end

fun parse-ann-base(st :: PState) -> A.Ann:
  if at-kind(st, "NAME"):
    nm = p-advance(st).value
    base = if at-kind(st, "DOT"):
      p-advance(st)
      n2 = expect(st, "NAME").value
      A.a-dot(dl, A.s-name(dl, nm), n2)
    else if nm == "Any":
      A.a-any(dl)
    else:
      A.a-name(dl, A.s-name(dl, nm))
    end
    # application:  Name<Ann, ...>   (`<`/`>` are OP tokens)
    if at-op(st, "<"):
      p-advance(st)
      args = parse-ann-app-args(st)
      expect-gt(st)
      A.a-app(dl, base, args)
    else:
      base
    end
  else if at-kind(st, "LPAREN"):
    # arrow:  ( [Ann (, Ann)*] -> Ann )   or a parenthesized ann
    p-advance(st)
    parse-arrow-ann(st)
  else if at-kind(st, "LBRACE"):
    # record  { name :: Ann, ... }   or tuple  { Ann ; Ann ... }
    p-advance(st)
    parse-brace-ann(st)
  else:
    A.a-blank
  end
end

### consume a `>` operator (closes an `<...>` application).
fun expect-gt(st :: PState) -> Nothing:
  if at-op(st, ">"): p-advance(st) nothing
  else: raise("parse error: expected '>' to close type application but got '" + p-peek(st).value + "'")
  end
end

fun parse-ann-app-args(st :: PState) -> List<A.Ann>:
  if at-op(st, ">"): empty
  else:
    a = parse-ann(st)
    if at-kind(st, "COMMA"):
      p-advance(st)
      link(a, parse-ann-app-args(st))
    else:
      link(a, empty)
    end
  end
end

### already consumed `(`.
fun parse-arrow-ann(st :: PState) -> A.Ann:
  if at-kind(st, "THINARROW"):
    p-advance(st)
    ret = parse-ann(st)
    expect(st, "RPAREN")
    A.a-arrow(dl, empty, ret, true)
  else:
    args = parse-arrow-arg-anns(st)
    if at-kind(st, "THINARROW"):
      p-advance(st)
      ret = parse-ann(st)
      expect(st, "RPAREN")
      A.a-arrow(dl, args, ret, true)
    else:
      expect(st, "RPAREN")
      cases(List) args:
        | empty => A.a-blank
        | link(a, _) => a  # a parenthesized single annotation
      end
    end
  end
end

fun parse-arrow-arg-anns(st :: PState) -> List<A.Ann>:
  if at-kind(st, "THINARROW") or at-kind(st, "RPAREN"): empty
  else:
    a = parse-ann(st)
    if at-kind(st, "COMMA"):
      p-advance(st)
      link(a, parse-arrow-arg-anns(st))
    else:
      link(a, empty)
    end
  end
end

### contract-stmt annotation:  `ann | noparen-arrow-ann`  where
### noparen-arrow-ann = comma-ann-args THINARROW ann  (no surrounding parens).
### Used after `NAME :: [ty-params]` in a contract / typed-let.
fun parse-noparen-arrow-or-ann(st :: PState) -> A.Ann:
  first = parse-ann(st)
  if at-kind(st, "COMMA"):
    args = link(first, parse-noparen-arg-rest(st))
    expect(st, "THINARROW")
    ret = parse-ann(st)
    A.a-arrow(dl, args, ret, false)
  else if at-kind(st, "THINARROW"):
    p-advance(st)
    ret = parse-ann(st)
    A.a-arrow(dl, link(first, empty), ret, false)
  else:
    first
  end
end
fun parse-noparen-arg-rest(st :: PState) -> List<A.Ann>:
  p-advance(st)  # consume the COMMA
  a = parse-ann(st)
  if at-kind(st, "COMMA"): link(a, parse-noparen-arg-rest(st))
  else: link(a, empty)
  end
end

### already consumed `{`.
fun parse-brace-ann(st :: PState) -> A.Ann:
  if at-kind(st, "RBRACE"):
    p-advance(st)
    A.a-record(dl, empty)
  else if (p-peek(st).kind == "NAME") and peek2-kind(st, "COLONCOLON"):
    fields = parse-afield-list(st)
    expect(st, "RBRACE")
    A.a-record(dl, fields)
  else:
    anns = parse-tuple-ann-list(st)
    expect(st, "RBRACE")
    A.a-tuple(dl, anns)
  end
end

fun parse-afield-list(st :: PState) -> List<A.AField>:
  nm = expect(st, "NAME").value
  expect(st, "COLONCOLON")
  a = parse-ann(st)
  f = A.a-field(dl, nm, a)
  if at-kind(st, "COMMA"):
    p-advance(st)
    if at-kind(st, "RBRACE"): link(f, empty)
    else: link(f, parse-afield-list(st))
    end
  else:
    link(f, empty)
  end
end

fun parse-tuple-ann-list(st :: PState) -> List<A.Ann>:
  a = parse-ann(st)
  if at-kind(st, "SEMI"):
    p-advance(st)
    if at-kind(st, "RBRACE"): link(a, empty)
    else: link(a, parse-tuple-ann-list(st))
    end
  else:
    link(a, empty)
  end
end

### ---- bindings -------------------------------------------------------------
### binding: name-binding  [SHADOW] NAME [:: ann]   OR
###          tuple-binding { binding ; binding ... } [as binding]
fun parse-binding(st :: PState) -> A.Bind:
  start = p-peek(st)
  if at-kind(st, "LBRACE"):
    parse-tuple-binding(st)
  else:
    shadows = if at-name(st, "shadow"): p-advance(st) true else: false end
    nm = expect(st, "NAME")
    ann = if at-kind(st, "COLONCOLON"):
      p-advance(st)
      parse-ann(st)
    else:
      A.a-blank
    end
    A.s-bind(node-loc(start), shadows, A.s-name(tok-loc(nm), nm.value), ann)
  end
end

### tuple-binding:  { binding ; binding ... } [as binding]
fun parse-tuple-binding(st :: PState) -> A.Bind:
  start = p-peek(st)
  expect(st, "LBRACE")
  fields = parse-tuple-bind-fields(st)
  expect(st, "RBRACE")
  as-name = if at-name(st, "as"):
    p-advance(st)
    some(parse-binding(st))
  else:
    none
  end
  A.s-tuple-bind(node-loc(start), fields, as-name)
end

fun parse-tuple-bind-fields(st :: PState) -> List<A.Bind>:
  b = parse-binding(st)
  if at-kind(st, "SEMI"):
    p-advance(st)
    if at-kind(st, "RBRACE"): link(b, empty)
    else: link(b, parse-tuple-bind-fields(st))
    end
  else:
    link(b, empty)
  end
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
  start = p-peek(st)
  left = parse-postfix(st)
  parse-binop-rest(st, start, left)
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

fun parse-binop-rest(st :: PState, start :: Token, left :: A.Expr) -> A.Expr:
  cases(Option) cur-binop(st):
    | none => left
    | some(opname) =>
      op-tok = p-advance(st)
      right = parse-postfix(st)
      parse-binop-rest(st, start, A.s-op(node-loc(start), tok-loc(op-tok), opname, left, right))
  end
end

### postfix chain: application, dot, method-call, get-bang, extend, update, tuple-get.
fun parse-postfix(st :: PState) -> A.Expr:
  start = p-peek(st)
  parse-postfix-rest(st, start, parse-atom(st))
end

fun parse-postfix-rest(st :: PState, start :: Token, e :: A.Expr) -> A.Expr:
  if at-kind(st, "LPAREN") and not(p-peek(st).ws-before):
    args = parse-app-args(st)
    parse-postfix-rest(st, start, A.s-app(node-loc(start), e, args))
  else if at-kind(st, "DOT"):
    p-advance(st)
    if at-kind(st, "LBRACE"):
      # tuple-get  e.{N}   OR   extend  e.{fields}
      idx-tok = p-peek(st)
      p-advance(st)
      if at-kind(st, "NUMBER"):
        idx = num-of(p-advance(st).value)
        expect(st, "RBRACE")
        parse-postfix-rest(st, start, A.s-tuple-get(node-loc(start), e, idx, tok-loc(idx-tok)))
      else:
        fields = parse-fields(st)
        expect(st, "RBRACE")
        parse-postfix-rest(st, start, A.s-extend(node-loc(start), e, fields))
      end
    else:
      fld = expect(st, "NAME").value
      parse-postfix-rest(st, start, A.s-dot(node-loc(start), e, fld))
    end
  else if at-kind(st, "BANG"):
    p-advance(st)
    if at-kind(st, "LBRACE"):
      p-advance(st)
      fields = parse-fields(st)
      expect(st, "RBRACE")
      parse-postfix-rest(st, start, A.s-update(node-loc(start), e, fields))
    else:
      fld = expect(st, "NAME").value
      parse-postfix-rest(st, start, A.s-get-bang(node-loc(start), e, fld))
    end
  else:
    e
  end
end

### like parse-postfix but does NOT consume a trailing application `(...)`.
### Used for the `for` iterator, where `name(bind from coll, ...)` — the `(` opens
### the for-binds, not an application.  Dot / bang field chains are still allowed
### (e.g. `for L.foldr(...)`).
fun parse-postfix-noapp(st :: PState) -> A.Expr:
  start = p-peek(st)
  parse-postfix-noapp-rest(st, start, parse-atom(st))
end
### Does the LPAREN at the cursor delimit `for`-binds (`(b from e, ...)` or `()`)
### rather than a function application?  Scans for a top-level `from` before the
### matching `)`.  Lets a `for` iterator itself be an application, e.g.
### `for left-right-check(loc)(lv from left, rv from right): ...`.
fun forbinds-ahead(st :: PState) -> Boolean:
  cases(List) tok-stream:
    | empty => false
    | link(_, inner) =>
      cases(List) inner:
        | empty => false
        | link(t0, _) =>
          if t0.kind == "RPAREN": true   # empty () => for-binds
          else: forbinds-scan(inner, 0)
          end
      end
  end
end
fun forbinds-scan(toks :: List<Token>, depth :: Number) -> Boolean:
  cases(List) toks:
    | empty => false
    | link(t, r) =>
      k = t.kind
      if (depth == 0) and (k == "RPAREN"): false        # paren closed, no top-level `from` => app
      else if (depth == 0) and (k == "NAME") and (t.value == "from"): true
      else if (k == "LPAREN") or (k == "LBRACK") or (k == "LBRACE"): forbinds-scan(r, depth + 1)
      else if (k == "RPAREN") or (k == "RBRACK") or (k == "RBRACE"): forbinds-scan(r, depth - 1)
      else: forbinds-scan(r, depth)
      end
  end
end
fun parse-postfix-noapp-rest(st :: PState, start :: Token, e :: A.Expr) -> A.Expr:
  if at-kind(st, "LPAREN") and not(p-peek(st).ws-before) and not(forbinds-ahead(st)):
    # an application within the `for` iterator (`f(x)(...binds)`); the for-binds
    # paren is recognized by `forbinds-ahead` and left for `parse-for`.
    args = parse-app-args(st)
    parse-postfix-noapp-rest(st, start, A.s-app(node-loc(start), e, args))
  else if at-kind(st, "DOT"):
    p-advance(st)
    fld = expect(st, "NAME").value
    parse-postfix-noapp-rest(st, start, A.s-dot(node-loc(start), e, fld))
  else if at-kind(st, "BANG"):
    p-advance(st)
    fld = expect(st, "NAME").value
    parse-postfix-noapp-rest(st, start, A.s-get-bang(node-loc(start), e, fld))
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
  if (t.kind == "OP") and ((t.value == "-") or (t.value == "+")):
    # unary sign on a numeric literal: Pyret's `num-expr` carries the sign
    # (there is no general unary minus — `-x` on a non-literal isn't valid Pyret).
    p-advance(st)
    nt = p-peek(st)
    pfx = if t.value == "-": "-" else: "" end
    if nt.kind == "NUMBER":
      p-advance(st)
      make-number(node-loc(t), pfx + nt.value, false)
    else if nt.kind == "ROUGHNUMBER":
      p-advance(st)
      make-number(node-loc(t), pfx + nt.value, true)
    else:
      raise("parse error: unary '" + t.value + "' must precede a number literal, got " + nt.kind)
    end
  else if t.kind == "NUMBER":
    p-advance(st)
    make-number(tok-loc(t), t.value, false)
  else if t.kind == "ROUGHNUMBER":
    p-advance(st)
    make-number(tok-loc(t), t.value, true)
  else if t.kind == "STRING":
    p-advance(st)
    A.s-str(tok-loc(t), t.value)
  else if t.kind == "NAME":
    parse-name-atom(st, t.value)
  else if t.kind == "LPAREN":
    start = t
    p-advance(st)
    e = parse-binop(st)
    expect(st, "RPAREN")
    A.s-paren(node-loc(start), e)
  else if t.kind == "LBRACK":
    parse-construct(st)
  else if t.kind == "LBRACE":
    parse-brace(st)
  else if t.kind == "DOTDOTDOT":
    p-advance(st)
    A.s-template(tok-loc(t))
  else:
    raise("parse error: unexpected " + t.kind + " '" + t.value + "' at start of expression")
  end
end

fun parse-name-atom(st :: PState, v :: String) -> A.Expr:
  nm-tok = p-peek(st)
  if v == "true": p-advance(st) A.s-bool(tok-loc(nm-tok), true)
  else if v == "false": p-advance(st) A.s-bool(tok-loc(nm-tok), false)
  else if v == "lam": parse-lam(st)
  else if v == "method": parse-method-expr(st)
  else if v == "if": parse-if(st)
  else if v == "ask": parse-ask(st)
  else if v == "cases": parse-cases(st)
  else if v == "for": parse-for(st)
  else if v == "let": parse-multi-let(st)
  else if v == "letrec": parse-letrec(st)
  else if v == "type-let": parse-type-let(st)
  else if (v == "block") and peek2-kind(st, "COLON"):
    p-advance(st)
    p-advance(st)
    body = parse-block(st)
    expect-name(st, "end")
    A.s-user-block(node-loc(nm-tok), body)
  else if (v == "table") and peek2-kind(st, "COLON"):
    parse-table(st)
  else:
    p-advance(st)
    A.s-id(tok-loc(nm-tok), A.s-name(tok-loc(nm-tok), v))
  end
end

### build a numeric literal node.  `rough` tags `~`-prefixed roughnums.
###   a/b            -> s-frac     (~a/b -> s-rfrac)
###   a.b            -> s-num with an EXACT rational (numer / 10^k); ~a.b -> roughnum
###   a (integer)    -> s-num      (~a -> s-num holding a roughnum)
fun make-number(loc :: A.Loc, txt :: String, rough :: Boolean) -> A.Expr:
  if string-contains(txt, "/"):
    idx = string-index-of(txt, "/")
    n = int-of(string-substring(txt, 0, idx))
    d = int-of(string-substring(txt, idx + 1, string-length(txt)))
    if rough: A.s-rfrac(loc, n, d) else: A.s-frac(loc, n, d) end
  else if string-contains(txt, ".") and not(has-exp(txt)):
    # decimal a.b -> exact rational  numer / 10^(#frac-digits)
    idx = string-index-of(txt, ".")
    int-part = string-substring(txt, 0, idx)
    frac-part = string-substring(txt, idx + 1, string-length(txt))
    numer = int-of(int-part + frac-part)
    val = numer / num-expt(10, string-length(frac-part))
    if rough: A.s-num(loc, num-to-roughnum(val)) else: A.s-num(loc, val) end
  else if string-contains(txt, "."):
    # TODO(grammar): decimals with exponents -> integer part for now
    idx = string-index-of(txt, ".")
    A.s-num(loc, int-of(string-substring(txt, 0, idx)))
  else:
    n = int-of(txt)
    if rough: A.s-num(loc, num-to-roughnum(n)) else: A.s-num(loc, n) end
  end
end

### does this number literal carry an `e`/`E` exponent?
fun has-exp(txt :: String) -> Boolean:
  string-contains(txt, "e") or string-contains(txt, "E")
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
  start = p-peek(st)
  expect(st, "LBRACK")
  modifier = if at-name(st, "lazy"): p-advance(st) A.s-construct-lazy else: A.s-construct-normal end
  ctor = parse-binop(st)
  expect(st, "COLON")
  values = if at-kind(st, "RBRACK"): empty else: parse-comma-binops(st) end
  expect(st, "RBRACK")
  A.s-construct(node-loc(start), modifier, ctor, values)
end

### Given the cursor is at a `(`, return the kind of the token immediately AFTER
### its matching `)`.  Used to tell a curly-brace lambda `{(args): ...}` (a `:` or
### `->` follows the params) from a tuple whose first item is parenthesized,
### e.g. `{(a + b) - c; d}` (an operator follows).
fun after-paren-tok(toks :: List<Token>, depth :: Number) -> Token:
  cases(List) toks:
    | empty => tok-eof
    | link(t, r) =>
      k = t.kind
      nd = if (k == "LPAREN") or (k == "LBRACK") or (k == "LBRACE"): depth + 1
        else if (k == "RPAREN") or (k == "RBRACK") or (k == "RBRACE"): depth - 1
        else: depth end
      if ((k == "RPAREN") or (k == "RBRACK") or (k == "RBRACE")) and (nd == 0):
        cases(List) r:
          | empty => tok-eof
          | link(t2, _) => t2
        end
      else: after-paren-tok(r, nd)
      end
  end
end
fun brace-lambda-ahead(st :: PState) -> Boolean:
  # lambda params are followed by `:` (block), `->` (ret ann), or `block:`.
  t = after-paren-tok(tok-stream, 0)
  (t.kind == "COLON") or (t.kind == "THINARROW") or ((t.kind == "NAME") and (t.value == "block"))
end

### brace: distinguish {obj-fields} from {tuple ; ...}
fun parse-brace(st :: PState) -> A.Expr:
  start = p-peek(st)
  expect(st, "LBRACE")
  if at-kind(st, "RBRACE"):
    p-advance(st)
    A.s-obj(node-loc(start), empty)
  else if (p-peek(st).kind == "NAME") and peek2-kind(st, "COLON"):
    fields = parse-fields(st)
    expect(st, "RBRACE")
    A.s-obj(node-loc(start), fields)
  else if at-name(st, "method"):
    fields = parse-fields(st)
    expect(st, "RBRACE")
    A.s-obj(node-loc(start), fields)
  else if at-op(st, "<") or (at-kind(st, "LPAREN") and brace-lambda-ahead(st)):
    # curly-brace lambda:  { [ty-params] args [-> ann] : block }
    # (a `(` that is NOT followed by `:`/`->` after its `)` is a parenthesized
    # first tuple item, e.g. `{(a + b) - c; d}`, handled by the tuple branch.)
    params = parse-ty-params(st)
    args = parse-args(st)
    ret = parse-return-ann(st)
    blocky = parse-block-or-colon(st)
    doc = parse-doc(st)
    body = parse-block(st)
    wc = parse-where(st)
    expect(st, "RBRACE")
    A.s-lam(node-loc(start), "", params, args, ret, doc, body, where-loc(wc), wc, blocky)
  else:
    # tuple
    items = parse-tuple-items(st)
    expect(st, "RBRACE")
    A.s-tuple(node-loc(start), items)
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
    # a trailing comma may precede an obj-literal `}` OR a data with-block
    # terminator (`|` next variant / `sharing:` / `where:` / `end`).
    if at-kind(st, "RBRACE") or at-kind(st, "BAR")
        or at-name(st, "end") or at-name(st, "sharing") or at-name(st, "where"):
      link(f, empty)
    else: link(f, parse-fields(st))
    end
  else:
    link(f, empty)
  end
end

fun parse-field(st :: PState) -> A.Member:
  start = p-peek(st)
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
    A.s-method-field(node-loc(start), key, params, args, ret, doc, body, where-loc(wc), wc, blocky)
  else:
    key = expect(st, "NAME").value
    expect(st, "COLON")
    value = parse-binop(st)
    A.s-data-field(node-loc(start), key, value)
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
  start = p-peek(st)
  expect-name(st, "lam")
  params = parse-ty-params(st)
  args = parse-args(st)
  ret = parse-return-ann(st)
  blocky = parse-block-or-colon(st)
  doc = parse-doc(st)
  body = parse-block(st)
  wc = parse-where(st)
  expect-name(st, "end")
  A.s-lam(node-loc(start), "", params, args, ret, doc, body, where-loc(wc), wc, blocky)
end

fun parse-method-expr(st :: PState) -> A.Expr:
  start = p-peek(st)
  expect-name(st, "method")
  params = parse-ty-params(st)
  args = parse-args(st)
  ret = parse-return-ann(st)
  blocky = parse-block-or-colon(st)
  doc = parse-doc(st)
  body = parse-block(st)
  wc = parse-where(st)
  expect-name(st, "end")
  A.s-method(node-loc(start), "", params, args, ret, doc, body, where-loc(wc), wc, blocky)
end

### if / else if / else
fun parse-if(st :: PState) -> A.Expr:
  start = p-peek(st)
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
    A.s-if-else(node-loc(start), branches, eb, blocky)
  else:
    expect-name(st, "end")
    A.s-if(node-loc(start), branches, blocky)
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
  start = p-peek(st)
  expect-name(st, "ask")
  blocky = parse-block-or-colon(st)
  res = parse-ask-branches(st)
  expect-name(st, "end")
  cases(Option) res.{1}:
    | none => A.s-if-pipe(node-loc(start), res.{0}, blocky)
    | some(eb) => A.s-if-pipe-else(node-loc(start), res.{0}, eb, blocky)
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
  start = p-peek(st)
  expect-name(st, "cases")
  expect(st, "LPAREN")
  typ = parse-ann(st)
  expect(st, "RPAREN")
  val = parse-binop(st)
  blocky = parse-block-or-colon(st)
  res = parse-cases-branches(st)
  expect-name(st, "end")
  cases(Option) res.{1}:
    | none => A.s-cases(node-loc(start), typ, val, res.{0}, blocky)
    | some(eb) => A.s-cases-else(node-loc(start), typ, val, res.{0}, eb, blocky)
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
  start = p-peek(st)
  expect-name(st, "for")
  iter = parse-postfix-noapp(st)  # iterator: name/dot chain; the `(` is the for-binds, NOT an app
  expect(st, "LPAREN")
  binds = if at-kind(st, "RPAREN"): empty else: parse-for-binds(st) end
  expect(st, "RPAREN")
  ret = parse-return-ann(st)
  blocky = parse-block-or-colon(st)
  body = parse-block(st)
  expect-name(st, "end")
  A.s-for(node-loc(start), iter, binds, ret, body, blocky)
end
fun parse-for-binds(st :: PState) -> List<A.ForBind>:
  start = p-peek(st)
  b = parse-binding(st)
  expect-name(st, "from")
  v = parse-binop(st)
  fb = A.s-for-bind(node-loc(start), b, v)
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
  start = p-peek(st)
  A.s-block(node-loc(start), parse-stmts(st))
end

fun at-block-end(st :: PState) -> Boolean:
  at-eof(st) or at-name(st, "end") or at-name(st, "else")
    or at-name(st, "sharing") or at-name(st, "where") or at-kind(st, "BAR")
    or at-kind(st, "RBRACE")  # closes a curly-brace lambda `{ args : block }`
end

### TAIL-RECURSIVE over the statement list (a block/program can have hundreds of
### top-level statements; a non-tail `link(s, parse-stmts(...))` grows the stack per
### statement and overflows on large files).  Accumulate in reverse, then `rev`.
fun parse-stmts(st :: PState) -> List<A.Expr>:
  parse-stmts-acc(st, empty)
end

fun parse-stmts-acc(st :: PState, acc :: List<A.Expr>) -> List<A.Expr>:
  if at-block-end(st): rev(acc)
  else:
    s = parse-stmt(st)
    parse-stmts-acc(st, link(s, acc))
  end
end

fun parse-stmt(st :: PState) -> A.Expr:
  if at-name(st, "fun"): parse-fun(st)
  else if at-name(st, "data"): parse-data(st)
  else if at-name(st, "var"): parse-var(st)
  else if at-name(st, "rec"): parse-rec(st)
  else if at-name(st, "type") and peek2-kind(st, "NAME"): parse-type(st)
  else if at-name(st, "newtype") and peek2-kind(st, "NAME"): parse-newtype(st)
  else if at-name(st, "when"): parse-when(st)
  else if at-name(st, "spy"): parse-spy(st)
  else if at-name(st, "check") or at-name(st, "examples"): parse-check(st)
  else if at-kind(st, "NAME") and peek2-kind(st, "COLONEQUALS"):
    nm-tok = p-advance(st)
    p-advance(st)
    v = parse-binop(st)
    A.s-assign(node-loc(nm-tok), A.s-name(tok-loc(nm-tok), nm-tok.value), v)
  else if is-let-start(st):
    parse-let(st)
  else:
    # a bare expression statement, possibly a check-test (`lhs is rhs`)
    start = p-peek(st)
    e = parse-binop(st)
    parse-check-test-rest(st, start, e)
  end
end

### A let-binding starts with `shadow`, or with `NAME =` / `NAME ::` (a binding,
### not the start of a larger expression like `NAME.field` or `NAME(args)`), or
### with a tuple-binding `{ ... } [as b] =` (tuple-destructuring let).
fun is-let-start(st :: PState) -> Boolean:
  if at-name(st, "shadow"): true
  else if at-kind(st, "NAME"):
    peek2-kind(st, "EQUALS") or peek2-kind(st, "COLONCOLON")
  else if at-kind(st, "LBRACE"):
    tuple-let-ahead(st)
  else:
    false
  end
end

### Lookahead: at a `{`, decide whether this is a tuple-destructuring let — i.e. the
### matching `}` is followed by `=` (or `as`, the optional tuple-binding alias) —
### rather than a tuple/object expression.  Scans the raw token stream by brace depth.
fun tuple-let-ahead(st :: PState) -> Boolean:
  after-brace(tok-stream, 0)
end

fun after-brace(ts :: List<Token>, depth :: Number) -> Boolean:
  cases(List) ts:
    | empty => false
    | link(t, r) =>
      ask:
        | t.kind == "LBRACE" then: after-brace(r, depth + 1)
        | t.kind == "RBRACE" then:
          if depth <= 1:
            cases(List) r:
              | empty => false
              | link(n, _) => (n.kind == "EQUALS") or ((n.kind == "NAME") and (n.value == "as"))
            end
          else:
            after-brace(r, depth - 1)
          end
        | t.kind == "EOF" then: false
        | otherwise: after-brace(r, depth)
      end
  end
end

fun parse-let(st :: PState) -> A.Expr:
  start = p-peek(st)
  # A plain `NAME ::` heads either a contract statement
  # (`NAME :: [ty-params] (ann | noparen-arrow-ann)`) or a typed let
  # (`NAME :: ann = value`).  Handle ty-params + noparen-arrow anns, which the
  # general binding parser does not.
  if at-kind(st, "NAME") and peek2-kind(st, "COLONCOLON"):
    nm = expect(st, "NAME")
    expect(st, "COLONCOLON")
    params = parse-ty-params(st)
    ann = parse-noparen-arrow-or-ann(st)
    namev = A.s-name(tok-loc(nm), nm.value)
    if at-kind(st, "EQUALS"):
      p-advance(st)
      v = parse-binop(st)
      A.s-let(node-loc(start), A.s-bind(node-loc(start), false, namev, ann), v, false)
    else:
      A.s-contract(node-loc(start), namev, params, ann)
    end
  else:
    b = parse-binding(st)
    if at-kind(st, "EQUALS"):
      p-advance(st)
      v = parse-binop(st)
      A.s-let(node-loc(start), b, v, false)
    else:
      # `NAME :: Ann` with no `=`  ->  contract statement
      A.s-contract(node-loc(start), b.id, empty, b.ann)
    end
  end
end

### type-alias statement:  type NAME [<params>] = Ann
fun parse-type(st :: PState) -> A.Expr:
  start = p-peek(st)
  expect-name(st, "type")
  nm-tok = expect(st, "NAME")
  params = parse-ty-params(st)
  expect(st, "EQUALS")
  ann = parse-ann(st)
  A.s-type(node-loc(start), A.s-name(tok-loc(nm-tok), nm-tok.value), params, ann)
end

### newtype statement:  newtype NAME as NAMET
fun parse-newtype(st :: PState) -> A.Expr:
  start = p-peek(st)
  expect-name(st, "newtype")
  nm-tok = expect(st, "NAME")
  expect-name(st, "as")
  namet-tok = expect(st, "NAME")
  A.s-newtype(node-loc(start), A.s-name(tok-loc(nm-tok), nm-tok.value),
    A.s-name(tok-loc(namet-tok), namet-tok.value))
end

### multi-let:  let let-binding (, let-binding)* (block|colon) block end
fun parse-multi-let(st :: PState) -> A.Expr:
  start = p-peek(st)
  expect-name(st, "let")
  binds = parse-let-binding-list(st)
  blocky = parse-block-or-colon(st)
  body = parse-block(st)
  expect-name(st, "end")
  A.s-let-expr(node-loc(start), binds, body, blocky)
end

fun parse-let-binding-list(st :: PState) -> List<A.LetBind>:
  lb = parse-let-binding(st)
  if at-kind(st, "COMMA"):
    p-advance(st)
    link(lb, parse-let-binding-list(st))
  else:
    link(lb, empty)
  end
end

### let-binding:  [var] binding = binop   ->  s-var-bind / s-let-bind
fun parse-let-binding(st :: PState) -> A.LetBind:
  start = p-peek(st)
  is-var = if at-name(st, "var"): p-advance(st) true else: false end
  b = parse-binding(st)
  expect(st, "EQUALS")
  v = parse-binop(st)
  if is-var: A.s-var-bind(node-loc(start), b, v)
  else: A.s-let-bind(node-loc(start), b, v)
  end
end

### letrec:  letrec let-expr (, let-expr)* (block|colon) block end
fun parse-letrec(st :: PState) -> A.Expr:
  start = p-peek(st)
  expect-name(st, "letrec")
  binds = parse-letrec-binding-list(st)
  blocky = parse-block-or-colon(st)
  body = parse-block(st)
  expect-name(st, "end")
  A.s-letrec(node-loc(start), binds, body, blocky)
end

fun parse-letrec-binding-list(st :: PState) -> List<A.LetrecBind>:
  start = p-peek(st)
  b = parse-binding(st)
  expect(st, "EQUALS")
  v = parse-binop(st)
  lb = A.s-letrec-bind(node-loc(start), b, v)
  if at-kind(st, "COMMA"):
    p-advance(st)
    link(lb, parse-letrec-binding-list(st))
  else:
    link(lb, empty)
  end
end

### type-let:  type-let type-let-bind (, type-let-bind)* (block|colon) block end
fun parse-type-let(st :: PState) -> A.Expr:
  start = p-peek(st)
  expect-name(st, "type-let")
  binds = parse-type-let-bind-list(st)
  blocky = parse-block-or-colon(st)
  body = parse-block(st)
  expect-name(st, "end")
  A.s-type-let-expr(node-loc(start), binds, body, blocky)
end

fun parse-type-let-bind-list(st :: PState) -> List<A.TypeLetBind>:
  b = parse-type-let-bind(st)
  if at-kind(st, "COMMA"):
    p-advance(st)
    link(b, parse-type-let-bind-list(st))
  else:
    link(b, empty)
  end
end

### type-let-bind:  type-bind ( NAME [<params>] = ann )  |  newtype-bind ( newtype NAME as NAME )
fun parse-type-let-bind(st :: PState) -> A.TypeLetBind:
  start = p-peek(st)
  if at-name(st, "newtype"):
    p-advance(st)
    nm-tok = expect(st, "NAME")
    expect-name(st, "as")
    namet-tok = expect(st, "NAME")
    A.s-newtype-bind(node-loc(start),
      A.s-name(tok-loc(nm-tok), nm-tok.value), A.s-name(tok-loc(namet-tok), namet-tok.value))
  else:
    nm-tok = expect(st, "NAME")
    params = parse-ty-params(st)
    expect(st, "EQUALS")
    ann = parse-ann(st)
    A.s-type-bind(node-loc(start), A.s-name(tok-loc(nm-tok), nm-tok.value), params, ann)
  end
end

### table:  table: hdr [:: ann] (, hdr)*  (row: e (, e)*)*  end
fun parse-table(st :: PState) -> A.Expr:
  start = p-peek(st)
  expect-name(st, "table")
  expect(st, "COLON")
  headers = parse-table-headers(st)
  rows = parse-table-rows(st)
  expect-name(st, "end")
  A.s-table(node-loc(start), headers, rows)
end

fun parse-table-headers(st :: PState) -> List<A.FieldName>:
  # headers run until `end` or the first `row:`; may be empty
  if at-name(st, "end") or (at-name(st, "row") and peek2-kind(st, "COLON")):
    empty
  else:
    h = parse-table-header(st)
    if at-kind(st, "COMMA"):
      p-advance(st)
      link(h, parse-table-headers(st))
    else:
      link(h, empty)
    end
  end
end

fun parse-table-header(st :: PState) -> A.FieldName:
  nm = expect(st, "NAME")
  ann = if at-kind(st, "COLONCOLON"): p-advance(st) parse-ann(st) else: A.a-blank end
  A.s-field-name(tok-loc(nm), nm.value, ann)
end

fun parse-table-rows(st :: PState) -> List<A.TableRow>:
  if at-name(st, "row") and peek2-kind(st, "COLON"):
    r = parse-table-row(st)
    link(r, parse-table-rows(st))
  else:
    empty
  end
end

fun parse-table-row(st :: PState) -> A.TableRow:
  start = expect-name(st, "row")
  expect(st, "COLON")
  elems = if at-name(st, "row") or at-name(st, "end"): empty else: parse-comma-binops(st) end
  A.s-table-row(node-loc(start), elems)
end

### spy:  spy [message] : [spy-field (, spy-field)*] end
fun parse-spy(st :: PState) -> A.Expr:
  start = p-peek(st)
  expect-name(st, "spy")
  msg = if at-kind(st, "COLON"): none else: some(parse-binop(st)) end
  expect(st, "COLON")
  contents = if at-name(st, "end"): empty else: parse-spy-fields(st) end
  expect-name(st, "end")
  A.s-spy-block(node-loc(start), msg, contents)
end

fun parse-spy-fields(st :: PState) -> List<A.SpyField>:
  f = parse-spy-field(st)
  if at-kind(st, "COMMA"):
    p-advance(st)
    if at-name(st, "end"): link(f, empty)
    else: link(f, parse-spy-fields(st))
    end
  else:
    link(f, empty)
  end
end

### spy-field:  NAME COLON binop   (explicit)   |   NAME   (implicit-label id-expr)
fun parse-spy-field(st :: PState) -> A.SpyField:
  start = p-peek(st)
  nm-tok = expect(st, "NAME")
  if at-kind(st, "COLON"):
    p-advance(st)
    v = parse-binop(st)
    A.s-spy-expr(node-loc(start), nm-tok.value, v, false)
  else:
    ide = A.s-id(tok-loc(nm-tok), A.s-name(tok-loc(nm-tok), nm-tok.value))
    A.s-spy-expr(node-loc(start), nm-tok.value, ide, true)
  end
end

fun parse-var(st :: PState) -> A.Expr:
  start = p-peek(st)
  expect-name(st, "var")
  b = parse-binding(st)
  expect(st, "EQUALS")
  v = parse-binop(st)
  A.s-var(node-loc(start), b, v)
end

fun parse-rec(st :: PState) -> A.Expr:
  start = p-peek(st)
  expect-name(st, "rec")
  b = parse-binding(st)
  expect(st, "EQUALS")
  v = parse-binop(st)
  A.s-rec(node-loc(start), b, v)
end

fun parse-when(st :: PState) -> A.Expr:
  start = p-peek(st)
  expect-name(st, "when")
  test = parse-binop(st)
  blocky = parse-block-or-colon(st)
  body = parse-block(st)
  expect-name(st, "end")
  A.s-when(node-loc(start), test, body, blocky)
end

fun parse-check(st :: PState) -> A.Expr:
  start = p-peek(st)
  keyword-check = at-name(st, "check")
  p-advance(st)
  nm = if at-kind(st, "STRING"): some(p-advance(st).value) else: none end
  expect(st, "COLON")
  body = parse-block(st)
  expect-name(st, "end")
  A.s-check(node-loc(start), nm, body, keyword-check)
end

### check-test: lhs check-op [%(refinement)] rhs [because cause]
###            | lhs check-op-postfix [because cause]      (postfix = does-not-raise)
### The full check-op set is supported (see cur-check-op).  Only the postfix op
### `does-not-raise` (s-op-raises-not) may lack a right-hand side — ast.arr relies
### on that invariant.
fun parse-check-test-rest(st :: PState, start :: Token, left :: A.Expr) -> A.Expr:
  cases(Option) cur-check-op(st):
    | none => left
    | some(opp) =>
      op = opp.{0}
      postfix = opp.{1}
      refinement = if at-kind(st, "PERCENT"):
        p-advance(st)
        expect(st, "LPAREN")
        r = parse-binop(st)
        expect(st, "RPAREN")
        some(r)
      else:
        none
      end
      if postfix:
        A.s-check-test(node-loc(start), op, refinement, left, none, parse-because(st))
      else:
        right = parse-binop(st)
        A.s-check-test(node-loc(start), op, refinement, left, some(right), parse-because(st))
      end
  end
end

### optional `because <expr>` cause on a check-test.
fun parse-because(st :: PState) -> Option:
  if at-name(st, "because"):
    p-advance(st)
    some(parse-binop(st))
  else:
    none
  end
end

### the current check operator (if any), as {CheckOp; is-postfix}.  Operators that
### are spelled with a trailing comparison (`is==`/`is=~`/`is<=>` and the `is-not`
### variants) lex as NAME + OP, so we glue them back together here.
fun cur-check-op(st :: PState) -> Option:
  t = p-peek(st)
  if not(t.kind == "NAME"): none
  else:
    l = tok-loc(t)
    v = t.value
    ask:
      | v == "is" then:
        p-advance(st)
        some({is-suffix-op(st, l, A.s-op-is(l)); false})
      | v == "is-not" then:
        p-advance(st)
        some({is-not-suffix-op(st, l); false})
      | v == "is-roughly" then: p-advance(st) some({A.s-op-is-roughly(l); false})
      | v == "is-not-roughly" then: p-advance(st) some({A.s-op-is-not-roughly(l); false})
      | v == "raises" then: p-advance(st) some({A.s-op-raises(l); false})
      | v == "raises-other-than" then: p-advance(st) some({A.s-op-raises-other(l); false})
      | v == "raises-satisfies" then: p-advance(st) some({A.s-op-raises-satisfies(l); false})
      | v == "raises-violates" then: p-advance(st) some({A.s-op-raises-violates(l); false})
      | v == "does-not-raise" then: p-advance(st) some({A.s-op-raises-not(l); true})
      | v == "satisfies" then: p-advance(st) some({A.s-op-satisfies(l); false})
      | v == "violates" then: p-advance(st) some({A.s-op-satisfies-not(l); false})
      | otherwise: none
    end
  end
end

### after `is`, an immediate `==`/`=~`/`<=>` makes it an `is==`-style op.
fun is-suffix-op(st :: PState, l :: A.Loc, plain :: A.CheckOp) -> A.CheckOp:
  if at-op(st, "=="): p-advance(st) A.s-op-is-op(l, "op==")
  else if at-op(st, "=~"): p-advance(st) A.s-op-is-op(l, "op=~")
  else if at-op(st, "<=>"): p-advance(st) A.s-op-is-op(l, "op<=>")
  else: plain
  end
end

fun is-not-suffix-op(st :: PState, l :: A.Loc) -> A.CheckOp:
  if at-op(st, "=="): p-advance(st) A.s-op-is-not-op(l, "op==")
  else if at-op(st, "=~"): p-advance(st) A.s-op-is-not-op(l, "op=~")
  else if at-op(st, "<=>"): p-advance(st) A.s-op-is-not-op(l, "op<=>")
  else: A.s-op-is-not(l)
  end
end

### ---- fun / data ----------------------------------------------------------
fun parse-fun(st :: PState) -> A.Expr:
  start = p-peek(st)
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
  A.s-fun(node-loc(start), fname, params, args, ret, doc, body, where-loc(wc), wc, blocky)
end

fun parse-data(st :: PState) -> A.Expr:
  start = p-peek(st)
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
  A.s-data(node-loc(start), name, params, empty, variants, shared, where-loc(wc), wc)
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
  start = p-peek(st)
  vname = expect(st, "NAME").value
  if at-kind(st, "LPAREN"):
    members = parse-variant-members(st)
    withs = parse-variant-with(st)
    A.s-variant(node-loc(start), tok-loc(start), vname, members, withs)
  else:
    withs = parse-variant-with(st)
    A.s-singleton-variant(node-loc(start), vname, withs)
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
  start = p-peek(st)
  preludes = parse-prelude(st)
  body = parse-block(st)
  A.s-program(node-loc(start), none, preludes.{0}, A.s-provide-types-none(dl), empty, preludes.{1}, body)
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
    if at-name(st, "from"):
      # include from MOD-REF: spec, ... end
      p-advance(st)
      modpath = parse-dotted-names(st)
      expect(st, "COLON")
      specs = parse-include-specs(st)
      expect-name(st, "end")
      parse-prelude-loop(st, prov, imps + link(A.s-include-from(dl, modpath, specs), empty))
    else:
      src = parse-import-source(st)
      parse-prelude-loop(st, prov, imps + link(A.s-include(dl, src), empty))
    end
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

### dotted module reference:  NAME (. NAME)*  ->  List<Name>
fun parse-dotted-names(st :: PState) -> List<A.Name>:
  nm = expect(st, "NAME").value
  first = A.s-name(dl, nm)
  if at-kind(st, "DOT"):
    p-advance(st)
    link(first, parse-dotted-names(st))
  else:
    link(first, empty)
  end
end

### include-spec list:  spec (, spec)* [,]   up to `end`.
fun parse-include-specs(st :: PState) -> List<A.IncludeSpec>:
  if at-name(st, "end"): empty
  else:
    spec = parse-include-spec(st)
    if at-kind(st, "COMMA"):
      p-advance(st)
      if at-name(st, "end"): link(spec, empty)  # trailing comma
      else: link(spec, parse-include-specs(st))
      end
    else:
      link(spec, empty)
    end
  end
end

### include-spec:  [type|data|module] NAME [as NAME]  |  *
fun parse-include-spec(st :: PState) -> A.IncludeSpec:
  if at-name(st, "type"):
    p-advance(st)
    if at-op(st, "*"):
      p-advance(st)
      A.s-include-type(dl, A.s-star(dl, empty))
    else:
      nm = expect(st, "NAME").value
      A.s-include-type(dl, A.s-local-ref(dl, A.s-name(dl, nm), A.s-name(dl, nm)))
    end
  else if at-name(st, "data"):
    p-advance(st)
    if at-op(st, "*"):
      p-advance(st)
      A.s-include-data(dl, A.s-star(dl, empty), empty)
    else:
      nm = expect(st, "NAME").value
      A.s-include-data(dl, A.s-local-ref(dl, A.s-name(dl, nm), A.s-name(dl, nm)), empty)
    end
  else if at-name(st, "module"):
    p-advance(st)
    nm = expect(st, "NAME").value
    A.s-include-name(dl, A.s-module-ref(dl, link(A.s-name(dl, nm), empty), none))
  else if at-op(st, "*"):
    p-advance(st)
    A.s-include-name(dl, A.s-star(dl, empty))
  else:
    nm = expect(st, "NAME").value
    asn = if at-name(st, "as"): p-advance(st) A.s-name(dl, expect(st, "NAME").value)
          else: A.s-name(dl, nm) end
    A.s-include-name(dl, A.s-local-ref(dl, A.s-name(dl, nm), asn))
  end
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
  parse-named(src, "parser")
end

### parse, recording `uri` as the source name in every srcloc.
fun parse-named(src :: String, uri :: String) -> A.Program:
  src-name := uri
  last-tok := tok-eof
  tok-stream := tokenize(src)
  parse-program(p-state)
end

### parse just an expression (handy for tests / REPL-ish uses).
fun parse-expr-string(src :: String) -> A.Expr:
  src-name := "parser"
  last-tok := tok-eof
  tok-stream := tokenize(src)
  parse-binop(p-state)
end
