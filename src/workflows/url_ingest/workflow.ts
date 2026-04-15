import { workflow } from '@outputai/core';
import { fetchContent } from '../../shared/steps/ingest.js';
import { validateUrl } from '../../shared/utils/url.js';
import { createMarkdownDocument } from './utils.js';
import { workflowInputSchema, workflowOutputSchema } from './types.js';

export default workflow( {
  name: 'url_ingest',
  description: 'Fetch a URL with Jina and return markdown content',
  inputSchema: workflowInputSchema,
  outputSchema: workflowOutputSchema,
  fn: async ( input ) => {
    const validatedUrl = validateUrl( input.url );
    const ingestedContent = await fetchContent( { url: validatedUrl } );

    return {
      url: ingestedContent.url,
      title: ingestedContent.title,
      markdown: createMarkdownDocument( ingestedContent ),
      tokenCount: ingestedContent.tokenCount
    };
  }
} );
