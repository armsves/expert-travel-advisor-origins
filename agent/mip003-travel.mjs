import { choiceQuestion, chooseStay, confirmationQuestion, inspectRequest } from './follow-up.mjs';
import { quoteHotelsGiftCard, quotedStayAmount, renderGiftCard } from './gift-card.mjs';
import { renderResult, searchStay } from './hotels-search.mjs';

export async function advanceTravelJob(job) {
  const request = String(job.inputData?.request || '');
  const reply = job.pendingInput || {};
  if (!job.brief) {
    const extra = typeof reply.request === 'string' ? `${request}\n${reply.request}` : request;
    const inspected = inspectRequest(extra);
    if (inspected.question) {
      return {
        status: 'awaiting_input',
        inputData: { ...job.inputData, request: extra },
        inputSchema: {
          input_data: [
            {
              id: 'request',
              type: 'string',
              name: 'Stay details',
              data: { description: inspected.question },
              validations: [{ validation: 'min', value: '1' }],
            },
          ],
        },
      };
    }
    const found = searchStay({ ...inspected.brief, action: 'bookable', property_id: '' });
    const stays = found.bookable || [];
    if (!stays.length) {
      return { status: 'failed', result: 'Hotels.com returned no pay-later stay with free cancellation.', inputSchema: null };
    }
    return {
      status: 'awaiting_input',
      brief: inspected.brief,
      stays,
      search: found,
      inputSchema: staySchema(choiceQuestion({ ...found, stays, adults: inspected.brief.adults })),
    };
  }
  if (!job.selected) {
    const stay = chooseStay(String(reply.stay || ''), job.stays || []);
    if (!stay) {
      return { status: 'awaiting_input', inputSchema: staySchema('Reply with one of the stay numbers.') };
    }
    const amount = quotedStayAmount(stay);
    let quote = '';
    if (amount) {
      try {
        quote = renderGiftCard(await quoteHotelsGiftCard({ amount, stayName: stay.name }));
      } catch (error) {
        quote = `The gift card quote failed. ${error instanceof Error ? error.message : 'Quote failed'}\nThe stay remains pay later with free cancellation.`;
      }
    }
    return {
      status: 'awaiting_input',
      selected: stay,
      giftQuote: quote,
      inputSchema: {
        input_data: [
          {
            id: 'confirm',
            type: 'boolean',
            name: 'Continue this pay-later stay',
            data: { description: confirmationQuestion(stay, job.brief, quote) },
          },
        ],
      },
    };
  }
  if (reply.confirm !== true) {
    return { status: 'completed', result: 'The stay was not confirmed. No reservation was made and the gift card was not purchased.', inputSchema: null };
  }
  const summary = renderResult({ ...job.search, stays: [job.selected], checkout: job.selected.checkout, action: 'checkout' });
  const quote = job.giftQuote ? `\n\n${job.giftQuote}` : '';
  return {
    status: 'completed',
    inputSchema: null,
    result: `${summary}${quote}\n\nYou confirmed the stay. It remains pay later with free cancellation. No card was charged, and the gift card was quoted only.`,
  };
}

function staySchema(description) {
  return {
    input_data: [
      {
        id: 'stay',
        type: 'string',
        name: 'Stay number',
        data: { description },
        validations: [{ validation: 'min', value: '1' }],
      },
    ],
  };
}
