// Main-thread IDE controller. Runs Pyret ON THE UI THREAD (no Web Worker) via
// window.PyretRunner (web/main.bundle.js): the compiled CPS code yields to the
// event loop periodically, so the Stop button — a cooperative flag checked at
// each yield — interrupts even infinite loops without terminating a worker. The
// SAME pause points back the debugger (Pause/Resume/Step). The editor is
// CodeMirror with CPO's Pyret mode; the Interactions pane has a REPL prompt that
// evaluates expressions in the context of the definitions.

const cm = CodeMirror.fromTextArea(document.getElementById("editor"), {
  mode: "pyret",
  lineNumbers: true,
  indentUnit: 2,
  tabSize: 2,
  matchBrackets: true,
  extraKeys: {
    "Cmd-Enter": () => { if (!runBtn.disabled) run(); },
    "Ctrl-Enter": () => { if (!runBtn.disabled) run(); },
    Tab: (ed) => ed.execCommand("insertSoftTab"),
  },
});

window.cm = cm; // exposed for the headless smoke test
// CM measured before its flex wrapper had final dimensions; refresh so the
// editor fills to the bottom and gutter widths are correct.
setTimeout(() => cm.refresh(), 0);
window.addEventListener("resize", () => cm.refresh());
const interactions = document.getElementById("interactions");
const statusEl = document.getElementById("status");
const runBtn = document.getElementById("run");
const stopBtn = document.getElementById("stop");
const pauseBtn = document.getElementById("pause");
const stepBtn = document.getElementById("step");
const repl = document.getElementById("repl");

let ready = false;
let mode = "idle";   // "run" | "repl" | "idle"
let replBuf = "";    // buffers output during a REPL eval
let handle = null;   // current RunHandle while running
let paused = false;  // debugger: held at a pause point

function append(text, cls) {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  interactions.appendChild(span);
  interactions.scrollTop = interactions.scrollHeight;
}

// Move the editor cursor to a 1-based line / 0-based column and focus it.
function jumpTo(line1, col0) {
  cm.setCursor({ line: Math.max(0, line1 - 1), ch: Math.max(0, col0) });
  cm.focus();
}

// Errors get a bordered panel; any source location in the text ("line L, column C"
// or ":L:C") becomes a clickable link that moves the editor cursor there.
const LOC_RE = /(at line (\d+), column (\d+))|(:(\d+):(\d+))/g;
function appendError(text) {
  const box = document.createElement("div");
  box.className = "error-box";
  const t = text.replace(/\n+$/, "");
  let last = 0, m;
  LOC_RE.lastIndex = 0;
  while ((m = LOC_RE.exec(t))) {
    if (m.index > last) box.appendChild(document.createTextNode(t.slice(last, m.index)));
    const line1 = Number(m[2] ?? m[5]);
    const col0 = Number(m[3] ?? m[6]);
    const link = document.createElement("a");
    link.className = "err-loc";
    link.href = "#";
    link.textContent = m[0];
    link.title = "jump to this location";
    link.addEventListener("click", (e) => { e.preventDefault(); jumpTo(line1, col0); });
    box.appendChild(link);
    last = LOC_RE.lastIndex;
  }
  if (last < t.length) box.appendChild(document.createTextNode(t.slice(last)));
  interactions.appendChild(box);
  interactions.scrollTop = interactions.scrollHeight;
}

const MAX_VALUE_LEN = 4000; // truncate pathologically long rendered values

// Tokenize a printed Pyret value and wrap each token in a colored span, so lists
// (`[list: 1, 2, 3]`), records (`{x: 1}`), tuples (`{1; 2}`), strings, numbers,
// and booleans render richly. Plain prose passes through (only value-shaped
// tokens are colored), matching CPO's value highlighting.
const VALUE_RE = /("(?:[^"\\]|\\.)*")|(\btrue\b|\bfalse\b|\bnothing\b)|([A-Za-z_][\w-]*:)|(~?-?\d+\/\d+|~?-?\d+\.\d+|~?-?\d+)|([[\]{}();])/g;
function appendValue(line) {
  let text = line;
  if (text.length > MAX_VALUE_LEN) text = text.slice(0, MAX_VALUE_LEN) + " …(truncated)";
  const frag = document.createDocumentFragment();
  let last = 0, m;
  VALUE_RE.lastIndex = 0;
  while ((m = VALUE_RE.exec(text))) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const span = document.createElement("span");
    span.className = m[1] ? "v-str" : m[2] ? "v-bool" : m[3] ? "v-kw" : m[4] ? "v-num" : "v-punct";
    span.textContent = m[0];
    frag.appendChild(span);
    last = VALUE_RE.lastIndex;
  }
  frag.appendChild(document.createTextNode(text.slice(last) + "\n"));
  interactions.appendChild(frag);
  interactions.scrollTop = interactions.scrollHeight;
}

// A table value spans several lines (`table:` … `row:` … `end`); buffer them and
// render an HTML <table> once complete. (See web/table.js for the format note.)
let tableBuf = null; // string[] while collecting a table block, else null
function renderTableBlock() {
  const text = tableBuf.join("\n");
  tableBuf = null;
  const el = window.PyretTable && window.PyretTable.toTable(text);
  if (el) { interactions.appendChild(el); interactions.scrollTop = interactions.scrollHeight; }
  else append(text + "\n"); // fell through: show as text
}

// Render one output line: table block → <table>; image value → <canvas>; check
// result lines get distinct styling; everything else is value-tokenized text.
function appendLine(line) {
  if (tableBuf !== null) {
    tableBuf.push(line);
    if (/^\s*end\s*$/.test(line)) renderTableBlock();
    return;
  }
  if (window.PyretTable && /^\s*table:/.test(line)) { tableBuf = [line]; return; }
  if (window.PyretImage && window.PyretImage.isImageString(line)) {
    const canvas = window.PyretImage.renderToCanvas(line);
    if (canvas) {
      interactions.appendChild(canvas);
      interactions.appendChild(document.createTextNode("\n"));
      interactions.scrollTop = interactions.scrollHeight;
      return;
    }
  }
  if (/^\s*test failed:/.test(line)) { append(line + "\n", "check-fail"); return; }
  if (/^Looks shipshape/.test(line)) { append(line + "\n", "check-pass"); return; }
  if (/^Test results:/.test(line)) {
    append(line + "\n", /\b0 failed/.test(line) ? "check-summary" : "check-summary warn");
    return;
  }
  appendValue(line);
}

let outBuf = ""; // buffers streamed run output until newlines (for image/table detection)

function flushOut(final) {
  const parts = outBuf.split("\n");
  outBuf = final ? "" : parts.pop(); // keep trailing partial line unless final
  for (const p of parts) appendLine(p);
  if (final) {
    if (outBuf) { appendLine(outBuf); outBuf = ""; }
    if (tableBuf !== null) renderTableBlock(); // close an unterminated table block
  }
}

function onOut(text) {
  if (mode === "repl") { replBuf += text; return; }
  outBuf += text;
  flushOut(false);
}

// Debugger button state: Pause is live only while running; Step only while paused.
function setDebugButtons(running) {
  if (!pauseBtn || !stepBtn) return;
  pauseBtn.disabled = !running;
  pauseBtn.textContent = paused ? "Resume ▶" : "Pause ⏸";
  stepBtn.disabled = !(running && paused);
}

function setRunning(running) {
  runBtn.disabled = running || !ready;
  stopBtn.disabled = !running;
  repl.disabled = running || !ready;
  if (!running) paused = false;
  setDebugButtons(running);
}

// called by the runtime (or runControlled) as execution pauses/resumes
function onState(s) {
  paused = (s === "paused");
  statusEl.textContent = paused ? "paused" : "running…";
  setDebugButtons(true);
}

// count of cooperative pause points reached this run (exposed for the headless test
// to observe that Pause freezes the count and Step/Resume advance it)
window.__pausesSeen = 0;
function onPause(n) { window.__pausesSeen = n; }

// called by web/main.bundle.js once the WASM compiler/runtime is loaded
window.onPyretReady = () => {
  ready = true;
  setRunning(false);
  statusEl.textContent = "ready";
  repl.focus();
};
if (window.pyretReady) window.onPyretReady();

function flushReplValue() {
  // The expression's value is the last non-noise line (definitions re-run
  // statelessly, so their check summary/failures may also appear).
  const isNoise = (l) => /^Looks shipshape|^Test results:|^\s*test failed/.test(l);
  const lines = replBuf.replace(/\s+$/, "").split("\n").filter((l) => l.length && !isNoise(l));
  const last = lines[lines.length - 1];
  if (last) appendLine(last);
  replBuf = "";
}

function finish(result, t0) {
  if (mode === "run") flushOut(true);
  if (result.stopped) {
    if (mode === "repl") replBuf = "";
    append("\n[Stopped]\n", "out-muted");
    statusEl.textContent = "stopped";
  } else if (result.error) {
    if (mode === "repl") flushReplValue();
    appendError(result.error);
    statusEl.textContent = "error";
  } else {
    if (mode === "repl") flushReplValue();
    statusEl.textContent = `done in ${Math.round(performance.now() - t0)} ms`;
  }
  handle = null;
  mode = "idle";
  setRunning(false);
  if (ready) repl.focus();
}

async function execute(src, asRepl) {
  const t0 = performance.now();
  mode = asRepl ? "repl" : "run";
  replBuf = "";
  outBuf = "";
  paused = false;
  setRunning(true);
  statusEl.textContent = asRepl ? "evaluating…" : "running…";
  try {
    window.__pausesSeen = 0;
    handle = await window.PyretRunner.run(src, { stdout: onOut, onState, onPause });
    const result = await handle.promise;
    finish(result, t0);
  } catch (err) {
    if (mode === "repl") replBuf = "";
    appendError(String((err && err.message) || err));
    handle = null;
    mode = "idle";
    setRunning(false);
    statusEl.textContent = "error";
  }
}

function run() {
  interactions.textContent = "";
  execute(cm.getValue(), false);
}

function runRepl(input) {
  append("› " + input + "\n", "repl-echo");
  // evaluate the expression in the context of the current definitions
  execute(cm.getValue() + "\n" + input, true);
}

function stop() {
  if (handle) handle.stop();
  // finish() runs when the trampoline resolves with stopped:true; if the run
  // was a non-stoppable fallback, stop() is a no-op (it cannot be interrupted).
}

function togglePause() {
  if (!handle) return;
  if (paused) handle.resume(); else handle.pause();
  // onState() will flip the labels/status when the trampoline reaches a pause point
}

function stepOnce() {
  if (handle && paused) handle.step();
}

runBtn.addEventListener("click", run);
stopBtn.addEventListener("click", stop);
if (pauseBtn) pauseBtn.addEventListener("click", togglePause);
if (stepBtn) stepBtn.addEventListener("click", stepOnce);
repl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const v = repl.value.trim();
    if (v && !repl.disabled) { runRepl(v); repl.value = ""; }
  }
});
