import { step, z } from '@outputai/core';
import { fetchUrlContent } from '../../clients/jina.js';
import { ingestedContentSchema } from '../types/ingest.js';

export const fetchContent = step( {
  name: 'fetch_url_content',
  description: 'Fetch content from a URL using Jina Reader API',
  inputSchema: z.object( {
    url: z.string().url()
  } ),
  outputSchema: ingestedContentSchema,
  fn: async ( { url } ) => {
    const response = await fetchUrlContent( url );
    return {
      title: response.data.title,
      url: response.data.url,
      content: response.data.content,
      tokenCount: response.data.usage.tokens
    };
  }
} );
