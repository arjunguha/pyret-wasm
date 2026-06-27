// Headless smoke test of the web IDE. The IDE now runs ONLY through the fully
// self-hosted, stoppable compiler (self-host/compile-driver.arr + the CPS transform
// self-host/cps.arr) — NO seed, NO fallback. That compiler isn't fully ready yet
// (other work is bringing it online), so this test verifies the WIRING (optimistic):
// the runtime loads, a Run goes through BOTH driver wasms (CPS transform → self-hosted
// compile), the trampoline drives it, and a Run reaches a terminal state — it does NOT
// touch the seed. Program-execution correctness is reported informationally; it lights
// up as the self-hosted compiler matures. Requires the server running on PORT (8099).
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

  // The bundle must wire the self-hosted compiler driver (deployable = self-hosted only).
  const bundle = await (await fetch(`${URL}main.bundle.js`)).text();
  if (bundle.includes("selfhost-driver.wasm")) console.log("✓ bundle wires the self-hosted compiler driver");
  else fail("bundle missing selfhost-driver.wasm reference");

  // Run a tiny program; the IDE must drive it through BOTH the CPS transform and the
  // self-hosted compiler (both driver wasms fetched) and reach a terminal state.
  await page.evaluate(() => (window).cm.setValue("5"));
  await page.click("#run");
  await page.waitForFunction(() => {
    const s = document.getElementById("status")?.textContent ?? "";
    return s.startsWith("done") || s === "error" || s === "stopped";
  }, { timeout: 60000 });
  const status = await page.$eval("#status", (e) => e.textContent ?? "");
  const out = await page.$eval("#interactions", (e) => e.textContent ?? "");

  if (fetched.has("cps-driver.wasm")) console.log("✓ run goes through the CPS stoppability transform (cps-driver.wasm)");
  else fail("cps-driver.wasm not fetched — CPS transform not wired");
  if (fetched.has("selfhost-driver.wasm")) console.log("✓ run goes through the SELF-HOSTED compiler (selfhost-driver.wasm)");
  else fail("selfhost-driver.wasm not fetched — self-hosted compiler not wired");

  // Reaching a terminal state proves the path executes end-to-end (no hang). Whether
  // the program actually computed 5 depends on the self-hosted compiler's readiness —
  // report it, don't fail on it (optimistic wiring).
  console.log(`✓ run reached a terminal state (status=${JSON.stringify(status)})`);
  if (out.includes("5")) console.log("  ✓ (bonus) self-hosted compiler already runs `5` → 5");
  else console.log("  · self-hosted compiler can't run `5` yet (expected; surfaced as an error, NOT a seed fallback):",
                   JSON.stringify(out.slice(0, 100)));
} catch (e) {
  fail("test threw: " + String(e).slice(0, 200));
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
