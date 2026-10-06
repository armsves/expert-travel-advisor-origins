import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGiftCardReply, quoteBody, quotedStayAmount, wantsGiftCard } from './agent/gift-card.mjs';

test('recognizes a gift card request and ignores a typed amount', () => {
  assert.equal(wantsGiftCard('buy a hotels.com gift card'), true);
  assert.equal(wantsGiftCard('book a stay in Manila'), false);
  const parsed = parseGiftCardReply('500 guest@example.com addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer');
  assert.equal(parsed.amount, undefined);
  assert.equal(parsed.email, 'guest@example.com');
  assert.match(parsed.refundAddress, /^addr1/);
  assert.equal(parseGiftCardReply('gift card'), null);
});

test('uses the quoted stay total instead of the displayed price', () => {
  const stay = { name: 'BGC McKinley', price: '$103', checkout: { total: { amount: 104.31, currency: 'USD' } } };
  assert.equal(quotedStayAmount(stay), '104.31');
  assert.equal(quotedStayAmount({ price: '$77' }), '77');
});

test('quotes an exact Base USDC output paid from ADA', () => {
  const body = quoteBody({
    usdcAmount: '100.5',
    recipient: '0x1111111111111111111111111111111111111111',
    refundAddress: 'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer',
  });
  assert.equal(body.swapType, 'EXACT_OUTPUT');
  assert.equal(body.originAsset, 'nep141:cardano.omft.near');
  assert.equal(body.destinationAsset, 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near');
  assert.equal(body.amount, '100500000');
  assert.equal(body.depositType, 'ORIGIN_CHAIN');
  assert.equal(body.recipientType, 'DESTINATION_CHAIN');
  assert.equal(body.dry, true);
});
