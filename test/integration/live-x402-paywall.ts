import { createServer, type IncomingMessage, type Server } from "node:http";

import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type HTTPAdapter,
} from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

interface Config {
  network: `${string}:${string}`;
  payTo: string;
  asset: string;
  amount: string;
  facilitatorUrl: string;
}

export interface RunningPaywall {
  url: string;
  close(): Promise<void>;
}

function adapterFor(req: IncomingMessage, url: URL): HTTPAdapter {
  return {
    getHeader: (name) => req.headers[name.toLowerCase()] as string | undefined,
    getMethod: () => req.method ?? "GET",
    getPath: () => url.pathname,
    getUrl: () => url.toString(),
    getAcceptHeader: () => (req.headers.accept as string) ?? "*/*",
    getUserAgent: () => (req.headers["user-agent"] as string) ?? "",
    getQueryParams: () => Object.fromEntries(url.searchParams.entries()),
    getQueryParam: (name) => url.searchParams.get(name) ?? undefined,
  };
}

export async function startLiveX402Paywall(cfg: Config): Promise<RunningPaywall> {
  const route = "/live-e2e";
  const routePattern = `GET ${route}`;
  const facilitator = new HTTPFacilitatorClient({ url: cfg.facilitatorUrl });
  const core = new x402ResourceServer(facilitator).register(
    cfg.network,
    new ExactEvmScheme(),
  );
  const resource = new x402HTTPResourceServer(core, {
    [routePattern]: {
      accepts: {
        scheme: "exact",
        network: cfg.network,
        payTo: cfg.payTo,
        price: { amount: cfg.amount, asset: cfg.asset },
        maxTimeoutSeconds: 120,
        extra: { name: "USDC", version: "2" },
      },
      description: "DACS SDK live E2E",
      mimeType: "application/json",
    },
  });
  await resource.initialize();

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== route) {
        res.writeHead(404).end();
        return;
      }
      const context = {
        adapter: adapterFor(req, url),
        path: url.pathname,
        method: req.method ?? "GET",
        paymentHeader: req.headers["x-payment"] as string | undefined,
        routePattern,
      };
      const result = await resource.processHTTPRequest(context);
      if (result.type === "payment-error") {
        const { status, headers, body } = result.response;
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(typeof body === "string" ? body : JSON.stringify(body ?? {}));
        return;
      }
      if (result.type === "no-payment-required") {
        res.writeHead(500).end(JSON.stringify({ error: "route is not protected" }));
        return;
      }
      const settled = await resource.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions,
        { request: context },
      );
      if (!settled.success) {
        console.error("LIVE x402 facilitator rejected settlement", {
          errorReason: settled.errorReason,
          errorMessage: settled.errorMessage,
        });
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: settled.errorReason }));
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        ...(settled.headers ?? {}),
      });
      res.end(JSON.stringify({ ok: true }));
    })().catch((error: unknown) => {
      console.error("LIVE x402 paywall request failed", {
        name: error instanceof Error ? error.name : "unknown",
        message: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: (error as Error).message }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("local x402 paywall did not acquire a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}${route}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
