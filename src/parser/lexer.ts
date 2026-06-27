// Faithful-ish hand-written lexer for Pyret.
// Mirrors pyret/lang/src/js/base/pyret-tokenizer.js. Pyret's real tokenizer
// feeds a GLR parser and can emit ambiguous tokens (e.g. `<` as LANGLE or LT);
// since we use recursive descent, we record `precededByWs` on each token and
// let the parser disambiguate, while emitting space-sensitive paren tokens
// (PARENSPACE vs PARENNOSPACE) directly.

import type { SrcLoc, Token } from "./tokens.ts";
import { WORD_KEYWORDS, COLON_KEYWORDS } from "./tokens.ts";

const DIGIT = /[0-9]/;
const IDENT_START = /[_A-Za-z]/;
const IDENT_CHAR = /[_A-Za-z0-9]/;

export class LexError extends Error {
  loc: SrcLoc;
  constructor(message: string, loc: SrcLoc) {
    super(message);
    this.name = "LexError";
    this.loc = loc;
  }
}

export interface LexedToken extends Token {
  precededByWs: boolean;
}

export function lex(src: string): LexedToken[] {
  return new Lexer(src).run();
}

class Lexer {
  str: string;
  len: number;
  pos = 0;
  line = 1;
  col = 0;
  precededByWs = true; // start of file counts as whitespace
  tokens: LexedToken[] = [];

  constructor(src: string) {
    this.str = src;
    this.len = src.length;
  }

  private here(): { line: number; col: number; pos: number } {
    return { line: this.line, col: this.col, pos: this.pos };
  }

  private mkLoc(start: { line: number; col: number; pos: number }): SrcLoc {
    return {
      startLine: start.line,
      startCol: start.col,
      startChar: start.pos,
      endLine: this.line,
      endCol: this.col,
      endChar: this.pos,
    };
  }

  private advance(n = 1) {
    for (let i = 0; i < n; i++) {
      if (this.str[this.pos] === "\n") {
        this.line++;
        this.col = 0;
      } else {
        this.col++;
      }
      this.pos++;
    }
  }

  private peek(o = 0): string {
    return this.str[this.pos + o] ?? "";
  }

  private push(name: string, value: string, start: { line: number; col: number; pos: number }) {
    this.tokens.push({ name, value, loc: this.mkLoc(start), precededByWs: this.precededByWs });
    this.precededByWs = false;
  }

  run(): LexedToken[] {
    while (this.pos < this.len) {
      if (!this.skipTrivia()) {
        this.lexToken();
      }
    }
    const eofStart = this.here();
    this.tokens.push({ name: "EOF", value: "", loc: this.mkLoc(eofStart), precededByWs: this.precededByWs });
    return this.tokens;
  }

  // Returns true if it consumed whitespace/comments (sets precededByWs).
  private skipTrivia(): boolean {
    let consumed = false;
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\r" || c === "\n") {
        this.advance();
        consumed = true;
        continue;
      }
      // Block comment #| ... |#  (nestable)
      if (c === "#" && this.peek(1) === "|") {
        this.lexBlockComment();
        consumed = true;
        continue;
      }
      // Line comment
      if (c === "#") {
        while (this.pos < this.len && this.peek() !== "\n") this.advance();
        consumed = true;
        continue;
      }
      break;
    }
    if (consumed) this.precededByWs = true;
    return consumed;
  }

  private lexBlockComment() {
    const start = this.here();
    this.advance(2); // #|
    let depth = 1;
    while (this.pos < this.len && depth > 0) {
      if (this.peek() === "#" && this.peek(1) === "|") {
        this.advance(2);
        depth++;
      } else if (this.peek() === "|" && this.peek(1) === "#") {
        this.advance(2);
        depth--;
      } else {
        this.advance();
      }
    }
    if (depth > 0) throw new LexError("Unterminated block comment", this.mkLoc(start));
  }

  private lexToken() {
    const c = this.peek();
    // Numbers: firsts ~ - + digit  (with the precise sub-rules below)
    if (DIGIT.test(c) || ((c === "~" || c === "-" || c === "+") && this.looksLikeNumber())) {
      if (this.tryNumber()) return;
    }
    if (IDENT_START.test(c)) {
      this.lexNameOrKeyword();
      return;
    }
    if (c === '"' || c === "'") {
      this.lexString(c);
      return;
    }
    if (c === "`" && this.peek(1) === "`" && this.peek(2) === "`") {
      this.lexTripleString();
      return;
    }
    this.lexPunctuation();
  }

  // Heuristic mirror of Pyret: after optional ~ and optional sign, a digit must
  // follow (a leading "." is a BAD-NUMBER, handled as not-a-number here).
  private looksLikeNumber(): boolean {
    let i = this.pos;
    if (this.str[i] === "~") i++;
    if (this.str[i] === "-" || this.str[i] === "+") i++;
    return DIGIT.test(this.str[i] ?? "");
  }

  private tryNumber(): boolean {
    const start = this.here();
    const savedPos = this.pos, savedLine = this.line, savedCol = this.col;
    let rough = false;
    if (this.peek() === "~") {
      rough = true;
      this.advance();
    }
    if (this.peek() === "-" || this.peek() === "+") this.advance();
    if (this.peek() === ".") {
      this.pos = savedPos; this.line = savedLine; this.col = savedCol;
      return false;
    }
    if (!DIGIT.test(this.peek())) {
      this.pos = savedPos; this.line = savedLine; this.col = savedCol;
      return false;
    }
    while (DIGIT.test(this.peek())) this.advance();
    // Fraction: a/b
    if (this.peek() === "/") {
      this.advance();
      if (DIGIT.test(this.peek())) {
        while (DIGIT.test(this.peek())) this.advance();
        this.push(rough ? "ROUGHRATIONAL" : "RATIONAL", this.str.slice(start.pos, this.pos), start);
        return true;
      } else {
        // not a fraction; reset to before "/"
        this.pos--; this.col--; // single-char back-up (no newline possible here)
        this.push("NUMBER", this.str.slice(start.pos, this.pos), start);
        return true;
      }
    }
    // Decimal portion
    if (this.peek() === ".") {
      const dotPos = this.pos, dotLine = this.line, dotCol = this.col;
      this.advance();
      if (DIGIT.test(this.peek())) {
        while (DIGIT.test(this.peek())) this.advance();
      } else {
        // "." not followed by digit: not part of the number
        this.pos = dotPos; this.line = dotLine; this.col = dotCol;
        this.push("NUMBER", this.str.slice(start.pos, this.pos), start);
        return true;
      }
    }
    // Exponent
    if (this.peek() === "e" || this.peek() === "E") {
      let adv = 1;
      if (this.peek(adv) === "+" || this.peek(adv) === "-") adv++;
      if (DIGIT.test(this.peek(adv))) {
        adv++;
        while (DIGIT.test(this.peek(adv))) adv++;
        this.advance(adv);
      }
    }
    this.push("NUMBER", this.str.slice(start.pos, this.pos), start);
    return true;
  }

  private lexNameOrKeyword() {
    const start = this.here();
    this.advance();
    while (this.pos < this.len) {
      const c = this.peek();
      if (IDENT_CHAR.test(c)) {
        this.advance();
      } else if (c === "-") {
        // dashes allowed mid-identifier only if followed (after runs of -) by ident char
        let front = this.pos + 1;
        while (this.str[front] === "-") front++;
        if (IDENT_CHAR.test(this.str[front] ?? "")) {
          this.advance(front - this.pos);
        } else break;
      } else break;
    }
    let text = this.str.slice(start.pos, this.pos);

    // `is==`, `is=~`, `is-not==`, etc.: keywords with trailing operators
    const opExt = this.tryOperatorKeywordExtension(text);
    if (opExt) {
      this.advance(opExt.length - text.length);
      text = opExt;
    }

    // Colon keyword (name immediately followed by ':')
    if (this.peek() === ":" && COLON_KEYWORDS[text] !== undefined) {
      // not "::" — that's COLONCOLON, which would mean a contract on `name`
      if (this.peek(1) !== ":") {
        this.advance();
        this.push(COLON_KEYWORDS[text]!, text + ":", start);
        return;
      }
    }
    // `else if`
    if (text === "else" && this.peek() === " " && this.str.startsWith("if", this.pos + 1)) {
      const after = this.str[this.pos + 3] ?? "";
      if (!IDENT_CHAR.test(after) && after !== "-") {
        this.advance(3); // " if"
        this.push("ELSEIF", "else if", start);
        return;
      }
    }
    const kw = WORD_KEYWORDS[text];
    this.push(kw ?? "NAME", text, start);
  }

  // Handle the `is==`, `is=~`, `is-not==`, `is-not=~`, `is<=>`, `is-not<=>` family.
  private tryOperatorKeywordExtension(text: string): string | null {
    if (text !== "is" && text !== "is-not") return null;
    const rest = this.str.slice(this.pos);
    for (const suf of ["<=>", "==", "=~"]) {
      if (rest.startsWith(suf)) return text + suf;
    }
    return null;
  }

  private lexString(quote: string) {
    const start = this.here();
    this.advance(); // opening quote
    let value = "";
    while (this.pos < this.len) {
      const c = this.peek();
      if (c === quote) {
        this.advance();
        this.push("STRING", value, start);
        return;
      }
      if (c === "\n") {
        throw new LexError("Unterminated string literal", this.mkLoc(start));
      }
      if (c === "\\") {
        this.advance();
        value += this.readEscape();
      } else {
        value += c;
        this.advance();
      }
    }
    throw new LexError("Unterminated string literal", this.mkLoc(start));
  }

  private lexTripleString() {
    const start = this.here();
    this.advance(3);
    let value = "";
    while (this.pos < this.len) {
      if (this.peek() === "`" && this.peek(1) === "`" && this.peek(2) === "`") {
        this.advance(3);
        this.push("STRING", value, start);
        return;
      }
      if (this.peek() === "\\") {
        this.advance();
        value += this.readEscape();
      } else {
        value += this.peek();
        this.advance();
      }
    }
    throw new LexError("Unterminated multi-line string literal", this.mkLoc(start));
  }

  private readEscape(): string {
    const c = this.peek();
    this.advance();
    switch (c) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "\\": return "\\";
      case '"': return '"';
      case "'": return "'";
      case "`": return "`";
      case "u": {
        let hex = "";
        while (hex.length < 4 && /[0-9a-fA-F]/.test(this.peek())) { hex += this.peek(); this.advance(); }
        return String.fromCodePoint(parseInt(hex, 16));
      }
      default: return c;
    }
  }

  // Punctuation, brackets, and whitespace-sensitive operators.
  private lexPunctuation() {
    const start = this.here();
    const c = this.peek();
    const wsBefore = this.precededByWs;

    const wsAfterAt = (off: number) => {
      const nc = this.str[this.pos + off] ?? "";
      return nc === "" || nc === " " || nc === "\t" || nc === "\r" || nc === "\n";
    };

    // Three-char
    if (c === "." && this.peek(1) === "." && this.peek(2) === ".") {
      this.advance(3); this.push("DOTDOTDOT", "...", start); return;
    }
    if (c === "<" && this.peek(1) === "=" && this.peek(2) === ">") {
      this.advance(3); this.push("SPACESHIP", "<=>", start); return;
    }

    // Two-char operators
    const two = c + this.peek(1);
    const twoMap: Record<string, string> = {
      "->": "THINARROW",
      ":=": "COLONEQUALS",
      "::": "COLONCOLON",
      "=>": "THICKARROW",
      "<=": "LEQ",
      ">=": "GEQ",
      "==": "EQUALEQUAL",
      "=~": "EQUALTILDE",
      "<>": "NEQ",
    };
    if (twoMap[two] !== undefined) {
      this.advance(2);
      this.push(twoMap[two]!, two, start);
      return;
    }

    // Single-char punctuation that is not whitespace-sensitive
    switch (c) {
      case "(": {
        this.advance();
        // PARENSPACE when preceded by whitespace (grouping); else application
        this.push(wsBefore ? "PARENSPACE" : "PARENNOSPACE", "(", start);
        return;
      }
      case ")": this.advance(); this.push("RPAREN", ")", start); return;
      case "[": this.advance(); this.push("LBRACK", "[", start); return;
      case "]": this.advance(); this.push("RBRACK", "]", start); return;
      case "{": this.advance(); this.push("LBRACE", "{", start); return;
      case "}": this.advance(); this.push("RBRACE", "}", start); return;
      case ";": this.advance(); this.push("SEMI", ";", start); return;
      case ",": this.advance(); this.push("COMMA", ",", start); return;
      case ".": this.advance(); this.push("DOT", ".", start); return;
      case "!": this.advance(); this.push("BANG", "!", start); return;
      case "%": this.advance(); this.push("PERCENT", "%", start); return;
      case "\\": this.advance(); this.push("BACKSLASH", "\\", start); return;
      case ":": this.advance(); this.push("COLON", ":", start); return;
      case "|": this.advance(); this.push("BAR", "|", start); return;
    }

    // Whitespace-sensitive binary operators: require ws on both sides to be a
    // binop. `<` `>` `=` are emitted as LANGLE/RANGLE/EQUALS (the parser
    // promotes to LT/GT/comparison based on the recorded precededByWs).
    const wsAfter = wsAfterAt(1);
    switch (c) {
      case "+": this.advance(); this.push("PLUS", "+", start); return;
      case "*": this.advance(); this.push("TIMES", "*", start); return;
      case "/": this.advance(); this.push("SLASH", "/", start); return;
      case "^": this.advance(); this.push("CARET", "^", start); return;
      case "-": this.advance(); this.push("DASH", "-", start); return;
      case "=": this.advance(); this.push("EQUALS", "=", start); return;
      case "<": this.advance(); this.push("LANGLE", "<", start); return;
      case ">": this.advance(); this.push("RANGLE", ">", start); return;
    }
    void wsAfter;

    throw new LexError(`Unexpected character ${JSON.stringify(c)}`, this.mkLoc(start));
  }
}
