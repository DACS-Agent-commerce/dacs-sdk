import {
  createDacsFixedPricePayDemBuyerLiveV1,
  type DacsFixedPricePayDemBuyerLiveOptionsV1,
} from "./fixedPricePayDemBuyerLive.js";
import {
  createDacsFixedPricePayDemSellerLiveV1,
  type DacsFixedPricePayDemSellerLiveOptionsV1,
} from "./fixedPricePayDemSellerLive.js";
import {
  createDacsFixedPriceX402BuyerLiveV1,
  type DacsFixedPriceX402BuyerLiveOptionsV1,
} from "./fixedPriceX402BuyerLive.js";
import {
  createDacsFixedPriceX402SellerLiveV1,
  type DacsFixedPriceX402SellerLiveOptionsV1,
} from "./fixedPriceX402SellerLive.js";
import {
  createDacsMultirailLiveCommerceGraphV1,
  type DacsMultirailLiveCommerceGraphV1,
} from "./multirailCommerceGraph.js";

export interface DacsFixedPriceMultirailBuyerLiveOptionsV1 {
  x402: Readonly<DacsFixedPriceX402BuyerLiveOptionsV1>;
  payDem: Readonly<DacsFixedPricePayDemBuyerLiveOptionsV1>;
}

export interface DacsFixedPriceMultirailSellerLiveOptionsV1 {
  x402: Readonly<DacsFixedPriceX402SellerLiveOptionsV1>;
  payDem: Readonly<DacsFixedPricePayDemSellerLiveOptionsV1>;
}

function sameActor(
  left: Readonly<{ context: object; workerId: string }>,
  right: Readonly<{ context: object; workerId: string }>,
): boolean {
  return left.context === right.context && left.workerId === right.workerId;
}

/** Build both buyer rails concurrently, then join them without fallback. */
export async function createDacsFixedPriceMultirailBuyerLiveV1(
  options: Readonly<DacsFixedPriceMultirailBuyerLiveOptionsV1>,
): Promise<Readonly<DacsMultirailLiveCommerceGraphV1>> {
  if (options === null || typeof options !== "object" ||
      !sameActor(options.x402, options.payDem)) {
    throw new TypeError("fixed-price multirail buyer options are actor-incompatible");
  }
  const [x402, payDem] = await Promise.all([
    createDacsFixedPriceX402BuyerLiveV1(options.x402),
    createDacsFixedPricePayDemBuyerLiveV1(options.payDem),
  ]);
  return createDacsMultirailLiveCommerceGraphV1({ role: "buyer", x402, payDem });
}

/** Build both seller rails concurrently, then join them without fallback. */
export async function createDacsFixedPriceMultirailSellerLiveV1(
  options: Readonly<DacsFixedPriceMultirailSellerLiveOptionsV1>,
): Promise<Readonly<DacsMultirailLiveCommerceGraphV1>> {
  if (options === null || typeof options !== "object" ||
      !sameActor(options.x402, options.payDem)) {
    throw new TypeError("fixed-price multirail seller options are actor-incompatible");
  }
  const [x402, payDem] = await Promise.all([
    createDacsFixedPriceX402SellerLiveV1(options.x402),
    createDacsFixedPricePayDemSellerLiveV1(options.payDem),
  ]);
  return createDacsMultirailLiveCommerceGraphV1({ role: "seller", x402, payDem });
}
