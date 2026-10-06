import { HotelsError, briefFromText } from './hotels-search.mjs';

export function inspectRequest(text) {
  try {
    const brief = briefFromText(text);
    return { brief: { ...brief, action: 'search' } };
  } catch (error) {
    if (error instanceof HotelsError) return { question: error.message };
    throw error;
  }
}

export function choiceQuestion(payload) {
  const stays = payload.stays || [];
  const lines = [
    `I found ${stays.length} pay-later, free-cancellation stay${stays.length === 1 ? '' : 's'} in ${payload.destination}.`,
    `Dates: ${payload.check_in} to ${payload.check_out}. Adults: ${payload.adults || 2}.`,
    '',
  ];
  stays.forEach((stay, index) => {
    lines.push(`${index + 1}. ${stay.name}, ${stay.price}, free cancellation ${stay.free_cancellation}`);
  });
  lines.push('', 'These rates opened a Hotels.com checkout. Reply with the number you want. I will ask for a final yes before sending the checkout link.');
  lines.push('A Hotels.com gift card for the stay you pick is quoted only. The stay remains pay later with free cancellation.');
  return lines.join('\n');
}

export function confirmationQuestion(stay, brief, giftQuote) {
  const lines = [
    `Final confirmation: ${stay.name} at ${stay.price} for ${brief.check_in} to ${brief.check_out}, ${brief.adults} adults, pay later, free cancellation.`,
  ];
  if (giftQuote) lines.push('', giftQuote);
  lines.push('', 'Reply yes to continue this pay-later stay. Reply no to stop. The gift card is not purchased.');
  return lines.join('\n');
}

export function chooseStay(reply, stays) {
  const text = String(reply || '').trim();
  const numbered = text.match(/^\s*(\d+)\b/);
  if (numbered) {
    const index = Number(numbered[1]) - 1;
    if (index >= 0 && index < stays.length) return stays[index];
  }
  const byId = stays.find((stay) => text.includes(stay.property_id));
  if (byId) return byId;
  const lowered = text.toLowerCase();
  return stays.find((stay) => stay.name && lowered.includes(stay.name.toLowerCase())) || null;
}

export function replyIntent(reply) {
  const text = String(reply || '').trim();
  if (/^(yes|y|confirm|book it|book this)\b/i.test(text)) return 'confirm';
  if (/^(no|n|cancel|stop|don't|do not)\b/i.test(text)) return 'decline';
  return 'other';
}
