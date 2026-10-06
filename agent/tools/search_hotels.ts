import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { HotelsError, searchStay } from '../hotels-search.mjs';

export default defineTool({
  description: 'Search the signed-in Hotels.com account for a pay-later, free-cancellation stay. Use action checkout to open the checkout URL for the cheapest matching stay. This does not confirm the booking.',
  inputSchema: z.object({
    destination: z.string().min(1),
    check_in: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    check_out: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    adults: z.number().int().min(1).max(8).default(2),
    payment_type: z.string().default('PAY_LATER'),
    lodging: z.string().default(''),
    action: z.enum(['search', 'checkout']).default('checkout'),
    property_id: z.string().default(''),
  }),
  async execute(input) {
    try {
      return searchStay(input);
    } catch (error) {
      const message = error instanceof HotelsError ? error.message : 'Hotels.com search failed';
      return { status: 'failed', message };
    }
  },
});
