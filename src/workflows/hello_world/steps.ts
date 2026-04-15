import { step, z } from '@outputai/core';

export const greet = step({
  name: 'greet',
  description: 'Returns a greeting for the given name',
  inputSchema: z.object({
    name: z.string(),
  }),
  outputSchema: z.object({
    greeting: z.string(),
  }),
  fn: async ({ name }) => {
    return { greeting: `Hello, ${name}!` };
  },
});
