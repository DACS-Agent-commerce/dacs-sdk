import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  DACS_UCP_X402_HANDLER,
  UCP_MVP_VERSION,
  type UcpBusinessProfile,
  type UcpCheckout,
  type UcpCompleteCheckoutRequest,
  type UcpOrder,
} from "../../src/index.js";

interface LiveUcpMerchantConfig {
  paywallUrl: string;
  network: `eip155:${number}`;
  token: `0x${string}`;
  tokenSymbol: string;
  tokenDecimals: number;
  payTo: `0x${string}`;
  checkoutMinorAmount: number;
  finalityBlocks: number;
  merchantPublicKey: string;
}

export interface RunningLiveUcpMerchant {
  profileUrl: string;
  checkoutId: string;
  orderId: string;
  calls: Readonly<{ create: () => number; complete: () => number }>;
  close(): Promise<void>;
}

async function jsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 1_048_576) throw new Error("live UCP request exceeds 1 MiB");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

/** Local standards-shaped UCP merchant used only by the funded integration gate. */
export async function startLiveUcpMerchant(
  cfg: LiveUcpMerchantConfig,
): Promise<RunningLiveUcpMerchant> {
  const checkoutId = "ucp-live-checkout-1";
  const orderId = "ucp-live-order-1";
  let baseUrl = "";
  let createCalls = 0;
  let completeCalls = 0;

  const paymentHandlers = () => ({
    [DACS_UCP_X402_HANDLER]: [{
      id: "dacs-live-x402",
      version: UCP_MVP_VERSION,
      config: {
        railId: "x402:default",
        network: cfg.network,
        checkoutCurrency: "USD",
        checkoutCurrencyDecimals: 2,
        assetAmountPerCheckoutUnit: "1",
        asset: cfg.token,
        assetSymbol: cfg.tokenSymbol,
        assetDecimals: cfg.tokenDecimals,
        payTo: cfg.payTo,
        resource: cfg.paywallUrl,
        finalityBlocks: cfg.finalityBlocks,
      },
    }],
  });

  const checkout = (completed: boolean): UcpCheckout => ({
    ucp: { version: UCP_MVP_VERSION, payment_handlers: paymentHandlers() },
    id: checkoutId,
    line_items: [{
      id: "line-live-1",
      item: {
        id: "dacs-ucp-live-item",
        title: "DACS UCP live integration item",
        price: cfg.checkoutMinorAmount,
      },
      quantity: 1,
      totals: [
        { type: "subtotal", amount: cfg.checkoutMinorAmount },
        { type: "total", amount: cfg.checkoutMinorAmount },
      ],
    }],
    status: completed ? "completed" : "ready_for_complete",
    currency: "USD",
    totals: [
      { type: "subtotal", amount: cfg.checkoutMinorAmount },
      { type: "total", amount: cfg.checkoutMinorAmount },
    ],
    links: [],
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    ...(completed
      ? { order: { id: orderId, permalink_url: `${baseUrl}/orders/${orderId}` } }
      : {}),
  });

  const order = (): UcpOrder => {
    const completed = checkout(true);
    return {
      ucp: { version: UCP_MVP_VERSION },
      id: orderId,
      checkout_id: checkoutId,
      permalink_url: `${baseUrl}/orders/${orderId}`,
      line_items: completed.line_items,
      fulfillment: {
        events: [{ type: "processing", occurred_at: new Date().toISOString() }],
      },
      currency: completed.currency,
      totals: completed.totals,
    };
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/.well-known/ucp") {
        const profile: UcpBusinessProfile = {
          ucp: {
            version: UCP_MVP_VERSION,
            services: {
              "dev.ucp.shopping": [{
                version: UCP_MVP_VERSION,
                transport: "rest",
                endpoint: `${baseUrl}/ucp`,
              }],
            },
            capabilities: {
              "dev.ucp.shopping.checkout": [{ version: UCP_MVP_VERSION }],
            },
            payment_handlers: paymentHandlers(),
          },
          keys: [{
            kid: "merchant-live-ed25519",
            kty: "OKP",
            crv: "Ed25519",
            x: cfg.merchantPublicKey,
          }],
        };
        send(res, 200, profile);
        return;
      }
      if (
        req.method === "POST" &&
        url.pathname === "/ucp/checkout-sessions"
      ) {
        if (!req.headers["idempotency-key"] || !req.headers["ucp-agent"]) {
          send(res, 400, { error: "missing UCP headers" });
          return;
        }
        const body = await jsonBody(req) as { line_items?: unknown[] };
        if (body.line_items?.length !== 1) {
          send(res, 400, { error: "expected one line item" });
          return;
        }
        createCalls += 1;
        send(res, 200, checkout(false));
        return;
      }
      if (
        req.method === "POST" &&
        url.pathname === `/ucp/checkout-sessions/${checkoutId}/complete`
      ) {
        const body = await jsonBody(req) as UcpCompleteCheckoutRequest;
        const credential = body.payment?.instruments?.[0]?.credential;
        if (
          !req.headers["idempotency-key"] ||
          body.payment?.instruments?.[0]?.type !== DACS_UCP_X402_HANDLER ||
          credential?.type !== "x402" ||
          credential.settlement_tx_hash === undefined ||
          credential.payment_receipt_hash === undefined ||
          credential.checkout_binding_hash === undefined
        ) {
          send(res, 400, { error: "invalid DACS x402 completion credential" });
          return;
        }
        completeCalls += 1;
        send(res, 200, checkout(true));
        return;
      }
      if (req.method === "GET" && url.pathname === `/ucp/orders/${orderId}`) {
        send(res, 200, order());
        return;
      }
      send(res, 404, { error: "not found" });
    })().catch((error: unknown) => {
      send(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("local UCP merchant did not acquire a TCP port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    profileUrl: `${baseUrl}/.well-known/ucp`,
    checkoutId,
    orderId,
    calls: {
      create: () => createCalls,
      complete: () => completeCalls,
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
