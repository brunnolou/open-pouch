import type { BlogContent } from '../blog_evaluator/types.js';

function slugify( value: string ): string {
  return value
    .toLowerCase()
    .replace( /[^a-z0-9]+/g, '-' )
    .replace( /(^-|-$)/g, '' )
    .slice( 0, 64 ) || 'untitled';
}

export function createMarkdownDocument( blogContent: BlogContent ): string {
  return [
    `# ${blogContent.title}`,
    '',
    `Source: ${blogContent.url}`,
    `Fetched At: ${new Date().toISOString()}`,
    `Tokens: ${blogContent.tokenCount}`,
    '',
    '---',
    '',
    blogContent.content.trim()
  ].join( '\n' );
}

export function createMarkdownFileName( title: string ): string {
  const timestamp = new Date().toISOString().replace( /[:.]/g, '-' );
  return `${timestamp}-${slugify( title )}.md`;
}
