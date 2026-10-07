import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { consult } from './client.mjs';
import { acquireWorkerLock } from './worker-lock.mjs';
import { chooseStay, confirmationQuestion, inspectRequest, replyIntent } from './agent/follow-up.mjs';
import { quoteHotelsGiftCard, quotedStayAmount, renderGiftCard, wantsGiftCard } from './agent/gift-card.mjs';
import { describeEscrow, lowestQuotedAmount, lowestUsdInText, readEscrow, requestSokosumiPayment, submitPaymentResult } from './agent/sokosumi-payment.mjs';
import { bookReservation, HotelsError, renderResult, reservationResult, searchStay } from './agent/hotels-search.mjs';

const id = process.env.COWORKER_ID?.trim();
if (!id) throw new Error('COWORKER_ID is missing. Add it to .env.');
const organizationSlug = process.env.SOKOSUMI_ORGANIZATION_SLUG?.trim();
const organizationId = process.env.SOKOSUMI_ORGANIZATION_ID?.trim();
if (Boolean(organizationSlug) !== Boolean(organizationId)) {
  throw new Error('Set both SOKOSUMI_ORGANIZATION_SLUG and SOKOSUMI_ORGANIZATION_ID, or neither.');
}

mkdirSync('.local', { recursive: true, mode: 0o700 });
const releaseLock = acquireWorkerLock();
process.once('exit', releaseLock);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    releaseLock();
    process.exit(0);
  });
}

function scopeArgs() {
  return organizationId ? ['--organization-id', organizationId] : ['--personal'];
}

function orgFlag() {
  return organizationSlug ? ['--organization-slug', organizationSlug] : [];
}

const sokosumiDist = dirname(dirname(realpathSync(execFileSync('which', ['sokosumi'], { encoding: 'utf8' }).trim())));
const { createCoworkerHttpClient } = await import(pathToFileURL(join(sokosumiDist, 'src/api/http-client.js')).href);
const { readRuntimeCredential } = await import(pathToFileURL(join(sokosumiDist, 'src/coworker/runtime-credentials.js')).href);
const coworker = createCoworkerHttpClient({ apiKey: readRuntimeCredential(id) });

async function coworkerEvent(taskId, body) {
  const response = await coworker.post(`/v1/tasks/${encodeURIComponent(taskId)}/events`, body);
  const event = response?.data ?? response;
  return event?.id ? event : event?.event ?? event;
}

async function ensureStatus(taskId, status) {
  try {
    return await coworkerEvent(taskId, { status });
  } catch (error) {
    if (String(error.message).includes('same status')) return null;
    throw error;
  }
}

function ask(taskId, comment, masumiPayment) {
  const body = { status: 'INPUT_REQUIRED', comment };
  if (masumiPayment) body.masumiPayment = masumiPayment;
  return ensureStatus(taskId, 'RUNNING').then(() => coworkerEvent(taskId, body));
}

function userReplies(taskId, seenCommentId) {
  const events = cli(['tasks', 'events', taskId, ...orgFlag()]).events ?? [];
  return events.filter((event) => event.actor?.type === 'user' && event.comment?.trim() && event.id !== seenCommentId);
}

function latestReply(taskId, seenCommentId) {
  const replies = userReplies(taskId, seenCommentId);
  return replies.length ? replies[replies.length - 1] : null;
}

async function searchRequest(brief) {
  try {
    const result = await searchStay({ ...brief, action: 'bookable', property_id: '' });
    if (!result.bookable?.length) {
      const skipped = (result.skipped || []).map((stay) => `${stay.name} at ${stay.price}`).join('; ');
      throw new HotelsError(skipped
        ? `Hotels.com listed rates, but none opened a checkout. ${skipped}`
        : 'Hotels.com returned no bookable stay');
    }
    return { result: { ...result, stays: result.bookable } };
  } catch (error) {
    const message = error instanceof HotelsError ? error.message : error.message;
    return { error: `Could not complete the stay request. ${message}` };
  }
}

async function quotedConfirmation(stay, brief) {
  const amount = quotedStayAmount(stay);
  let quote = '';
  if (amount) {
    try {
      const card = await quoteHotelsGiftCard({ amount, stayName: stay.name });
      quote = renderGiftCard(card);
    } catch (error) {
      quote = `The gift card quote failed. ${error.message.slice(0, 240)}\nThe stay remains pay later with free cancellation.`;
    }
  }
  return { question: confirmationQuestion(stay, brief, quote), quote };
}

function cli(args) {
  return JSON.parse(
    execFileSync('sokosumi', ['--preprod', ...args, '--json'], {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
}

function save(journal, state) {
  writeFileSync(journal, JSON.stringify(state), { mode: 0o600 });
  return state;
}

function markRunning(taskId) {
  return ensureStatus(taskId, 'RUNNING');
}

function withEscrowRelease(state, payment, resultText) {
  if (!payment?.blockchainIdentifier) return state;
  const releases = state.escrowReleases || [];
  if (releases.some((item) => item.blockchainIdentifier === payment.blockchainIdentifier)) return state;
  return {
    ...state,
    escrowReleases: [...releases, { blockchainIdentifier: payment.blockchainIdentifier, resultText, released: false }],
  };
}

async function releaseReadyEscrows(journal, state) {
  const releases = [];
  let changed = false;
  for (const item of state.escrowReleases || []) {
    if (item.released) {
      releases.push(item);
      continue;
    }
    try {
      const outcome = await submitPaymentResult(item);
      releases.push(outcome.released ? { ...item, released: true } : item);
      if (outcome.released) {
        changed = true;
        console.log('Escrow release requested', item.blockchainIdentifier.slice(0, 12));
      }
    } catch (error) {
      releases.push(item);
      console.error('Escrow release waiting', error.message.slice(0, 200));
    }
  }
  return changed ? save(journal, { ...state, escrowReleases: releases }) : { ...state, escrowReleases: releases };
}

async function finish(task, resultFile, journal, state, text, masumiPayment) {
  writeFileSync(resultFile, text, { mode: 0o600 });
  await markRunning(task.id);
  const completed = masumiPayment
    ? await coworkerEvent(task.id, { status: 'COMPLETED', comment: text, masumiPayment })
    : cli(['runtime', 'complete', task.id, ...scopeArgs(), '--coworker-id', id, '--result-file', resultFile]);
  save(journal, { ...withEscrowRelease(state, masumiPayment, text), phase: 'completed', completion: completed });
  console.log('Completed', task.id);
}

async function settleReservation(task, resultFile, journal, state) {
  const amount = quotedStayAmount(state.selected);
  const quote = state.giftQuote ? `\n\n${state.giftQuote}` : '';
  const summary = `${reservationResult(state.selected, state.reservation)}${quote}`;
  let payment = state.bookingPayment;
  if (!payment) {
    payment = await requestSokosumiPayment({ taskId: task.id, amountUsd: amount, purpose: 'booking' });
    state = save(journal, { ...state, bookingPayment: payment });
  }
  await finish(task, resultFile, journal, state, `${summary}\n\nSokosumi was asked to pay ${amount} USD to the payment service for this reservation. The hotel stay remains pay later with free cancellation.`, payment);
}

function stayReport(state) {
  const search = { ...state.search, adults: state.brief?.adults };
  const stays = state.stays || [];
  const lines = [
    `I found ${stays.length} pay-later, free-cancellation stay${stays.length === 1 ? '' : 's'} in ${search.destination}.`,
    `Dates: ${search.check_in} to ${search.check_out}. Adults: ${search.adults || 2}.`,
    '',
  ];
  stays.forEach((stay, index) => {
    lines.push(`${index + 1}. ${stay.name}, ${stay.price}, free cancellation ${stay.free_cancellation}`);
  });
  lines.push('', 'The hotel stay remains pay later with free cancellation. The gift card is not purchased.');
  return lines.join('\n');
}

async function showResults(task, journal, state) {
  const pendingResult = state.pendingResult || stayReport(state);
  let payment = state.resultsPayment || null;
  let amount = state.resultsAmount || '';
  if (!payment) {
    amount = state.resultsAmount || lowestQuotedAmount(state.stays);
    payment = await requestSokosumiPayment({ taskId: task.id, amountUsd: amount, purpose: 'results' });
    state = save(journal, { ...state, pendingResult, resultsPayment: payment, resultsAmount: amount, phase: 'awaiting-escrow' });
  }
  if (!state.chargePosted) {
    const event = await ask(task.id, `Sokosumi payment of ${amount} USD was requested for Expert Travel Advisor.\n${describeEscrow(payment)}\nThe stay result will be sent after that escrow is funded.`, payment);
    state = save(journal, { ...state, pendingResult, chargePosted: true, phase: 'awaiting-escrow', askedEventId: event.event?.id || event.id });
  }
  return state;
}

async function deliverFundedResult(task, resultFile, journal, state) {
  const escrow = await readEscrow({ blockchainIdentifier: state.resultsPayment?.blockchainIdentifier });
  if (!escrow.funded) return state;
  const text = `${describeEscrow({ ...state.resultsPayment, ...escrow })}\n\n${state.pendingResult}`;
  await finish(task, resultFile, journal, state, text);
  const delivered = save(journal, withEscrowRelease({ ...state, phase: 'completed', pendingResult: text }, state.resultsPayment, text));
  return releaseReadyEscrows(journal, delivered);
}

console.log('Continuous worker running', process.pid);
while (true) {
  try {
    const listArgs = ['tasks', 'list', '--coworker-id', id];
    if (organizationSlug) listArgs.push('--organization-slug', organizationSlug);
    const tasks = cli(listArgs).tasks ?? [];
    for (const task of tasks.filter((item) => item.coworkerId === id)) {
      const journal = `.local/${task.id}.json`;
      const resultFile = `.local/${task.id}.txt`;
      let state = existsSync(journal) ? JSON.parse(readFileSync(journal, 'utf8')) : {};
      try {
        if ((state.escrowReleases || []).some((item) => !item.released)) {
          state = await releaseReadyEscrows(journal, state);
        }
        if (task.status === 'READY' && !state.phase) {
          save(journal, { phase: 'starting' });
          const started = cli(['runtime', 'start', task.id, ...scopeArgs(), '--coworker-id', id]);
          const description = started.description ?? started.data?.description ?? task.description ?? '';
          const name = started.name ?? task.name ?? '';
          state = save(journal, { phase: 'started', input: `${name}\n${description}` });
        }
        if (state.phase === 'started') {
          let turn;
          try {
            turn = await consult(state.input, `.local/${task.id}-eve.json`);
          } catch (error) {
            await finish(task, resultFile, journal, state, `Could not complete the stay request. ${error.message.slice(0, 240)}`);
            continue;
          }
          const amount = lowestUsdInText(turn.message);
          if (!amount) {
            const question = turn.question || turn.message;
            if (question && (turn.question || question.includes('?'))) {
              const event = await ask(task.id, question);
              state = save(journal, { ...state, phase: 'awaiting-details', question, askedEventId: event.event?.id || event.id });
              console.log('Asked', task.id);
              continue;
            }
            await finish(task, resultFile, journal, state, question || 'Could not complete the stay request.');
            continue;
          }
          state = save(journal, {
            phase: 'posting-choice',
            input: state.input,
            pendingResult: turn.message,
            resultsAmount: amount,
          });
          await showResults(task, journal, state);
          console.log('Payment requested', task.id);
          continue;
        }
        if (state.phase === 'posting-choice') {
          await showResults(task, journal, state);
          console.log('Payment requested', task.id);
          continue;
        }
        if (state.phase === 'awaiting-escrow') {
          if (!state.chargePosted) {
            await showResults(task, journal, state);
            continue;
          }
          const delivered = await deliverFundedResult(task, resultFile, journal, state);
          if (delivered.phase === 'completed') console.log('Delivered after escrow', task.id);
          continue;
        }
        if (state.phase === 'awaiting-gift-card') {
          const reply = latestReply(task.id, state.seenCommentId);
          if (!reply) continue;
          const quoted = await quotedConfirmation(state.selected, state.brief);
          const event = await ask(task.id, quoted.question);
          state = save(journal, { ...state, phase: 'awaiting-confirm', giftQuote: quoted.quote, seenCommentId: reply.id, askedEventId: event.event?.id });
          console.log('Asked', task.id);
          continue;
        }
        if (state.phase === 'reserved') {
          if (!state.bookingPayment && state.paymentPrompted) {
            const reply = latestReply(task.id, state.seenCommentId);
            if (!reply) continue;
            const intent = replyIntent(reply.comment);
            if (intent === 'decline') {
              const quote = state.giftQuote ? `\n\n${state.giftQuote}` : '';
              await finish(task, resultFile, journal, { ...state, seenCommentId: reply.id }, `${reservationResult(state.selected, state.reservation)}${quote}\n\nThe reservation stands. Sokosumi was not asked to pay.`);
              continue;
            }
            if (intent !== 'confirm') {
              const event = await ask(task.id, 'Reply yes to request the Sokosumi payment again, or no to finish without it.');
              save(journal, { ...state, seenCommentId: reply.id, askedEventId: event.event?.id });
              continue;
            }
            state = save(journal, { ...state, seenCommentId: reply.id, paymentPrompted: false });
          }
          try {
            await settleReservation(task, resultFile, journal, state);
          } catch (error) {
            const event = await ask(task.id, `The reservation is made. Sokosumi payment was not requested. ${error.message.slice(0, 240)}\n\nReply yes to request the payment again, or no to finish without it.`);
            state = save(journal, { ...state, paymentPrompted: true, askedEventId: event.event?.id });
            console.log('Asked', task.id);
          }
          continue;
        }
        if (state.phase === 'awaiting-details' || state.phase === 'awaiting-choice' || state.phase === 'awaiting-confirm') {
          const reply = latestReply(task.id, state.seenCommentId);
          if (!reply) continue;
          const text = reply.comment.trim();
          const combined = `${state.input}\n${text}`;
          if (state.phase === 'awaiting-details') {
            state = save(journal, { ...state, phase: 'started', input: combined, seenCommentId: reply.id });
            continue;
          }
          if (state.phase === 'awaiting-choice') {
            const stay = chooseStay(text.replace(/gift\s*card/ig, ' '), state.stays || []) || chooseStay(text, state.stays || []);
            if (!stay) {
              const event = await ask(task.id, wantsGiftCard(text)
                ? 'Reply with the stay number, for example "2 gift card". The gift card is quoted at that stay\'s total and is not purchased.'
                : 'Reply with the number of the stay you want. I will not continue until you confirm.');
              state = save(journal, { ...state, seenCommentId: reply.id, askedEventId: event.event?.id });
              console.log('Asked', task.id);
              continue;
            }
            const quoted = await quotedConfirmation(stay, state.brief);
            const event = await ask(task.id, quoted.question);
            state = save(journal, { ...state, phase: 'awaiting-confirm', selected: stay, giftQuote: quoted.quote, seenCommentId: reply.id, askedEventId: event.event?.id });
            console.log('Asked', task.id);
            continue;
          }
          const intent = replyIntent(text);
          const picked = chooseStay(text.replace(/gift\s*card/ig, ' '), state.stays || []);
          if ((intent === 'other' || wantsGiftCard(text)) && picked && picked.property_id !== state.selected?.property_id) {
            const quoted = await quotedConfirmation(picked, state.brief);
            const event = await ask(task.id, quoted.question);
            state = save(journal, { ...state, selected: picked, giftQuote: quoted.quote, seenCommentId: reply.id, askedEventId: event.event?.id });
            console.log('Asked', task.id);
            continue;
          }
          if (intent === 'decline') {
            await finish(task, resultFile, journal, { ...state, seenCommentId: reply.id }, 'Booking was not confirmed. No reservation was made.');
            continue;
          }
          if (intent !== 'confirm') {
            const event = await ask(task.id, confirmationQuestion(state.selected, state.brief, state.giftQuote));
            state = save(journal, { ...state, seenCommentId: reply.id, askedEventId: event.event?.id });
            console.log('Asked', task.id);
            continue;
          }
          const checkout = state.selected.checkout;
          if (!checkout?.checkout_url) {
            const event = await ask(task.id, `${state.selected.name} has no checkout URL. Reply with another number, or reply no to stop.`);
            state = save(journal, { ...state, phase: 'awaiting-choice', seenCommentId: reply.id, askedEventId: event?.id });
            console.log('Asked', task.id);
            continue;
          }
          let reservation;
          try {
            reservation = bookReservation(checkout.checkout_url).reservation;
          } catch (error) {
            const event = await ask(task.id, `The reservation was not finished. ${error.message.slice(0, 240)}\n\nReply yes to try again, or no to stop.`);
            state = save(journal, { ...state, seenCommentId: reply.id, askedEventId: event.event?.id });
            console.log('Asked', task.id);
            continue;
          }
          state = save(journal, { ...state, phase: 'reserved', seenCommentId: reply.id, reservation, paymentPrompted: false });
          continue;
        }
      } catch (error) {
        console.error('Task blocked', task.id, error.message.slice(0, 200));
      }
    }
  } catch (error) {
    console.error('Polling read failed', error.message.slice(0, 200));
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
