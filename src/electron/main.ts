import { app, BrowserWindow, ipcMain } from 'electron';
import { Buffer } from 'node:buffer';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { createMarkdownFileName } from '../workflows/url_ingest/utils.js';
import {
  AuthStorage,
  createAgentSession,
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  codingTools,
  type AgentSession,
  type AgentSessionEvent,
  type Skill
} from '@mariozechner/pi-coding-agent';

const __filename = fileURLToPath( import.meta.url );
const __dirname = path.dirname( __filename );

let mainWindow: BrowserWindow | null = null;
/** Root directory containing one folder per project (folder name === Mem0 / UI slug). */
let projectsRoot = '';
let agentSession: AgentSession | null = null;
let agentUnsubscribe: ( () => void ) | null = null;
/** Project slug whose folder is the Pi agent cwd (filesystem source of truth). */
let agentWorkingProject = 'unassigned';

const OUTPUT_API_URL = process.env.OUTPUT_API_URL ?? 'http://localhost:3001';
const MEM0_API_URL = process.env.MEM0_API_URL ?? 'http://localhost:8888';
const UNASSIGNED_PROJECT = 'unassigned';
const DEFAULT_MEM0_USER_ID = 'open-pouch';

/** Optional Neo4j graph cleanup after Mem0 deletes a memory (see mem0ai/mem0#3245). */
const NEO4J_HTTP_URL = process.env.NEO4J_HTTP_URL?.replace( /\/$/, '' ) ?? '';
const NEO4J_DATABASE = process.env.NEO4J_DATABASE ?? 'neo4j';
const NEO4J_USER = process.env.NEO4J_USER ?? 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? '';

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

function resolveProjectName( project?: string ) {
  return project?.trim() || UNASSIGNED_PROJECT;
}

function projectUserId( project?: string ) {
  const resolvedProject = resolveProjectName( project );
  if ( resolvedProject === UNASSIGNED_PROJECT || resolvedProject === 'default' ) {
    return DEFAULT_MEM0_USER_ID;
  }

  return `project:${resolvedProject}`;
}

function sanitizeProjectSlug( raw: string ) {
  return raw
    .trim()
    .toLowerCase()
    .replace( /[^a-z0-9_-]/g, '-' )
    .replace( /-+/g, '-' )
    .replace( /^-|-$/g, '' );
}

function getProjectContentDir( project?: string ) {
  const slug = resolveProjectName( project );
  return path.join( projectsRoot, slug );
}

function isPathInsideProjectsRoot( filePath: string ): boolean {
  if ( !projectsRoot ) {
    return false;
  }

  const resolved = path.resolve( filePath );
  const base = path.resolve( projectsRoot );
  const relative = path.relative( base, resolved );
  return relative !== '' && !relative.startsWith( '..' ) && !path.isAbsolute( relative );
}

async function migrateLegacyIngestedContent() {
  const legacyDir = path.join( app.getPath( 'userData' ), 'ingested-content' );
  const destDir = getProjectContentDir( UNASSIGNED_PROJECT );

  try {
    const entries = await readdir( legacyDir, { withFileTypes: true } );
    if ( entries.length === 0 ) {
      await rm( legacyDir, { recursive: true, force: true } );
      return;
    }

    await mkdir( destDir, { recursive: true } );

    for ( const ent of entries ) {
      if ( !ent.isFile() ) {
        continue;
      }

      const from = path.join( legacyDir, ent.name );
      const to = path.join( destDir, ent.name );

      try {
        await rename( from, to );
      } catch {
        // Name collision or permission — leave file in legacy dir
      }
    }

    const remaining = await readdir( legacyDir );
    if ( remaining.length === 0 ) {
      await rm( legacyDir, { recursive: true, force: true } );
    }
  } catch {
    // No legacy folder
  }
}

async function ensureProjectsLayout() {
  projectsRoot = path.join( app.getPath( 'userData' ), 'projects' );
  await mkdir( projectsRoot, { recursive: true } );
  await mkdir( getProjectContentDir( UNASSIGNED_PROJECT ), { recursive: true } );
  await migrateLegacyIngestedContent();
}

async function listProjectSlugs(): Promise<string[]> {
  const entries = await readdir( projectsRoot, { withFileTypes: true } );
  const dirs = new Set(
    entries.filter( e => e.isDirectory() && !e.name.startsWith( '.' ) ).map( e => e.name )
  );
  dirs.add( UNASSIGNED_PROJECT );

  const rest = [ ...dirs ]
    .filter( n => n !== UNASSIGNED_PROJECT )
    .sort( ( a, b ) => a.localeCompare( b ) );

  return [ UNASSIGNED_PROJECT, ...rest ];
}

function deriveManualMemoryTitle( markdown: string ) {
  const headingMatch = markdown.match( /^\s*#\s+(.+)$/m );
  if ( headingMatch?.[1]?.trim() ) {
    return headingMatch[1].trim();
  }

  const firstContentLine = markdown
    .split( '\n' )
    .map( line => line.trim() )
    .find( Boolean );

  if ( firstContentLine ) {
    return firstContentLine.slice( 0, 80 );
  }

  return `Untitled note ${new Date().toLocaleString( 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } )}`;
}

function summarizeMarkdownForMemory( markdown: string ) {
  const condensed = markdown
    .replace( /^#{1,6}\s+/gm, '' )
    .replace( /`{1,3}[^`]*`{1,3}/g, ' ' )
    .replace( /\[(.*?)\]\((.*?)\)/g, '$1' )
    .replace( /[*_>-]/g, ' ' )
    .replace( /\s+/g, ' ' )
    .trim();

  return condensed.slice( 0, 280 ) || 'New note';
}

async function createUniqueMarkdownPath( dir: string, title: string ) {
  const baseFileName = createMarkdownFileName( title );
  const extension = path.extname( baseFileName ) || '.md';
  const nameWithoutExt = path.basename( baseFileName, extension );

  for ( let suffix = 0; suffix < 1000; suffix += 1 ) {
    const candidateName = suffix === 0 ? baseFileName : `${nameWithoutExt}-${suffix + 1}${extension}`;
    const candidatePath = path.join( dir, candidateName );

    try {
      await access( candidatePath );
    } catch {
      return candidatePath;
    }
  }

  throw new Error( 'Unable to allocate a unique markdown file name.' );
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

/**
 * Detach-delete graph nodes tied to a Mem0 memory id (Mem0 graph memory / Neo4j).
 * Best-effort: logs warnings only; Mem0 vector delete has already succeeded.
 */
async function neo4jCascadeDetachMemory( memoryId: string ): Promise<void> {
  if ( !NEO4J_HTTP_URL || !NEO4J_PASSWORD ) {
    return;
  }

  const auth = Buffer.from( `${NEO4J_USER}:${NEO4J_PASSWORD}` ).toString( 'base64' );
  const url = `${NEO4J_HTTP_URL}/db/${encodeURIComponent( NEO4J_DATABASE )}/tx/commit`;
  const statement = 'MATCH (n) WHERE n.id = $memory_id OR n.memory_id = $memory_id DETACH DELETE n';

  try {
    const res = await fetch( url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify( {
        statements: [ { statement, parameters: { memory_id: memoryId } } ]
      } )
    } );

    const payload = await res.json().catch( () => ( {} ) ) as {
      errors?: Array<{ code?: string; message?: string }>;
    };

    if ( !res.ok || payload.errors?.length ) {
      const msg = !res.ok
        ? `HTTP ${res.status}`
        : ( payload.errors?.map( e => e.message ?? e.code ).join( '; ' ) ?? 'unknown' );
      console.warn( `[open-pouch] Neo4j cascade failed for memory ${memoryId}: ${msg}` );
    }
  } catch ( err ) {
    console.warn( `[open-pouch] Neo4j cascade failed for memory ${memoryId}:`, err );
  }
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
  await ensureProjectsLayout();

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

function disposeAgentSession() {
  if ( agentUnsubscribe ) {
    agentUnsubscribe();
    agentUnsubscribe = null;
  }

  if ( agentSession ) {
    agentSession.dispose();
    agentSession = null;
  }
}

ipcMain.handle( 'projects:list', async () => listProjectSlugs() );

ipcMain.handle( 'projects:create', async ( _event, payload: { slug: string } ) => {
  if ( !projectsRoot ) {
    throw new Error( 'Projects are not initialised yet.' );
  }

  const slug = sanitizeProjectSlug( payload.slug );

  if ( !slug ) {
    throw new Error( 'Project name is required.' );
  }

  if ( slug === 'default' ) {
    throw new Error( `Use "${UNASSIGNED_PROJECT}" instead of "default".` );
  }

  const dir = getProjectContentDir( slug );

  const exists = await access( dir ).then( () => true, () => false );
  if ( exists ) {
    throw new Error( `Project "${slug}" already exists.` );
  }

  await mkdir( dir, { recursive: true } );
  return { project: slug };
} );

ipcMain.handle( 'projects:rename', async ( _event, payload: { from: string; to: string } ) => {
  if ( !projectsRoot ) {
    throw new Error( 'Projects are not initialised yet.' );
  }

  const fromSlug = sanitizeProjectSlug( payload.from );
  const toSlug = sanitizeProjectSlug( payload.to );

  if ( !fromSlug || !toSlug || fromSlug === toSlug ) {
    throw new Error( 'Invalid rename.' );
  }

  if ( fromSlug === UNASSIGNED_PROJECT ) {
    throw new Error( `Cannot rename "${UNASSIGNED_PROJECT}".` );
  }

  if ( toSlug === 'default' ) {
    throw new Error( `Use "${UNASSIGNED_PROJECT}" instead of "default".` );
  }

  const oldPath = path.join( projectsRoot, fromSlug );
  const newPath = path.join( projectsRoot, toSlug );

  const srcExists = await access( oldPath ).then( () => true, () => false );
  if ( !srcExists ) {
    throw new Error( `Project folder "${fromSlug}" not found.` );
  }

  const destExists = await access( newPath ).then( () => true, () => false );
  if ( destExists ) {
    throw new Error( `Project "${toSlug}" already exists.` );
  }

  await rename( oldPath, newPath );

  if ( agentWorkingProject === fromSlug ) {
    agentWorkingProject = toSlug;
    disposeAgentSession();
  }

  return { from: fromSlug, to: toSlug };
} );

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
  const targetProject = resolveProjectName( payload.project );

  if ( !output?.markdown || !output.title || !output.url ) {
    throw new Error( result.error ?? 'Workflow completed without markdown output.' );
  }

  const projectDir = getProjectContentDir( targetProject );
  await mkdir( projectDir, { recursive: true } );
  const fileName = createMarkdownFileName( output.title );
  const filePath = path.join( projectDir, fileName );
  await writeFile( filePath, output.markdown, 'utf8' );

  try {
    await mem0Request( '/memories', {
      method: 'POST',
      body: JSON.stringify( {
        messages: [
          { role: 'user', content: `# ${output.title}\nSource: ${output.url}\n\n${output.markdown.slice( 0, 3000 )}` }
        ],
        user_id: projectUserId( payload.project ),
        infer: false,
        metadata: {
          project: targetProject,
          source_type: 'article',
          source_url: output.url,
          file_path: filePath,
          title: output.title,
          tags: 'ingested'
        }
      } )
    } );
  } catch ( err ) {
    console.warn( '[mem0] Failed to store memory for ingested article:', err );
  }

  return {
    workflowId,
    title: output.title,
    url: output.url,
    markdown: output.markdown,
    tokenCount: output.tokenCount ?? null,
    filePath,
    project: targetProject
  };
} );

ipcMain.handle( 'content:read-file', async ( _event, payload: { filePath: string } ) => {
  if ( !projectsRoot ) {
    throw new Error( 'Projects are not initialised yet.' );
  }

  const target = payload.filePath;
  if ( !target || typeof target !== 'string' ) {
    throw new Error( 'filePath is required.' );
  }

  if ( !isPathInsideProjectsRoot( target ) ) {
    throw new Error( 'Access denied.' );
  }

  return readFile( path.resolve( target ), 'utf8' );
} );

ipcMain.handle( 'content:write-file', async ( _event, payload: { filePath: string; markdown: string } ) => {
  if ( !projectsRoot ) {
    throw new Error( 'Projects are not initialised yet.' );
  }

  const target = payload.filePath;
  if ( !target || typeof target !== 'string' ) {
    throw new Error( 'filePath is required.' );
  }

  if ( typeof payload.markdown !== 'string' ) {
    throw new Error( 'markdown is required.' );
  }

  if ( !isPathInsideProjectsRoot( target ) ) {
    throw new Error( 'Access denied.' );
  }

  const resolvedPath = path.resolve( target );
  await writeFile( resolvedPath, payload.markdown, 'utf8' );
  return { saved: true, filePath: resolvedPath };
} );

ipcMain.handle( 'content:create-memory-file', async ( _event, payload: { markdown: string; project?: string } ) => {
  if ( !projectsRoot ) {
    throw new Error( 'Projects are not initialised yet.' );
  }

  if ( typeof payload.markdown !== 'string' || !payload.markdown.trim() ) {
    throw new Error( 'markdown is required.' );
  }

  const project = resolveProjectName( payload.project );
  const projectDir = getProjectContentDir( project );
  await mkdir( projectDir, { recursive: true } );
  const title = deriveManualMemoryTitle( payload.markdown );
  const filePath = await createUniqueMarkdownPath( projectDir, title );
  await writeFile( filePath, payload.markdown, 'utf8' );

  const summary = summarizeMarkdownForMemory( payload.markdown );

  try {
    await mem0Request( '/memories', {
      method: 'POST',
      body: JSON.stringify( {
        messages: [
          { role: 'user', content: `# ${title}\n\n${payload.markdown.slice( 0, 3000 )}` }
        ],
        user_id: projectUserId( payload.project ),
        infer: false,
        metadata: {
          project,
          source_type: 'note',
          file_path: filePath,
          title,
          tags: 'manual,note'
        }
      } )
    } );
  } catch ( err ) {
    console.warn( '[mem0] Failed to store memory for note:', err );
  }

  return {
    project,
    title,
    filePath,
    markdown: payload.markdown,
    memory: summary
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
  return mem0Request( `/memories?user_id=${encodeURIComponent( projectUserId( payload.project ) )}` );
} );

ipcMain.handle( 'mem0:search', async ( _event, payload: { project: string; query: string } ) => {
  return mem0Request( '/search', {
    method: 'POST',
    body: JSON.stringify( {
      query: payload.query,
      user_id: projectUserId( payload.project ),
      limit: 20
    } )
  } );
} );

ipcMain.handle( 'mem0:add-memory', async ( _event, payload: { project: string; content: string; metadata?: Record<string, string> } ) => {
  const projectSlug = resolveProjectName( payload.project );
  return mem0Request( '/memories', {
    method: 'POST',
    body: JSON.stringify( {
      messages: [
        { role: 'user', content: payload.content }
      ],
      user_id: projectUserId( payload.project ),
      metadata: {
        source_type: 'manual',
        ...( payload.metadata ?? {} ),
        project: projectSlug
      }
    } )
  } );
} );

ipcMain.handle( 'mem0:delete-memory', async ( _event, payload: { memoryId: string } ) => {
  await mem0Request( `/memories/${encodeURIComponent( payload.memoryId )}`, {
    method: 'DELETE'
  } );
  await neo4jCascadeDetachMemory( payload.memoryId );
  return { deleted: true };
} );

ipcMain.handle( 'mem0:delete-project', async ( _event, payload: { project: string } ) => {
  const uid = projectUserId( payload.project );
  let memoryIds: string[] = [];
  try {
    const list = await mem0Request<{ results?: Array<{ id: string }> }>(
      `/memories?user_id=${encodeURIComponent( uid )}`
    );
    memoryIds = ( list.results ?? [] ).map( m => m.id );
  } catch {
    // Still delete via Mem0; graph cascade may be incomplete if listing failed or is paginated.
  }

  await mem0Request( `/memories?user_id=${encodeURIComponent( uid )}`, {
    method: 'DELETE'
  } );

  for ( const id of memoryIds ) {
    await neo4jCascadeDetachMemory( id );
  }

  const slug = resolveProjectName( payload.project );

  if ( slug !== UNASSIGNED_PROJECT ) {
    await rm( getProjectContentDir( slug ), { recursive: true, force: true } ).catch( () => {} );
  }

  return { deleted: true };
} );

// ── Pi Agent handlers ────────────────────────────────────────────────────────

function sendToRenderer( channel: string, data: unknown ) {
  if ( mainWindow && !mainWindow.isDestroyed() ) {
    mainWindow.webContents.send( channel, data );
  }
}

function serializeEvent( event: AgentSessionEvent ): Record<string, unknown> {
  const base: Record<string, unknown> = { type: event.type };

  switch ( event.type ) {
    case 'message_update': {
      const delta = event.assistantMessageEvent;
      base.eventType = delta.type;
      if ( 'delta' in delta ) base.delta = delta.delta;
      if ( 'content' in delta ) base.content = delta.content;
      if ( 'thinking' in delta ) base.thinking = delta.thinking;
      if ( 'toolCall' in delta ) base.toolCall = delta.toolCall;
      break;
    }
    case 'tool_execution_start':
      base.toolCallId = event.toolCallId;
      base.toolName = event.toolName;
      base.args = event.args;
      break;
    case 'tool_execution_update':
      base.toolCallId = event.toolCallId;
      base.toolName = event.toolName;
      if ( event.partialResult ) {
        const text = event.partialResult.content
          ?.filter( ( c: { type: string } ) => c.type === 'text' )
          .map( ( c: { text: string } ) => c.text )
          .join( '' );
        base.partialText = text;
      }
      break;
    case 'tool_execution_end':
      base.toolCallId = event.toolCallId;
      base.toolName = event.toolName;
      base.isError = event.isError;
      if ( event.result ) {
        const text = event.result.content
          ?.filter( ( c: { type: string } ) => c.type === 'text' )
          .map( ( c: { text: string } ) => c.text )
          .join( '' );
        base.resultText = text;
      }
      break;
    case 'agent_start':
    case 'agent_end':
    case 'turn_start':
    case 'turn_end':
    case 'message_start':
    case 'message_end':
    case 'compaction_start':
    case 'compaction_end':
      break;
  }

  return base;
}

async function initAgentSession() {
  if ( agentSession ) return;

  const cwd = getProjectContentDir( agentWorkingProject );
  await mkdir( cwd, { recursive: true } );

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create( authStorage );

  const skillBaseDir = path.join( __dirname, '..', 'skills', 'brainstorming' );
  const skillFilePath = path.join( skillBaseDir, 'SKILL.md' );
  const brainstormingSkill: Skill = {
    name: 'brainstorming',
    description: 'Explores user intent, requirements and design before implementation through collaborative dialogue.',
    filePath: skillFilePath,
    baseDir: skillBaseDir,
    sourceInfo: createSyntheticSourceInfo( skillFilePath, { source: 'open-pouch', scope: 'project' } ),
    disableModelInvocation: false
  };

  const resourceLoader = new DefaultResourceLoader( {
    cwd,
    skillsOverride: ( current ) => ( {
      skills: [ ...current.skills, brainstormingSkill ],
      diagnostics: current.diagnostics
    } )
  } );
  await resourceLoader.reload();

  const { session } = await createAgentSession( {
    cwd,
    tools: codingTools,
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    resourceLoader
  } );

  agentSession = session;

  agentUnsubscribe = session.subscribe( ( event: AgentSessionEvent ) => {
    sendToRenderer( 'agent:event', serializeEvent( event ) );
  } );
}

ipcMain.handle( 'agent:init', async ( _event, payload?: { project?: string } ) => {
  try {
    if ( payload?.project !== undefined ) {
      agentWorkingProject = resolveProjectName( payload.project );
    }

    disposeAgentSession();
    await initAgentSession();
    return {
      ok: true,
      contentDir: getProjectContentDir( agentWorkingProject ),
      project: agentWorkingProject
    };
  } catch ( error ) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to initialise agent.'
    };
  }
} );

ipcMain.handle( 'agent:set-project', async ( _event, payload: { project: string } ) => {
  const target = resolveProjectName( payload.project );

  if ( target === agentWorkingProject && agentSession ) {
    return {
      ok: true,
      contentDir: getProjectContentDir( agentWorkingProject ),
      project: agentWorkingProject
    };
  }

  try {
    agentWorkingProject = target;
    disposeAgentSession();
    await initAgentSession();
    return {
      ok: true,
      contentDir: getProjectContentDir( agentWorkingProject ),
      project: agentWorkingProject
    };
  } catch ( error ) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to switch agent project.'
    };
  }
} );

ipcMain.handle( 'agent:prompt', async ( _event, payload: { message: string } ) => {
  if ( !agentSession ) {
    await initAgentSession();
  }

  try {
    await agentSession!.prompt( payload.message );
    return { ok: true };
  } catch ( error ) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Agent prompt failed.'
    };
  }
} );

ipcMain.handle( 'agent:abort', async () => {
  if ( agentSession ) {
    await agentSession.abort();
  }
  return { ok: true };
} );

ipcMain.handle( 'agent:clear', async () => {
  disposeAgentSession();

  try {
    await initAgentSession();
    return {
      ok: true,
      contentDir: getProjectContentDir( agentWorkingProject ),
      project: agentWorkingProject
    };
  } catch ( error ) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to create new session.'
    };
  }
} );

ipcMain.handle( 'agent:get-content-dir', () => ( {
  contentDir: getProjectContentDir( agentWorkingProject ),
  project: agentWorkingProject
} ) );

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

app.on( 'before-quit', () => {
  disposeAgentSession();
} );
