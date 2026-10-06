import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireWorkerLock } from './worker-lock.mjs';
import { choiceQuestion, chooseStay, confirmationQuestion, inspectRequest, replyIntent } from './agent/follow-up.mjs';
import { quoteHotelsGiftCard, quotedStayAmount, renderGiftCard, wantsGiftCard } from './agent/gift-card.mjs';
import { HotelsError, renderResult, searchStay } from './agent/hotels-search.mjs';

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

function ask(taskId, comment) {
  return ensureStatus(taskId, 'RUNNING').then(() => coworkerEvent(taskId, { status: 'INPUT_REQUIRED', comment }));
}

function userReplies(taskId, seenCommentId) {
  const events = cli(['tasks', 'events', taskId, ...orgFlag()]).events ?? [];
  return events.filter((event) => event.actor?.type === 'user' && event.comment?.trim() && event.id !== seenCommentId);
}

function latestReply(taskId, seenCommentId) {
  const replies = userReplies(taskId, seenCommentId);
  return replies.length ? replies[replies.length - 1] : null;
}

function searchRequest(brief) {
  try {
    const result = searchStay({ ...brief, action: 'bookable', property_id: '' });
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

async function finish(task, resultFile, journal, state, text) {
  writeFileSync(resultFile, text, { mode: 0o600 });
  await markRunning(task.id);
  const completed = cli(['runtime', 'complete', task.id, ...scopeArgs(), '--coworker-id', id, '--result-file', resultFile]);
  save(journal, { ...state, phase: 'completed', completion: completed });
  console.log('Completed', task.id);
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
        if (task.status === 'READY' && !state.phase) {
          save(journal, { phase: 'starting' });
          const started = cli(['runtime', 'start', task.id, ...scopeArgs(), '--coworker-id', id]);
          const description = started.description ?? started.data?.description ?? task.description ?? '';
          const name = started.name ?? task.name ?? '';
          state = save(journal, { phase: 'started', input: `${name}\n${description}` });
        }
        if (state.phase === 'started') {
          const inspected = inspectRequest(state.input);
          if (inspected.question) {
            const event = await ask(task.id, inspected.question);
            state = save(journal, { ...state, phase: 'awaiting-details', question: inspected.question, askedEventId: event.event?.id });
            console.log('Asked', task.id);
            continue;
          }
          const found = searchRequest(inspected.brief);
          if (found.error) {
            await finish(task, resultFile, journal, state, found.error);
            continue;
          }
          state = save(journal, { phase: 'posting-choice', input: state.input, brief: inspected.brief, stays: found.result.stays, search: found.result });
          const question = choiceQuestion({ ...found.result, adults: inspected.brief.adults });
          const event = await ask(task.id, question);
          state = save(journal, {
            phase: 'awaiting-choice',
            input: state.input,
            brief: inspected.brief,
            stays: found.result.stays,
            search: found.result,
            askedEventId: event.event?.id,
          });
          console.log('Asked', task.id);
          continue;
        }
        if (state.phase === 'posting-choice') {
          const question = choiceQuestion({ ...state.search, adults: state.brief.adults });
          const event = await ask(task.id, question);
          state = save(journal, { ...state, phase: 'awaiting-choice', askedEventId: event?.id });
          console.log('Asked', task.id);
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
          const summary = renderResult({ ...state.search, stays: [state.selected], checkout, action: 'checkout' });
          const quote = state.giftQuote ? `\n\n${state.giftQuote}` : '';
          await finish(task, resultFile, journal, { ...state, seenCommentId: reply.id }, `${summary}${quote}\n\nYou confirmed the stay. It remains pay later with free cancellation. Open the checkout URL to review it. No card was charged from this task, and the gift card was quoted only.`);
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
