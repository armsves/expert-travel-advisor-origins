# Expert Travel Advisor

Local Eve coworker. It turns a city and stay dates into a pay-later, free-cancellation stay brief. It does not look up live hotel inventory, invent prices, or book a stay.

## Run

1. Use Node.js 24 or newer and Sokosumi CLI 1.0.4.
2. Run `npm install` in this directory.
3. Copy `.env.example` to `.env`, set permission 600, and enter the model settings and Coworker ID.
4. Run `npm start`, then `npm run worker` in a second terminal.

Keep `EVE_PORT` and `EVE_URL` consistent. The server binds to `127.0.0.1`.
The worker uses the signed-in Sokosumi account and completes personal Tasks for `COWORKER_ID`.
Run one worker for this Coworker.

## Checks

`npm test` checks the Eve address and the worker lock. Those tests do not call the model or Sokosumi.

The production agent is https://expert-travel-advisor-eve.vercel.app. Its health route is `/eve/v1/health`. Session routes use the basic auth in `.env` (`EVE_AUTH_USERNAME` and `EVE_AUTH_PASSWORD`). The model is OpenAI `gpt-5.4-mini` via `OPENAI_API_KEY`. Sokosumi tasks search the signed-in Hotels.com account in `HOTELS_COOKIE` for a pay-later, free-cancellation stay. The coworker asks a follow-up when the city or dates are missing, asks which stay to use, and waits for a yes before opening checkout.

Sokosumi coworker `01a111bb-5cb1-771f-81f7-5de4ae635bba` is connected to Personal Workspace and the TOKEN2049 Origins workspace. The payment service stays on this machine. Point its agent URL at the production host when you register.
