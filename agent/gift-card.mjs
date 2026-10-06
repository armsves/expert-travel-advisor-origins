import { bitrefillTool } from './bitrefill-mcp.mjs';

const PRODUCT_ID = 'hotels_com-usa';
const ADA_ASSET = 'nep141:cardano.omft.near';
const BASE_USDC_ASSET = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const QUOTE_URL = 'https://1click.chaindefuser.com/v0/quote';

export function wantsGiftCard(text) {
  return /gift\s*card/i.test(String(text || ''));
}

export function quotedStayAmount(stay) {
  const total = stay?.checkout?.total || {};
  const currency = String(total.currency || 'USD').toUpperCase();
  if (total.amount != null && String(total.amount).trim() && currency === 'USD') return String(total.amount);
  const displayed = String(stay?.price || '').replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  return displayed ? displayed[1] : '';
}

export function parseGiftCardReply(text) {
  const source = String(text || '');
  const email = source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
  const refundAddress = source.match(/\baddr1[0-9a-z]{20,}\b/i)?.[0] || '';
  if (!email || !refundAddress) return null;
  return { email, refundAddress };
}

export function giftCardQuestion(stay) {
  const amount = quotedStayAmount(stay);
  return [
    `The Hotels.com gift card for ${stay?.name || 'the selected stay'} is quoted at ${amount} USD.`,
    'That quote is not purchased. The stay remains pay later with free cancellation.',
    'Reply yes to continue that stay, or no to stop.',
  ].join('\n');
}

export function quoteBody({ usdcAmount, recipient, refundAddress }) {
  return {
    dry: true,
    swapType: 'EXACT_OUTPUT',
    slippageTolerance: 100,
    originAsset: ADA_ASSET,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: BASE_USDC_ASSET,
    amount: toUnits(usdcAmount, 6),
    recipient,
    recipientType: 'DESTINATION_CHAIN',
    refundTo: refundAddress,
    refundType: 'ORIGIN_CHAIN',
    depositMode: 'SIMPLE',
    deadline: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
    referral: 'expert-travel-advisor',
  };
}

const DRY_RECIPIENT = '0x85F17Cf997934a597031b2E18a9aB6ebD4B9f6a4';
const DRY_REFUND = 'addr1v8wfpcg4qfhmnzprzysj6j9c53u5j56j8rvhyjp08s53s6g07rfjm';

export async function quoteHotelsGiftCard({ amount, stayName }) {
  const details = await bitrefillTool('get-product-details', { product_id: PRODUCT_ID, currency: 'USD' });
  const text = typeof details === 'string' ? details : JSON.stringify(details);
  const minimum = Number(text.match(/min:\s*(\d+(?:\.\d+)?)/)?.[1] || 10);
  const maximum = Number(text.match(/max:\s*(\d+(?:\.\d+)?)/)?.[1] || 500);
  const faceValue = Number(amount);
  if (!Number.isFinite(faceValue) || faceValue < minimum || faceValue > maximum) {
    throw new Error(`The quoted stay total ${amount} USD is outside the Hotels.com gift card range.`);
  }
  const quote = await requestQuote(quoteBody({
    usdcAmount: amount,
    recipient: DRY_RECIPIENT,
    refundAddress: DRY_REFUND,
  }));
  const adaIn = quote.quote?.amountIn || quote.amountIn;
  if (adaIn == null) throw new Error('NEAR Intents did not return an ADA quote.');
  if (quote.quote?.depositAddress || quote.depositAddress) {
    throw new Error('The gift card quote tried to open a deposit. It was stopped.');
  }
  return {
    productId: PRODUCT_ID,
    productName: 'Hotels.com USD',
    stayName: stayName || '',
    faceValue: String(amount),
    usdcAmount: String(amount),
    adaAmount: fromUnits(adaIn, 6),
    purchased: false,
  };
}

export function renderGiftCard(card) {
  return [
    `Hotels.com gift card quote for ${card.stayName || 'the quoted stay'}`,
    `Product: ${card.productName} (${card.productId})`,
    `Face value: ${card.faceValue} USD, the quoted stay total`,
    `Bitrefill price: ${card.usdcAmount} USD`,
    `NEAR Intents quote: ${card.adaAmount} ADA for ${card.usdcAmount} USDC on Base`,
    'Quote only. Bitrefill was not charged and no gift card was bought.',
    'The stay remains pay later with free cancellation.',
  ].join('\n');
}

async function requestQuote(body) {
  const headers = { 'content-type': 'application/json' };
  const apiKey = process.env.NEAR_INTENTS_API?.trim();
  if (apiKey) headers['x-api-key'] = apiKey;
  let response = await fetch(QUOTE_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  if (response.status === 401 && apiKey) {
    response = await fetch(QUOTE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `NEAR Intents quote failed with HTTP ${response.status}`);
  }
  return payload;
}

function toUnits(amount, decimals) {
  const [whole, fraction = ''] = String(amount).trim().split('.');
  const padded = `${fraction}${'0'.repeat(decimals)}`.slice(0, decimals);
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0')).toString();
}

function fromUnits(amount, decimals) {
  const value = BigInt(amount);
  const base = 10n ** BigInt(decimals);
  const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${value / base}.${fraction}` : `${value / base}`;
}
