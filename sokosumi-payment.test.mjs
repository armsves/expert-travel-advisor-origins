import assert from 'node:assert/strict';
import test from 'node:test';
import { describeEscrow, escrowFunded, lowestQuotedAmount, lowestUsdInText, masumiPaymentFrom, readEscrow, requestSokosumiPayment, resultHash, stayChargeUnits, submitPaymentResult } from './agent/sokosumi-payment.mjs';

test('charges the quoted stay total in tUSDM cents', () => {
  assert.equal(stayChargeUnits('104.31').toString(), '104310000');
});

test('uses the lowest dollar amount in a deployment reply', () => {
  assert.equal(lowestUsdInText('V Saigon Suites $90.00\nAlternative $102\nAnother 186 USD'), '90.00');
  assert.equal(lowestUsdInText('Which city should I search?'), '');
});

test('uses the lowest quoted stay when results are shown', () => {
  assert.equal(lowestQuotedAmount([
    { price: '$120' },
    { checkout: { total: { amount: '104.31', currency: 'USD' } }, price: '$103' },
  ]), '104.31');
});

test('asks the payment service for the stay total and keeps the Sokosumi charge', async () => {
  let body;
  const payment = await requestSokosumiPayment({
    taskId: 'task-1',
    amountUsd: '104.31',
    now: () => Date.parse('2026-10-07T00:00:00.000Z'),
    env: {
      NETWORK: 'Preprod',
      PAYMENT_SERVICE_URL: 'http://payment.example/api/v1',
      PAYMENT_API_KEY: 'seller-key',
      AGENT_IDENTIFIER: 'a'.repeat(57),
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://payment.example/api/v1/payment/');
      assert.equal(options.headers.token, 'seller-key');
      body = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            blockchainIdentifier: 'chain-1',
            agentIdentifier: 'a'.repeat(57),
            inputHash: body.inputHash,
            payByTime: '1770000000000',
            submitResultTime: '1770003600000',
            unlockTime: '1770007200000',
            externalDisputeUnlockTime: '1770010800000',
            RequestedFunds: body.RequestedFunds,
            SmartContractWallet: { walletVkey: 'b'.repeat(56) },
            PaymentSource: {
              network: 'Preprod',
              smartContractAddress: 'addr_test1example',
              policyId: 'c'.repeat(56),
            },
          },
        }),
      };
    },
  });
  assert.equal(body.agentIdentifier.endsWith('000000'), true);
  assert.equal(body.RequestedFunds[0].amount, '104310000');
  assert.equal(body.network, 'Preprod');
  assert.equal(body.paymentSourceType, 'Web3CardanoV2');
  assert.equal(body.supportedPaymentSourceIndex, 0);
  assert.equal(payment.blockchainIdentifier, 'chain-1');
  assert.equal(payment.sellerVkey, 'b'.repeat(56));
  assert.equal(payment.paymentSourceType, 'Web3CardanoV2');
  assert.equal(payment.supportedPaymentSourceIndex, 0);
  assert.equal(payment.Amounts[0].amount, '104310000');
  assert.equal(payment.PaymentSource.network, 'Preprod');
});

test('submits the delivered result hash to release escrow', async () => {
  let body;
  const outcome = await submitPaymentResult({
    blockchainIdentifier: 'chain-1',
    resultText: 'Itinerary ready',
    env: { PAYMENT_SERVICE_URL: 'http://payment.example/api/v1', PAYMENT_API_KEY: 'seller-key' },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://payment.example/api/v1/payment/submit-result');
      body = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    },
  });
  assert.equal(outcome.released, true);
  assert.equal(body.submitResultHash, resultHash('Itinerary ready'));
  assert.equal(body.network, 'Preprod');
});

test('shows the escrow payment and the lock transaction', async () => {
  const waiting = describeEscrow({ paymentId: 'pay-1', nextAction: 'WaitingForExternalAction' });
  assert.match(waiting, /Escrow payment pay-1/);
  assert.match(waiting, /waiting for the escrow lock/);
  const locked = await readEscrow({
    blockchainIdentifier: 'chain-1',
    env: { PAYMENT_SERVICE_URL: 'http://payment.example/api/v1', PAYMENT_API_KEY: 'seller-key' },
    fetchImpl: async (url, options) => {
      assert.match(url, /resolve-blockchain-identifier/);
      assert.equal(JSON.parse(options.body).includeHistory, 'true');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            id: 'pay-1',
            blockchainIdentifier: 'chain-1',
            onChainState: 'FundsLocked',
            RequestedFunds: [{ amount: '1000000' }],
            CurrentTransaction: { txHash: 'abc123' },
          },
        }),
      };
    },
  });
  assert.equal(locked.funded, true);
  assert.match(describeEscrow(locked), /Transaction: abc123/);
});

test('treats FundsLocked as the escrow payment', async () => {
  const funded = await escrowFunded({
    blockchainIdentifier: 'chain-1',
    env: { PAYMENT_SERVICE_URL: 'http://payment.example/api/v1', PAYMENT_API_KEY: 'seller-key' },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { blockchainIdentifier: 'chain-1', onChainState: 'FundsLocked' } }),
    }),
  });
  assert.equal(funded, true);
});

test('waits to release escrow until the payment is locked', async () => {
  const outcome = await submitPaymentResult({
    blockchainIdentifier: 'chain-1',
    resultText: 'Itinerary ready',
    env: { PAYMENT_SERVICE_URL: 'http://payment.example/api/v1', PAYMENT_API_KEY: 'seller-key' },
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  assert.equal(outcome.released, false);
});

test('rejects a payment response that cannot be charged', () => {
  assert.throws(() => masumiPaymentFrom({}, {
    identifierFromPurchaser: 'aa',
    inputHash: 'ab',
    amount: 1n,
    agentIdentifier: 'a'.repeat(57),
  }), /omitted/);
});
