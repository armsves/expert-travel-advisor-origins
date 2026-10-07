import { defineAgent } from 'eve';
import { openai } from 'eve/models/openai';

export default defineAgent({
  model: openai('gpt-5.4-mini'),
  defaultTools: false,
  build: { externalDependencies: ['impit'] },
});
