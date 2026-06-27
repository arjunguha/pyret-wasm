// Static file server for the web IDE.  `bun run serve` then open the URL.
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
const port = Number(process.env.PORT ?? 8080);
const hostname = process.env.HOST ?? "0.0.0.0";

const PROXY_TIMEOUT_MS = 10_000;
const PROXY_MAX_BYTES = 10 * 1024 * 1024; // 10MB

// Tiny CORS image proxy: fetch a remote image server-side and re-serve it with
// `Access-Control-Allow-Origin: *`, so the browser can load it crossOrigin=anonymous
// WITHOUT tainting the canvas (enabling pixel ops). DEV proxy — for production add a
// host allowlist; right now it forwards any http(s) URL (with a size/timeout cap).
async function proxyImage(target: string): Promise<Response> {
  let u: URL;
  try { u = new URL(target); } catch { return new Response("bad url", { status: 400 }); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return new Response("only http/https allowed", { status: 400 });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS);
  try {
    const up = await fetch(u, { signal: ctrl.signal, redirect: "follow" });
    if (!up.ok) return new Response("upstream error", { status: 502 });
    const buf = new Uint8Array(await up.arrayBuffer());
    if (buf.byteLength > PROXY_MAX_BYTES) return new Response("too large", { status: 413 });
    return new Response(buf, {
      headers: {
        "Content-Type": up.headers.get("Content-Type") ?? "application/octet-stream",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return new Response("upstream error", { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}

Bun.serve({
  port,
  hostname,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/proxy") {
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const target = url.searchParams.get("url");
      if (!target) return new Response("missing url", { status: 400 });
      return proxyImage(target);
    }
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(resolve(WEB, "." + path));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file);
  },
});

console.log(`Pyret IDE serving at http://${hostname}:${port} (also http://localhost:${port})`);
