import { readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export async function staticFrontend(directory: string) {
  const root = await realpath(directory);
  await readFile(join(root, "index.html")); // Fail startup if the build is missing.
  return async (request: IncomingMessage, response: ServerResponse, pathname: string) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return;
    }
    const file = pathname === "/" ? "index.html" : pathname.slice(1);
    const type = file === "index.html" ? "text/html; charset=utf-8"
      : /^assets\/[\w-]+\.js$/.test(file) ? "text/javascript; charset=utf-8"
        : /^assets\/[\w-]+\.css$/.test(file) ? "text/css; charset=utf-8" : null;
    if (!type) { response.writeHead(404); response.end("Not found"); return; }
    let body: Buffer;
    try {
      const path = await realpath(join(root, file));
      if (!path.startsWith(`${root}${sep}`)) throw new Error("Path outside build");
      body = await readFile(path);
    } catch { response.writeHead(404); response.end("Not found"); return; }
    response.writeHead(200, { "Content-Type": type, "Content-Length": body.length,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
    response.end(request.method === "HEAD" ? undefined : body);
  };
}
