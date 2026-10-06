import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { quoteHotelsGiftCard, renderGiftCard } from '../gift-card.mjs';

export default defineTool({
  description: 'Quote a Hotels.com USD gift card for one stay\'s quoted total. Does not buy the card or create a Bitrefill invoice. Returns the ADA amount a NEAR Intents swap would use to pay that total in USDC on Base. The stay remains pay later with free cancellation.',
  inputSchema: z.object({
    amount: z.string().min(1),
    stay_name: z.string().default(''),
  }),
  async execute(input) {
    try {
      const card = await quoteHotelsGiftCard({ amount: input.amount, stayName: input.stay_name });
      return { status: 'completed', message: renderGiftCard(card), ...card };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The gift card quote failed';
      return { status: 'failed', message };
    }
  },
});