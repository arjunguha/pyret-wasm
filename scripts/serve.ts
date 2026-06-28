// Plain STATIC file server for the web IDE.  `bun run serve` then open the URL.
//
// This serves `web/` as pure static files — the SAME thing GitHub Pages serves, so dev
// matches prod. There is intentionally NO `/proxy` CORS image endpoint anymore: the IDE
// is a fully static site, so `image-url(...)` loads images directly (crossOrigin), and
// images from hosts without CORS headers will fail/taint the canvas (accepted limitation).
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
const port = Number(process.env.PORT ?? 8080);
const hostname = process.env.HOST ?? "0.0.0.0";

Bun.serve({
  port,
  hostname,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(resolve(WEB, "." + path));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    // Serve sourcemaps with a correct JSON content-type so devtools loads them
    // (Bun.file would otherwise label .map as octet-stream); enables original-TS debugging.
    if (path.endsWith(".map")) {
      return new Response(file, { headers: { "Content-Type": "application/json" } });
    }
    return new Response(file);
  },
});

console.log(`Pyret IDE serving at http://${hostname}:${port} (also http://localhost:${port})`);
