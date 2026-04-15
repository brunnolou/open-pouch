import type { IngestedContent } from '../../shared/types/ingest.js';

function slugify( value: string ): string {
  return value
    .toLowerCase()
    .replace( /[^a-z0-9]+/g, '-' )
    .replace( /(^-|-$)/g, '' )
    .slice( 0, 64 ) || 'untitled';
}

export function createMarkdownDocument( ingestedContent: IngestedContent ): string {
  return [
    `# ${ingestedContent.title}`,
    '',
    `Source: ${ingestedContent.url}`,
    `Fetched At: ${new Date().toISOString()}`,
    `Tokens: ${ingestedContent.tokenCount}`,
    '',
    '---',
    '',
    ingestedContent.content.trim()
  ].join( '\n' );
}

export function createMarkdownFileName( title: string ): string {
  const timestamp = new Date().toISOString().replace( /[:.]/g, '-' );
  return `${timestamp}-${slugify( title )}.md`;
}
