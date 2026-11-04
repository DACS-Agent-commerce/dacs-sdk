// Test-only npm registry on the loopback interface. It accepts a publish request
// (PUT /<package>), records the request headers, and with `requiredToken` answers
// 401 unless the request carries that bearer token.
import { createServer } from "node:http";

/** Starts the registry; resolves to { url, requests, close }. `requests` holds one { method, path, headers } per request. */
export async function startLoopbackNpmRegistry({ requiredToken } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url, headers: request.headers });
    request.resume();
    request.on("end", () => {
      const authorized = requiredToken === undefined || request.headers.authorization === `Bearer ${requiredToken}`;
      response.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
      response.end(JSON.stringify(authorized ? { ok: true } : { error: "authentication required" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
