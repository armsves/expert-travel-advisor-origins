import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export class HotelsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HotelsError';
  }
}

export function searchStay(input) {
  const python = pythonBin();
  const child = spawnSync(python, ['agent/hotels_cli.py'], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
  });
  if (child.error) throw new HotelsError(child.error.message);
  if (child.status !== 0 && !child.stdout) {
    throw new HotelsError((child.stderr || 'Hotels.com search failed').trim().slice(0, 300));
  }
  let payload;
  try {
    payload = JSON.parse(child.stdout || '');
  } catch {
    throw new HotelsError('The Hotels.com result was not readable.');
  }
  if (payload.status === 'failed') throw new HotelsError(payload.message || 'Hotels.com search failed');
  return payload;
}

export function briefFromText(text) {
  const stripped = String(text || '').trim();
  if (!stripped) throw new HotelsError('The task needs a city and check-in and check-out dates');
  if (stripped.startsWith('{')) {
    const payload = JSON.parse(stripped);
    if (payload && typeof payload === 'object') return payload;
  }
  const dates = stripped.match(/\b20\d{2}-\d{2}-\d{2}\b/g) || [];
  if (dates.length < 2) throw new HotelsError('The task needs check-in and check-out as YYYY-MM-DD');
  const destination = destinationFromText(stripped);
  if (!destination) throw new HotelsError('The task needs a city, for example: in Manila');
  const lowered = stripped.toLowerCase();
  const reserve = ['reserv', 'book', 'checkout'].some((word) => lowered.includes(word));
  const adults = stripped.match(/\b(\d+)\s+adults?\b/i);
  const property = stripped.match(/\bproperty(?:\s+id)?\s*[:=]?\s*(\d{5,})\b/i);
  return {
    destination,
    check_in: dates[0],
    check_out: dates[1],
    adults: adults ? adults[1] : '2',
    payment_type: 'PAY_LATER',
    lodging: lowered.includes('apart') ? 'APART_HOTEL' : '',
    action: reserve ? 'checkout' : 'search',
    property_id: property ? property[1] : '',
  };
}

export function renderResult(payload) {
  if (payload.status === 'failed') return `Could not complete the stay request. ${payload.message || ''}`.trim();
  const lines = [
    `Destination: ${payload.destination}`,
    `Stay: ${payload.check_in} to ${payload.check_out}`,
    `Payment: ${payload.payment_type}`,
  ];
  if (payload.heading) lines.push(String(payload.heading));
  lines.push('Free-cancellation matches:');
  for (const stay of payload.stays || []) {
    lines.push(`- ${stay.name} (${stay.property_id}), ${stay.price}, free cancellation ${stay.free_cancellation}`);
    if (stay.url) lines.push(`  ${stay.url}`);
  }
  const checkout = payload.checkout || {};
  if (checkout && Object.keys(checkout).length) {
    const total = checkout.total || {};
    lines.push(
      'Reservation checkout:',
      `- Property: ${checkout.name}`,
      `- Total: ${total.amount ?? ''} ${total.currency ?? ''}`.trim(),
      `- Checkout URL: ${checkout.checkout_url}`,
    );
    if (checkout.failure_reason) lines.push(`- Checkout was not opened: ${checkout.failure_reason}`);
  } else if (payload.checkout_error) {
    lines.push(`Checkout was not opened: ${payload.checkout_error}`);
  } else if (payload.action === 'search') {
    lines.push('Search only. Ask to reserve a property to open checkout.');
  }
  return lines.join('\n');
}

function pythonBin() {
  const configured = process.env.HOTELS_PYTHON?.trim();
  if (configured) return configured;
  if (existsSync('.venv/bin/python')) return '.venv/bin/python';
  return 'python3';
}

function destinationFromText(text) {
  const match = text.match(/\b(?:in|for)\s+([A-Za-z][A-Za-z .'-]{1,60}?)(?:\s+from|\s+for|\s+on|,|\.|$)/i);
  if (!match) return '';
  return match[1].trim().replace(/\s+(from|for|on)\b[\s\S]*$/i, '').trim();
}
