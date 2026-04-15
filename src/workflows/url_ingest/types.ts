import { z } from '@outputai/core';

export const workflowInputSchema = z.object( {
  url: z.string().url().describe( 'URL of the page to fetch as markdown' )
} );

export const workflowOutputSchema = z.object( {
  url: z.string(),
  title: z.string(),
  markdown: z.string(),
  tokenCount: z.number()
} );

export type UrlIngestInput = z.infer<typeof workflowInputSchema>;
export type UrlIngestOutput = z.infer<typeof workflowOutputSchema>;
