import { z } from '@outputai/core';

export const workflowInputSchema = z.object({
  name: z.string().describe('Name to greet'),
});

export const workflowOutputSchema = z.object({
  greeting: z.string().describe('The greeting message'),
});

export type WorkflowInput = z.infer<typeof workflowInputSchema>;
export type WorkflowOutput = z.infer<typeof workflowOutputSchema>;
