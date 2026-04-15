import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { createMarkdownFileName } from '../workflows/url_ingest/utils.js';

const __filename = fileURLToPath( import.meta.url );
const __dirname = path.dirname( __filename );

let mainWindow: BrowserWindow | null = null;
let contentDir = '';
const OUTPUT_API_URL = process.env.OUTPUT_API_URL ?? 'http://localhost:3001';
const MEM0_API_URL = process.env.MEM0_API_URL ?? 'http://localhost:8888';

interface OutputErrorResponse {
  message?: string;
}

interface OutputResultResponse {
  workflowId?: string;
  output?: {
    title?: string;
    url?: string;
    markdown?: string;
    tokenCount?: number;
  };
  error?: string | null;
  status?: string;
}

async function apiRequest<T>( pathname: string, init?: RequestInit ): Promise<T> {
  const response = await fetch( `${OUTPUT_API_URL}${pathname}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...( init?.headers ?? {} )
    }
  } );

  const payload = await response.json().catch( () => ( {} ) ) as T | OutputErrorResponse;
  if ( !response.ok ) {
    throw new Error(
      ( payload as OutputErrorResponse ).message ?? `Output API request failed with status ${response.status}.`
    );
  }

  return payload as T;
}

async function mem0Request<T>( pathname: string, init?: RequestInit ): Promise<T> {
  const response = await fetch( `${MEM0_API_URL}${pathname}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...( init?.headers ?? {} )
    }
  } );

  const payload = await response.json().catch( () => ( {} ) ) as T;
  if ( !response.ok ) {
    throw new Error( `Mem0 API request failed with status ${response.status}.` );
  }

  return payload;
}

async function getOutputHealth() {
  const response = await fetch( `${OUTPUT_API_URL}/health` );
  return response.ok;
}

async function getMem0Health() {
  const response = await fetch( `${MEM0_API_URL}/` );
  return response.ok;
}

async function startWorkflowRun( url: string ) {
  const payload = await apiRequest<{ workflowId?: string }>( '/workflow/start', {
    method: 'POST',
    body: JSON.stringify( {
      workflowName: 'url_ingest',
      input: { url }
    } )
  } );

  const workflowId = payload.workflowId;
  if ( !workflowId ) {
    throw new Error( 'Workflow started without an id.' );
  }

  return workflowId;
}

async function waitForWorkflowResult( workflowId: string ) {
  const maxAttempts = 120;

  for ( let attempt = 0; attempt < maxAttempts; attempt += 1 ) {
    const statusResponse = await apiRequest<{ workflowId?: string; status?: string }>( `/workflow/${workflowId}/status` );
    const status = statusResponse.status;

    if ( status === 'completed' ) {
      return apiRequest<OutputResultResponse>( `/workflow/${workflowId}/result` );
    }

    if ( status && status !== 'running' && status !== 'unspecified' ) {
      throw new Error( `Workflow ended with status "${status}".` );
    }

    await new Promise( resolve => setTimeout( resolve, 1000 ) );
  }

  throw new Error( 'Timed out waiting for workflow result.' );
}

async function createMainWindow() {
  contentDir = path.join( app.getPath( 'userData' ), 'ingested-content' );
  await mkdir( contentDir, { recursive: true } );

  mainWindow = new BrowserWindow( {
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 760,
    backgroundColor: '#0b1020',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join( __dirname, 'preload.cjs' )
    }
  } );

  await mainWindow.loadFile( path.join( __dirname, 'index.html' ) );

  mainWindow.on( 'closed', () => {
    mainWindow = null;
  } );
}

// ── Output workflow handlers ────────────────────────────────────────────────

ipcMain.handle( 'output:get-config', async () => ( {
  apiBaseUrl: OUTPUT_API_URL,
  mem0BaseUrl: MEM0_API_URL
} ) );

ipcMain.handle( 'output:health', async () => {
  try {
    const ok = await getOutputHealth();
    return { ok };
  } catch ( error ) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to reach Output API.'
    };
  }
} );

ipcMain.handle( 'output:ingest-url', async ( _event, payload: { url: string; project?: string } ) => {
  const workflowId = await startWorkflowRun( payload.url );
  const result = await waitForWorkflowResult( workflowId );
  const output = result.output;

  if ( !output?.markdown || !output.title || !output.url ) {
    throw new Error( result.error ?? 'Workflow completed without markdown output.' );
  }

  const fileName = createMarkdownFileName( output.title );
  const filePath = path.join( contentDir, fileName );
  await writeFile( filePath, output.markdown, 'utf8' );

  if ( payload.project ) {
    try {
      await mem0Request( '/memories', {
        method: 'POST',
        body: JSON.stringify( {
          messages: [
            { role: 'user', content: `I ingested this article: "${output.title}" from ${output.url}. Here is a summary of the content:\n\n${output.markdown.slice( 0, 3000 )}` },
            { role: 'assistant', content: `I've stored the article "${output.title}" in memory for the ${payload.project} project.` }
          ],
          user_id: `project:${payload.project}`,
          metadata: {
            source_type: 'article',
            source_url: output.url,
            tags: 'ingested'
          }
        } )
      } );
    } catch {
      // Memory storage is best-effort; don't fail the ingest
    }
  }

  return {
    workflowId,
    title: output.title,
    url: output.url,
    markdown: output.markdown,
    tokenCount: output.tokenCount ?? null,
    filePath
  };
} );

ipcMain.handle( 'output:render-markdown', async ( _event, payload: { markdown: string } ) => {
  const rendered = await marked.parse( payload.markdown );

  return sanitizeHtml( rendered, {
    allowedTags: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'hr',
      'blockquote',
      'ul', 'ol', 'li',
      'strong', 'em', 'code', 'pre',
      'a',
      'table', 'thead', 'tbody', 'tr', 'th', 'td'
    ],
    allowedAttributes: {
      a: [ 'href', 'target', 'rel' ],
      code: [ 'class' ]
    },
    allowedSchemes: [ 'http', 'https', 'mailto' ],
    transformTags: {
      a: sanitizeHtml.simpleTransform( 'a', {
        target: '_blank',
        rel: 'noreferrer noopener'
      } )
    }
  } );
} );

// ── Mem0 memory handlers ────────────────────────────────────────────────────

ipcMain.handle( 'mem0:health', async () => {
  try {
    const ok = await getMem0Health();
    return { ok };
  } catch {
    return { ok: false };
  }
} );

ipcMain.handle( 'mem0:list-memories', async ( _event, payload: { project: string } ) => {
  const uid = `project:${payload.project}`;
  return mem0Request( `/memories?user_id=${encodeURIComponent( uid )}` );
} );

ipcMain.handle( 'mem0:search', async ( _event, payload: { project: string; query: string } ) => {
  return mem0Request( '/search', {
    method: 'POST',
    body: JSON.stringify( {
      query: payload.query,
      user_id: `project:${payload.project}`,
      limit: 20
    } )
  } );
} );

ipcMain.handle( 'mem0:add-memory', async ( _event, payload: { project: string; content: string; metadata?: Record<string, string> } ) => {
  return mem0Request( '/memories', {
    method: 'POST',
    body: JSON.stringify( {
      messages: [
        { role: 'user', content: payload.content }
      ],
      user_id: `project:${payload.project}`,
      metadata: {
        source_type: 'manual',
        ...( payload.metadata ?? {} )
      }
    } )
  } );
} );

ipcMain.handle( 'mem0:delete-memory', async ( _event, payload: { memoryId: string } ) => {
  await mem0Request( `/memories/${encodeURIComponent( payload.memoryId )}`, {
    method: 'DELETE'
  } );
  return { deleted: true };
} );

ipcMain.handle( 'mem0:delete-project', async ( _event, payload: { project: string } ) => {
  const uid = `project:${payload.project}`;
  await mem0Request( `/memories?user_id=${encodeURIComponent( uid )}`, {
    method: 'DELETE'
  } );
  return { deleted: true };
} );

// ── App lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then( async () => {
  await createMainWindow();

  app.on( 'activate', async () => {
    if ( BrowserWindow.getAllWindows().length === 0 ) {
      await createMainWindow();
    }
  } );
} );

app.on( 'window-all-closed', async () => {
  if ( process.platform !== 'darwin' ) {
    app.quit();
  }
} );
