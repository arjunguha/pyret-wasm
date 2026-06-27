// Main-thread IDE controller. Runs Pyret ON THE UI THREAD (no Web Worker) via
// window.PyretRunner (web/main.bundle.js): the compiled CPS code yields to the
// event loop periodically, so the Stop button — a cooperative flag checked at
// each yield — interrupts even infinite loops without terminating a worker.
// The editor is CodeMirror with CPO's Pyret mode; the Interactions pane has a
// REPL prompt that evaluates expressions in the context of the definitions.

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
const repl = document.getElementById("repl");

let ready = false;
let mode = "idle";   // "run" | "repl" | "idle"
let replBuf = "";    // buffers output during a REPL eval
let handle = null;   // current RunHandle ({ stop, promise }) while running

function append(text, cls) {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  interactions.appendChild(span);
  interactions.scrollTop = interactions.scrollHeight;
}

// Render one output line: if it is a Pyret image value, draw it to a <canvas>;
// otherwise append it as text. (Images render to text as `op(arg, ...)`.)
function appendLine(line) {
  if (window.PyretImage && window.PyretImage.isImageString(line)) {
    const canvas = window.PyretImage.renderToCanvas(line);
    if (canvas) {
      interactions.appendChild(canvas);
      interactions.appendChild(document.createTextNode("\n"));
      interactions.scrollTop = interactions.scrollHeight;
      return;
    }
  }
  append(line + "\n");
}

let outBuf = ""; // buffers streamed run output until newlines (for image detection)

function flushOut(final) {
  const parts = outBuf.split("\n");
  outBuf = final ? "" : parts.pop(); // keep trailing partial line unless final
  for (const p of parts) appendLine(p);
  if (final && outBuf) { appendLine(outBuf); outBuf = ""; }
}

function onOut(text) {
  if (mode === "repl") { replBuf += text; return; }
  outBuf += text;
  flushOut(false);
}

function setRunning(running) {
  runBtn.disabled = running || !ready;
  stopBtn.disabled = !running;
  repl.disabled = running || !ready;
}

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
  setRunning(true);
  statusEl.textContent = asRepl ? "evaluating…" : "running…";
  try {
    handle = await window.PyretRunner.run(src, { stdout: onOut });
    const result = await handle.promise;
    finish(result, t0);
  } catch (err) {
    if (mode === "repl") replBuf = "";
    append(String((err && err.message) || err) + "\n", "out-err");
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

runBtn.addEventListener("click", run);
stopBtn.addEventListener("click", stop);
repl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const v = repl.value.trim();
    if (v && !repl.disabled) { runRepl(v); repl.value = ""; }
  }
});
