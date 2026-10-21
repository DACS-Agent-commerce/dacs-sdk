// Exact DEM (9 decimals) for a whole, non-negative OS amount; null for anything
// else, so a bad input drops the funding block instead of the refusal.
const whole = (os) => (typeof os === 'bigint' ? os : /^\d+$/.test(String(os)) ? BigInt(os) : -1n);
const dem = (os) => {
  const value = whole(os);
  if (value < 0n) return null;
  const fraction = (value % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${value / 1_000_000_000n}${fraction ? `.${fraction}` : ''}`;
};

// The end of every funding message: the configured page and the buyer's address.
// The model's copy (seller-content.mjs modelBuyerFunding) ends the same way.
export const fundingHelpSentence = (help) => (help ? `; get testnet DEM at ${help.url} and paste your buyer address ${help.buyerAddress}.` : '.');

export function buyerFundingError(error, { wallet, price, config, network }) {
  const amounts = error.code === 'buyer_balance_insufficient' ? error.details : null;
  const funding = {
    currency: 'DEM', network, priceDem: dem(price.amountOs),
    balance: amounts ? 'known' : 'unknown',
    ...(amounts ? {
      buyerFeesDem: dem(amounts.buyerFeesOs), requiredDem: dem(amounts.requiredOs), balanceDem: dem(amounts.balanceOs),
      shortfallDem: dem(whole(amounts.requiredOs) - whole(amounts.balanceOs)),
    } : {}),
    // The buyer's address is shown only with the configured funding page.
    ...(config.fundingHelpUrl && ['demos-testnet', 'demos-devnet'].includes(network) ? { help: { url: config.fundingHelpUrl, buyerAddress: wallet } } : {}),
  };
  // Main's refusal is thrown either way; only exact amounts get a funding block.
  if (Object.values(funding).includes(null)) return error;
  funding.message = amounts
    ? `The purchase needs ${funding.requiredDem} DEM (${funding.priceDem} DEM price + ${funding.buyerFeesDem} DEM buyer fee reserve); your balance is ${funding.balanceDem} DEM and your shortfall is ${funding.shortfallDem} DEM`
    : `Your buyer balance is unknown; the price is ${funding.priceDem} DEM and the balance or buyer fee reserve could not be read exactly`;
  funding.message += fundingHelpSentence(funding.help);
  error.buyerFunding = funding;
  return error;
}
