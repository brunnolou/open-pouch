import { workflow } from '@outputai/core';
import { validateUrl } from '../../shared/utils/url.js';
import { fetchContent } from '../blog_evaluator/steps.js';
import { createMarkdownDocument } from './utils.js';
import { workflowInputSchema, workflowOutputSchema } from './types.js';

export default workflow( {
  name: 'url_ingest',
  description: 'Fetch a URL with Jina and return markdown content',
  inputSchema: workflowInputSchema,
  outputSchema: workflowOutputSchema,
  fn: async ( input ) => {
    const validatedUrl = validateUrl( input.url );
    const blogContent = await fetchContent( { url: validatedUrl } );

    return {
      url: blogContent.url,
      title: blogContent.title,
      markdown: createMarkdownDocument( blogContent ),
      tokenCount: blogContent.tokenCount
    };
  }
} );
