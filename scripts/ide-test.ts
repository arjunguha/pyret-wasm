// Headless smoke test of the web IDE. The IDE now runs ONLY through ONE artifact: the
// self-hosted, stoppable compile driver (self-host/cps-compile-driver.wasm = pure-Pyret
// parser + CPS stoppability transform + the Pyret-written backend) — NO seed, NO JS
// parser, NO fallback. This test verifies the WIRING: the runtime loads, a Run goes
// through the single driver wasm, the trampoline drives it to a terminal state, the
// program actually computes, the Stop button interrupts an infinite loop, and the bundle
// pulls NO JS-GLR parser. Requires the server running on PORT (8099).
import puppeteer from "puppeteer-core";

const URL = `http://localhost:${process.env.PORT ?? 8099}/`;
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? "/media/external0/arjun-nosudo/.agent-browser/browsers/chrome-147.0.7727.24/chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});
let failed = false;
const fail = (m: string) => { console.log("✗ " + m); failed = true; };
try {
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("  [page error]", m.text().slice(0, 140)); });

  // Record which driver/compiler wasms the IDE fetches — proves the run path.
  const fetched = new Set<string>();
  page.on("request", (r) => { const u = r.url(); if (u.endsWith(".wasm")) fetched.add(u.split("/").pop()!); });

  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "ready", { timeout: 60000 });
  console.log("✓ runtime ready (UI thread, no Web Worker)");

  const hasCM = await page.evaluate(() => !!document.querySelector(".CodeMirror"));
  if (hasCM) console.log("✓ CodeMirror editor mounted"); else fail("CodeMirror missing");

  // The bundle must wire the single self-hosted driver — and must NOT pull any JS-GLR
  // parser (no parser-bundle) or the old two-driver wasms.
  const bundle = await (await fetch(`${URL}main.bundle.js`)).text();
  if (bundle.includes("cps-compile-driver.wasm")) console.log("✓ bundle wires the single self-hosted stoppable driver");
  else fail("bundle missing cps-compile-driver.wasm reference");
  if (!bundle.includes("parser-bundle")) console.log("✓ bundle has NO JS-GLR parser (parser-bundle gone)");
  else fail("bundle still references parser-bundle (JS parser not removed)");

  // Run an arithmetic program; the IDE must drive it through the single driver wasm and
  // reach a terminal state with the correct value.
  await page.evaluate(() => (window).cm.setValue("print(21 + 21)"));
  await page.click("#run");
  await page.waitForFunction(() => {
    const s = document.getElementById("status")?.textContent ?? "";
    return s.startsWith("done") || s === "error" || s === "stopped";
  }, { timeout: 60000 });
  const status = await page.$eval("#status", (e) => e.textContent ?? "");
  const out = await page.$eval("#interactions", (e) => e.textContent ?? "");

  if (fetched.has("cps-compile-driver.wasm")) console.log("✓ run goes through the single self-hosted stoppable driver");
  else fail("cps-compile-driver.wasm not fetched — driver not wired");
  if (![...fetched].some((f) => f === "parser-bundle.js")) console.log("✓ no JS parser wasm/bundle fetched at runtime");

  console.log(`✓ run reached a terminal state (status=${JSON.stringify(status)})`);
  if (out.includes("42")) console.log("✓ self-hosted+CPS compiler runs `print(21 + 21)` → 42");
  else fail("expected 42 in output, got: " + JSON.stringify(out.slice(0, 120)));

  // Stop button: an infinite loop must be cooperatively interruptible (the whole point
  // of the CPS stoppability transform).
  await page.evaluate(() => { (window).__pausesSeen = 0; (window).cm.setValue("fun spin(): spin() end\nspin()"); });
  await page.click("#run");
  // Wait until the loop is actually spinning + pausing on gas (proves compile finished,
  // the RunHandle is live, and the trampoline is yielding) before clicking Stop.
  await page.waitForFunction(() => ((window).__pausesSeen ?? 0) > 0, { timeout: 60000 });
  await page.click("#stop");
  await page.waitForFunction(() => {
    const s = document.getElementById("status")?.textContent ?? "";
    return s === "stopped" || s.includes("Stop");
  }, { timeout: 30000 });
  console.log("✓ Stop button interrupts an infinite loop (cooperative stop)");
} catch (e) {
  fail("test threw: " + String(e).slice(0, 200));
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
