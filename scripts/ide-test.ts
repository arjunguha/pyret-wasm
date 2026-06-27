// Headless-browser smoke test of the web IDE: verifies Run produces output and
// Stop interrupts an infinite loop. Requires the server running on PORT (8099).
import puppeteer from "puppeteer-core";

const URL = `http://localhost:${process.env.PORT ?? 8099}/`;
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? "/media/external0/arjun-nosudo/.agent-browser/browsers/chrome-147.0.7727.24/chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});
let failed = false;
try {
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("  [page error]", m.text().slice(0, 120)); });
  await page.goto(URL, { waitUntil: "domcontentloaded" });

  // wait for the UI-thread runtime (WASM compiler) to finish loading
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "ready", { timeout: 60000 });
  console.log("✓ runtime ready (UI thread, no Web Worker)");

  // Run the default program (fact(20) + check block)
  await page.click("#run");
  await page.waitForFunction(() => {
    const s = document.getElementById("status")?.textContent ?? "";
    return s.startsWith("done") || s === "error";
  }, { timeout: 30000 });
  const out1 = await page.$eval("#interactions", (e) => e.textContent ?? "");
  console.log("output:", JSON.stringify(out1.slice(0, 120)));
  if (!out1.includes("2432902008176640000")) { console.log("✗ fact(20) wrong"); failed = true; }
  else console.log("✓ Run works (fact(20) = 2432902008176640000)");
  if (!out1.includes("passed")) { console.log("✗ check summary missing"); failed = true; }
  else console.log("✓ check block ran");
  // the passing summary line is styled distinctly (CPO-style)
  const styledSummary = await page.evaluate(() =>
    !!document.querySelector("#interactions .check-pass, #interactions .check-summary"));
  if (styledSummary) console.log("✓ check summary styled (.check-pass)");
  else { console.log("✗ check summary not styled"); failed = true; }

  // CodeMirror editor present
  const hasCM = await page.evaluate(() => !!document.querySelector(".CodeMirror"));
  if (hasCM) console.log("✓ CodeMirror editor mounted"); else { console.log("✗ CodeMirror missing"); failed = true; }

  // REPL test: type an expression, press Enter, expect just the result
  await page.evaluate(() => (window).cm.setValue("x = 21"));
  await page.click("#repl");
  await page.type("#repl", "x * 2");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (document.getElementById("interactions")?.textContent ?? "").includes("42"), { timeout: 15000 });
  const replOut = await page.$eval("#interactions", (e) => e.textContent ?? "");
  if (replOut.includes("› x * 2") && replOut.includes("42")) console.log("✓ REPL evaluates expressions in context (x*2 = 42)");
  else { console.log("✗ REPL failed:", JSON.stringify(replOut.slice(-80))); failed = true; }

  // Rich value rendering: a list renders with colored value tokens (numbers + brackets).
  await page.evaluate(() => (window).cm.setValue("[list: 1, 2, 3]"));
  await page.click("#run");
  await page.waitForFunction(() => (document.getElementById("interactions")?.textContent ?? "").includes("[list: 1, 2, 3]"), { timeout: 20000 });
  const vtok = await page.evaluate(() => ({
    nums: document.querySelectorAll("#interactions .v-num").length,
    punct: document.querySelectorAll("#interactions .v-punct").length,
  }));
  if (vtok.nums >= 3 && vtok.punct >= 2) console.log("✓ rich value rendering (list tokens colored)");
  else { console.log("✗ value tokens not colored:", JSON.stringify(vtok)); failed = true; }

  // Errors render in a bordered panel, not a bare line.
  await page.evaluate(() => (window).cm.setValue("no-such-variable-zzz"));
  await page.click("#run");
  await page.waitForFunction(() => !!document.querySelector("#interactions .error-box")
    || document.getElementById("status")?.textContent === "error", { timeout: 20000 });
  const hasErrBox = await page.evaluate(() => !!document.querySelector("#interactions .error-box"));
  if (hasErrBox) console.log("✓ errors render in a panel (.error-box)");
  else { console.log("✗ error panel missing"); failed = true; }

  // Image test: a circle result renders to a <canvas> (image data lives in WASM,
  // the canvas drawing is minimal JS glue).
  await page.evaluate(() => (window).cm.setValue('circle(50, "solid", "red")'));
  await page.click("#run");
  await page.waitForFunction(() => !!document.querySelector("#interactions canvas.pyret-image"), { timeout: 20000 });
  const dims = await page.$eval("#interactions canvas.pyret-image", (c: any) => [c.width, c.height]);
  if (dims[0] === 100 && dims[1] === 100) console.log("✓ image renders to canvas (circle → 100×100)");
  else { console.log("✗ image canvas dims wrong:", dims); failed = true; }

  // overlay composites two shapes onto one canvas (100×80)
  await page.evaluate(() => (window).cm.setValue('overlay(circle(40, "solid", "blue"), rectangle(100, 60, "outline", "red"))'));
  await page.click("#run");
  await page.waitForFunction(() => {
    const c = document.querySelector("#interactions canvas.pyret-image") as any;
    return c && c.width === 100 && c.height === 80;
  }, { timeout: 20000 });
  console.log("✓ overlay composites to canvas (100×80)");

  // Cross-origin image-url via the CORS proxy must NOT taint the canvas (toDataURL ok).
  await page.evaluate(() => (window).cm.setValue('image-url("https://cse.ucsd.edu/sites/default/files/faculty/politz17-115x150.jpg")'));
  await page.click("#run");
  try {
    await page.waitForFunction(() => {
      const c = document.querySelector("#interactions canvas") as any;
      if (!(c && c.width === 115 && c.height === 150)) return false;
      try { c.toDataURL(); return true; } catch (_e) { return false; } // untainted?
    }, { timeout: 30000 });
    console.log("✓ cross-origin image-url via proxy renders untainted (toDataURL ok, 115×150)");
  } catch (_e) {
    console.log("✗ cross-origin image-url tainted or failed to load (network?)"); failed = true;
  }

  // Stop test: infinite loop
  await page.evaluate(() => (window).cm.setValue("fun loop(n): loop(n + 1) end\nloop(0)"));
  await page.click("#run");
  await new Promise((r) => setTimeout(r, 800)); // let it spin
  const runningStatus = await page.$eval("#status", (e) => e.textContent ?? "");
  await page.click("#stop");
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "stopped", { timeout: 10000 });
  const out2 = await page.$eval("#interactions", (e) => e.textContent ?? "");
  if (runningStatus === "running…" && out2.includes("[Stopped]")) console.log("✓ Stop button interrupts an infinite loop");
  else { console.log("✗ Stop failed; status was", runningStatus); failed = true; }

  // Table rendering path: PyretTable.toTable turns a printed table value into an
  // HTML <table>. (The seed can't compile `table-expr` yet, so we exercise the
  // rendering function directly — the auto-path is wired in ide.js for when it can.)
  const tbl = await page.evaluate(() => {
    const s = 'table: name, age\n  row: "Bob", 12\n  row: "Alice", 17\nend';
    const el = window.PyretTable && window.PyretTable.toTable(s);
    if (!el) return null;
    return { tag: el.tagName, headers: [...el.querySelectorAll("th")].map((e) => e.textContent),
             rows: el.querySelectorAll("tbody tr").length, cell00: el.querySelector("tbody td")?.textContent };
  });
  if (tbl && tbl.tag === "TABLE" && tbl.headers.join(",") === "name,age" && tbl.rows === 2 && tbl.cell00 === "Bob")
    console.log("✓ table value renders as an HTML <table> (2 cols, 2 rows)");
  else { console.log("✗ table rendering wrong:", JSON.stringify(tbl)); failed = true; }

  // Clickable error location: an unbound-id error shows a location link that jumps
  // the editor cursor when clicked.
  await page.evaluate(() => { (window).cm.setValue("\n\nno-such-variable-zzz"); (window).cm.setCursor({ line: 0, ch: 0 }); });
  await page.click("#run");
  await page.waitForFunction(() => !!document.querySelector("#interactions .error-box .err-loc")
    || document.getElementById("status")?.textContent === "error", { timeout: 20000 });
  const hasLoc = await page.evaluate(() => !!document.querySelector("#interactions .error-box .err-loc"));
  if (hasLoc) {
    await page.click("#interactions .error-box .err-loc");
    const cur = await page.evaluate(() => { const c = (window).cm.getCursor(); return { line: c.line, ch: c.ch }; });
    // the unbound id is on editor line 3 (0-based line 2)
    if (cur.line === 2) console.log("✓ error location is clickable and jumps the cursor (→ line 3)");
    else { console.log("✗ error-loc click moved cursor to", JSON.stringify(cur)); failed = true; }
  } else { console.log("✗ no clickable error location"); failed = true; }

  // --- Debugger: Pause freezes, Step advances, Resume continues (cooperative-stop infra) ---
  await page.evaluate(() => (window).cm.setValue("fun loop(n): loop(n + 1) end\nloop(0)"));
  await page.click("#run");
  await page.waitForFunction(() => ((window).__pausesSeen ?? 0) > 0, { timeout: 15000 });
  await page.click("#pause");
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "paused", { timeout: 10000 });
  const dbgUI = await page.evaluate(() => ({
    label: document.getElementById("pause")?.textContent,
    stepOn: !document.getElementById("step")?.disabled,
  }));
  if (dbgUI.label?.includes("Resume") && dbgUI.stepOn) console.log("✓ Pause holds at a yield (status=paused, button→Resume, Step enabled)");
  else { console.log("✗ pause UI wrong:", JSON.stringify(dbgUI)); failed = true; }
  // Frozen: the pause count must not advance while held.
  const c1 = await page.evaluate(() => (window).__pausesSeen);
  await new Promise((r) => setTimeout(r, 500));
  const c2 = await page.evaluate(() => (window).__pausesSeen);
  if (c1 === c2) console.log(`✓ Pause freezes execution (pause count steady at ${c2})`);
  else { console.log(`✗ not frozen: ${c1} → ${c2}`); failed = true; }
  // Step: advances exactly past at least one more pause point.
  await page.click("#step");
  await page.waitForFunction((prev) => ((window).__pausesSeen ?? 0) > prev, { timeout: 10000 }, c2);
  console.log("✓ Step advances one interval");
  // Resume: back to running, count climbs again.
  await page.click("#pause"); // labeled "Resume ▶" now
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "running…", { timeout: 10000 });
  const c3 = await page.evaluate(() => (window).__pausesSeen);
  await page.waitForFunction((prev) => ((window).__pausesSeen ?? 0) > prev, { timeout: 10000 }, c3);
  console.log("✓ Resume continues execution");
  await page.click("#stop");
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "stopped", { timeout: 10000 });
  console.log("✓ debugger run stops cleanly");
} catch (e) {
  console.log("✗ test threw:", String(e).slice(0, 200));
  failed = true;
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
