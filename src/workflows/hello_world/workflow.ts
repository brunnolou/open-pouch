import { workflow } from '@outputai/core';
import { greet } from './steps.js';
import { workflowInputSchema, workflowOutputSchema } from './types.js';

export default workflow({
  name: 'hello_world',
  description: 'A simple workflow that greets a given name',
  inputSchema: workflowInputSchema,
  outputSchema: workflowOutputSchema,
  fn: async (input) => {
    const { greeting } = await greet({ name: input.name });
    return { greeting };
  },
});
