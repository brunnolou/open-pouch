import { z } from '@outputai/core';

export const ingestedContentSchema = z.object( {
  title: z.string(),
  url: z.string(),
  content: z.string(),
  tokenCount: z.number()
} );

export type IngestedContent = z.infer<typeof ingestedContentSchema>;
