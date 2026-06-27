// Static file server for the web IDE.  `bun run serve` then open the URL.
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
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(resolve(WEB, "." + path));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file);
  },
});

console.log(`Pyret IDE serving at http://${hostname}:${port} (also http://localhost:${port})`);
