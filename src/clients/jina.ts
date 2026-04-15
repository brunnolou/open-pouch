import { httpClient } from '@outputai/http';

export interface JinaReaderResponse {
  code: number;
  status: number;
  data: {
    title: string;
    description: string;
    url: string;
    content: string;
    usage: { tokens: number };
  };
}

const jinaClient = httpClient( {
  prefixUrl: 'https://r.jina.ai',
  timeout: 30000
} );

export async function fetchUrlContent( url: string ): Promise<JinaReaderResponse> {
  const response = await jinaClient.post( '', {
    json: { url },
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Return-Format': 'markdown',
      'X-Remove-Selector': 'nav, footer, header, .sidebar, .menu, .navigation, #ads',
      'X-Target-Selector': 'article, main, .content, .post, #content, .main-content'
    }
  } );
  return response.json() as Promise<JinaReaderResponse>;
}
