import { createHash, randomBytes } from 'node:crypto';
import { quotedStayAmount } from './gift-card.mjs';
import { EXPERT_TRAVEL_ADVISOR } from './expert-travel-advisor.mjs';

const PREPROD_USDM = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
const MINUTE = 60 * 1000;

export function lowestUsdInText(text) {
  const amounts = [];
  const pattern = /\$\s*(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)|\b(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)\s*USD\b/gi;
  for (const match of String(text || '').matchAll(pattern)) {
    amounts.push((match[1] || match[2]).replaceAll(',', ''));
  }
  return amounts.length ? lowestQuotedAmount(amounts.map((amount) => ({ price: `$${amount}` }))) : '';
}

export function lowestQuotedAmount(stays) {
  let lowest = '';
  let lowestUnits = null;
  for (const stay of stays || []) {
    const amount = quotedStayAmount(stay);
    if (!amount) continue;
    const units = stayChargeUnits(amount);
    if (lowestUnits === null || units < lowestUnits) {
      lowest = amount;
      lowestUnits = units;
    }
  }
  if (!lowest) throw new Error('The results have no quoted USD total to charge');
  return lowest;
}

export function stayChargeUnits(amountUsd) {
  const match = String(amountUsd || '').trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error('The stay has no quoted USD total to charge');
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
  if (cents <= 0n) throw new Error('The stay has no quoted USD total to charge');
  return cents * 10000n;
}

export function resultHash(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

export function masumiPaymentFrom(data, sent) {
  const source = data?.PaymentSource;
  const sellerVkey = data?.SmartContractWallet?.walletVkey || data?.sellerVkey || '';
  const paymentSourceType = source?.paymentSourceType || sent.paymentSourceType || 'Web3CardanoV2';
  const payment = {
    blockchainIdentifier: String(data?.blockchainIdentifier || ''),
    identifierFromPurchaser: String(data?.identifierFromPurchaser || sent.identifierFromPurchaser),
    agentIdentifier: String(data?.agentIdentifier || sent.agentIdentifier).toLowerCase(),
    sellerVkey: String(sellerVkey).toLowerCase(),
    submitResultTime: timestamp(data?.submitResultTime),
    payByTime: timestamp(data?.payByTime),
    unlockTime: timestamp(data?.unlockTime),
    externalDisputeUnlockTime: timestamp(data?.externalDisputeUnlockTime),
    inputHash: String(data?.inputHash || sent.inputHash).toLowerCase(),
    paymentSourceType,
    supportedPaymentSourceIndex: Number(sent.supportedPaymentSourceIndex ?? 0),
    Amounts: funds(data?.RequestedFunds, sent.amount),
  };
  if (source?.network === 'Preprod' && source.smartContractAddress && source.policyId) {
    payment.PaymentSource = {
      network: 'Preprod',
      smartContractAddress: String(source.smartContractAddress).toLowerCase(),
      policyId: String(source.policyId).toLowerCase(),
    };
  }
  const missing = ['blockchainIdentifier', 'sellerVkey', 'payByTime', 'submitResultTime', 'unlockTime', 'externalDisputeUnlockTime', 'PaymentSource']
    .filter((key) => !payment[key]);
  if (paymentSourceType !== 'Web3CardanoV2') missing.push('paymentSourceType');
  if (missing.length) throw new Error(`The payment service omitted ${missing.join(', ')}`);
  return payment;
}

export async function requestSokosumiPayment({ taskId, amountUsd, purpose = 'booking', env = process.env, fetchImpl = fetch, now = () => Date.now() }) {
  if (String(env.NETWORK || 'Preprod') !== 'Preprod') throw new Error('Payments stay on Preprod');
  const base = String(env.PAYMENT_SERVICE_URL || '').replace(/\/$/, '');
  const token = String(env.PAYMENT_API_KEY || '').trim();
  const agentIdentifier = EXPERT_TRAVEL_ADVISOR;
  const missing = [
    ['PAYMENT_SERVICE_URL', base],
    ['PAYMENT_API_KEY', token],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required before Sokosumi can pay`);
  const amount = stayChargeUnits(amountUsd);
  const started = now();
  const sent = {
    agentIdentifier,
    identifierFromPurchaser: randomBytes(8).toString('hex'),
    inputHash: createHash('sha256').update(`task:${taskId}:${purpose}`).digest('hex'),
    amount,
    paymentSourceType: 'Web3CardanoV2',
    supportedPaymentSourceIndex: Number(env.SUPPORTED_PAYMENT_SOURCE_INDEX || 0),
  };
  const response = await fetchImpl(`${base}/payment/`, {
    method: 'POST',
    headers: { token, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      agentIdentifier,
      network: 'Preprod',
      inputHash: sent.inputHash,
      identifierFromPurchaser: sent.identifierFromPurchaser,
      paymentSourceType: sent.paymentSourceType,
      supportedPaymentSourceIndex: sent.supportedPaymentSourceIndex,
      payByTime: new Date(started + 30 * MINUTE).toISOString(),
      submitResultTime: new Date(started + 40 * MINUTE).toISOString(),
      unlockTime: new Date(started + 55 * MINUTE).toISOString(),
      externalDisputeUnlockTime: new Date(started + 70 * MINUTE).toISOString(),
      RequestedFunds: [{ amount: amount.toString(), unit: PREPROD_USDM }],
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `Payment request failed with HTTP ${response.status}`;
    throw new Error(String(message).slice(0, 240));
  }
  const payment = masumiPaymentFrom(payload.data || payload, sent);
  return { ...payment, ...escrowFields(payload.data || payload) };
}

function formatTusdm(raw) {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) return '';
  const value = BigInt(text);
  const whole = value / 1000000n;
  const fraction = (value % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction} tUSDM` : `${whole} tUSDM`;
}

export function describeEscrow(escrow) {
  const state = escrow?.onChainState || escrow?.nextAction || 'waiting for the buyer to lock funds';
  const amount = formatTusdm(escrow?.amount);
  const lines = [
    `Escrow payment ${escrow?.paymentId || 'pending'} for Expert Travel Advisor.`,
    amount ? `Amount: ${amount}.` : undefined,
    `State: ${state}.`,
  ].filter(Boolean);
  lines.push(escrow?.txHash ? `Transaction: ${escrow.txHash}` : 'Transaction: waiting for the escrow lock.');
  return lines.join('\n');
}

export async function readEscrow({ blockchainIdentifier, env = process.env, fetchImpl = fetch }) {
  const base = String(env.PAYMENT_SERVICE_URL || '').replace(/\/$/, '');
  const token = String(env.PAYMENT_API_KEY || '').trim();
  if (!base || !token || !blockchainIdentifier) return { funded: false, paymentId: '', onChainState: '', nextAction: '', txHash: '', amount: '' };
  const response = await fetchImpl(`${base}/payment/resolve-blockchain-identifier`, {
    method: 'POST',
    headers: { token, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ network: 'Preprod', blockchainIdentifier, includeHistory: 'true' }),
  });
  if (!response.ok) return { funded: false, paymentId: '', onChainState: '', nextAction: '', txHash: '', amount: '' };
  const payload = await response.json().catch(() => ({}));
  const match = payload?.data || payload || {};
  const escrow = escrowFields(match);
  return { ...escrow, funded: escrow.onChainState === 'FundsLocked' };
}

export async function escrowFunded(options) {
  const escrow = await readEscrow(options);
  return escrow.funded;
}

function escrowFields(data) {
  const history = Array.isArray(data?.TransactionHistory) ? data.TransactionHistory : [];
  const txHash = data?.CurrentTransaction?.txHash || history.find((item) => item?.txHash)?.txHash || '';
  return {
    paymentId: String(data?.id || ''),
    onChainState: String(data?.onChainState || ''),
    nextAction: String(data?.NextAction?.requestedAction || ''),
    txHash: String(txHash || ''),
    amount: String(data?.RequestedFunds?.[0]?.amount || ''),
  };
}

export async function submitPaymentResult({ blockchainIdentifier, resultText, env = process.env, fetchImpl = fetch }) {
  const base = String(env.PAYMENT_SERVICE_URL || '').replace(/\/$/, '');
  const token = String(env.PAYMENT_API_KEY || '').trim();
  if (!base || !token) throw new Error('PAYMENT_SERVICE_URL and PAYMENT_API_KEY are required before the escrow can be released');
  const response = await fetchImpl(`${base}/payment/submit-result`, {
    method: 'POST',
    headers: { token, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      network: 'Preprod',
      blockchainIdentifier,
      submitResultHash: resultHash(resultText),
    }),
  });
  if (response.status === 404) return { released: false };
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `Result submission failed with HTTP ${response.status}`;
    throw new Error(String(message).slice(0, 240));
  }
  return { released: true };
}

function funds(value, amount) {
  const list = Array.isArray(value) && value.length ? value : [{ amount: amount.toString(), unit: PREPROD_USDM }];
  return list.map((item) => ({ amount: String(item.amount), unit: String(item.unit ?? '') }));
}

function timestamp(value) {
  const text = String(value || '').trim();
  if (/^\d+$/.test(text)) return String(BigInt(text));
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? '' : String(parsed);
}
