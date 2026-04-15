const api = window.openPouchDesktop;

// ── State ───────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'openpouch:projects';
const UNASSIGNED_PROJECT = 'unassigned';
let projects = normalizeProjects( JSON.parse( localStorage.getItem( STORAGE_KEY ) || '[]' ) );
let activeProject = null;
let currentTab = 'memories';
let searchTimeout = null;
let agentStreaming = false;
let chatMessages = [];

function normalizeProjects( list ) {
  const items = Array.isArray( list )
    ? list
      .filter( Boolean )
      .map( project => project === 'default' ? UNASSIGNED_PROJECT : project )
    : [];
  return Array.from( new Set( [ UNASSIGNED_PROJECT, ...items.filter( project => project !== UNASSIGNED_PROJECT ) ] ) );
}

function saveProjects() {
  projects = normalizeProjects( projects );
  localStorage.setItem( STORAGE_KEY, JSON.stringify( projects ) );
}

// ── DOM refs ────────────────────────────────────────────────────────────────

const $ = ( sel ) => document.querySelector( sel );
const projectListEl = $( '#project-list' );
const noProjectsEl = $( '#no-projects' );
const currentProjectName = $( '#current-project-name' );
const memoryListEl = $( '#memory-list' );
const emptyMemoriesEl = $( '#empty-memories' );
const memoryCountEl = $( '#memory-count' );
const searchInput = $( '#search-input' );

const tabMemories = $( '#tab-memories' );
const tabIngest = $( '#tab-ingest' );
const btnTabMemories = $( '#btn-tab-memories' );
const btnTabIngest = $( '#btn-tab-ingest' );

const mem0Dot = $( '#mem0-dot' );
const mem0Label = $( '#mem0-label' );

const modalAddMemory = $( '#modal-add-memory' );
const memoryContentInput = $( '#memory-content-input' );
const modalNewProject = $( '#modal-new-project' );
const projectNameInput = $( '#project-name-input' );

// Doc viewer (inline, replaces modal)
const docViewer = $( '#doc-viewer' );
const docViewerTitle = $( '#doc-viewer-title' );
const docViewerPath = $( '#doc-viewer-path' );
const docViewerBody = $( '#doc-viewer-body' );
const docViewerError = $( '#doc-viewer-error' );
const btnCloseDoc = $( '#btn-close-doc' );

const ingestForm = $( '#ingest-form' );
const urlInput = $( '#url-input' );
const btnIngest = $( '#btn-ingest' );
const ingestStatus = $( '#ingest-status' );
const ingestResult = $( '#ingest-result' );
const ingestTitle = $( '#ingest-title' );
const ingestMeta = $( '#ingest-meta' );
const ingestMarkdown = $( '#ingest-markdown' );
const ingestProjectBadge = $( '#ingest-project-badge' );
const ingestProjectName = $( '#ingest-project-name' );
const ingestNoProject = $( '#ingest-no-project' );

// Chat panel
const chatMessagesEl = $( '#chat-messages' );
const chatEmptyEl = $( '#chat-empty' );
const chatForm = $( '#chat-form' );
const chatInput = $( '#chat-input' );
const btnChatSend = $( '#btn-chat-send' );
const agentDot = $( '#agent-dot' );
const agentLabel = $( '#agent-label' );

function formatIngestMeta( payload ) {
  const parts = [ payload.url ];

  if ( payload.tokenCount != null ) {
    parts.push( `${payload.tokenCount} tokens` );
  }

  if ( payload.filePath ) {
    parts.push( `saved to ${payload.filePath}` );
  }

  parts.push( `run ${payload.workflowId}` );

  return parts.join( ' · ' );
}

// ── Tab switching ───────────────────────────────────────────────────────────

function switchTab( tab ) {
  currentTab = tab;
  tabMemories.classList.toggle( 'hidden', tab !== 'memories' );
  tabIngest.classList.toggle( 'hidden', tab !== 'ingest' );
  docViewer.classList.add( 'hidden' );
  docViewer.classList.remove( 'flex' );
  btnTabMemories.classList.toggle( 'tab-active', tab === 'memories' );
  btnTabIngest.classList.toggle( 'tab-active', tab === 'ingest' );
}

btnTabMemories.addEventListener( 'click', () => switchTab( 'memories' ) );
btnTabIngest.addEventListener( 'click', () => switchTab( 'ingest' ) );

// ── Inline document viewer ──────────────────────────────────────────────────

function closeDocViewer() {
  docViewer.classList.add( 'hidden' );
  docViewer.classList.remove( 'flex' );
  docViewerError.classList.add( 'hidden' );
  docViewerBody.innerHTML = '';
  tabMemories.classList.remove( 'hidden' );
}

function openDocViewer() {
  tabMemories.classList.add( 'hidden' );
  tabIngest.classList.add( 'hidden' );
  docViewer.classList.remove( 'hidden' );
  docViewer.classList.add( 'flex' );
}

async function showDocumentFromFile( mem ) {
  const filePath = mem.metadata?.file_path;
  if ( !filePath || typeof api.readFile !== 'function' ) return;

  openDocViewer();
  docViewerTitle.textContent = mem.metadata?.title || mem.memory;
  docViewerPath.textContent = filePath;
  docViewerBody.innerHTML = '<p class="text-muted-foreground">Loading…</p>';
  docViewerError.classList.add( 'hidden' );

  try {
    const markdown = await api.readFile( filePath );
    if ( api.renderMarkdown ) {
      docViewerBody.innerHTML = await api.renderMarkdown( markdown );
    } else {
      docViewerBody.textContent = markdown;
    }
  } catch ( err ) {
    docViewerError.textContent = err instanceof Error ? err.message : String( err );
    docViewerError.classList.remove( 'hidden' );
    docViewerBody.innerHTML = '';
  }
}

btnCloseDoc.addEventListener( 'click', closeDocViewer );

// ── Project rendering ───────────────────────────────────────────────────────

function renderProjects() {
  const items = projectListEl.querySelectorAll( '.project-item' );
  items.forEach( el => el.remove() );
  noProjectsEl.classList.toggle( 'hidden', projects.length > 0 );

  projects.forEach( name => {
    const btn = document.createElement( 'button' );
    btn.className = `project-item group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${
      name === activeProject
        ? 'bg-primary/15 text-primary'
        : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
    }`;
    const canDelete = name !== UNASSIGNED_PROJECT;
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="shrink-0 opacity-60"><path d="M2 5l5-3 5 3v6l-5 3-5-3z"/><path d="M7 2v12"/><path d="M2 5l5 3 5-3"/></svg>
      <span class="flex-1 truncate">${name}</span>
      ${canDelete ? '<svg class="delete-project hidden h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition hover:text-destructive group-hover:block" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>' : '<span class="rounded-md bg-muted/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">unassigned</span>'}
    `;

    const deleteBtn = btn.querySelector( '.delete-project' );
    if ( deleteBtn ) {
      deleteBtn.addEventListener( 'click', async ( e ) => {
        e.stopPropagation();
        if ( !confirm( `Delete project "${name}" and all its memories?` ) ) return;
        try {
          await api.deleteProject( name );
        } catch { /* best effort */ }
        projects = normalizeProjects( projects.filter( p => p !== name ) );
        saveProjects();
        if ( activeProject === name ) {
          activeProject = projects[0] || null;
        }
        renderProjects();
        loadMemories();
      } );
    }

    btn.addEventListener( 'click', () => {
      activeProject = name;
      renderProjects();
      loadMemories();
    } );

    projectListEl.appendChild( btn );
  } );

  currentProjectName.textContent = activeProject || 'Select a project';
  updateIngestBadge();
}

// ── Memory rendering ────────────────────────────────────────────────────────

function formatDate( dateStr ) {
  if ( !dateStr ) return '';
  const d = new Date( dateStr );
  return d.toLocaleDateString( 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } );
}

function renderMemories( memories, relations ) {
  const cards = memoryListEl.querySelectorAll( '.memory-card' );
  cards.forEach( el => el.remove() );
  const relSection = memoryListEl.querySelector( '.relations-section' );
  if ( relSection ) relSection.remove();

  const hasMemories = ( memories && memories.length > 0 );
  const hasRelations = ( relations && relations.length > 0 );
  emptyMemoriesEl.classList.toggle( 'hidden', hasMemories || hasRelations );

  if ( hasMemories ) {
    memories.forEach( mem => {
      const hasStoredFile = Boolean( mem.metadata?.file_path );
      const card = document.createElement( 'div' );
      card.className = `memory-card group flex items-start gap-3 rounded-xl border border-border/50 bg-card/30 px-4 py-3 transition hover:border-border hover:bg-card/60${hasStoredFile ? ' cursor-pointer' : ''}`;
      if ( hasStoredFile ) {
        card.title = 'Click to open full document';
      }
      card.innerHTML = `
        <div class="memory-card-main flex-1 min-w-0">
          <p class="text-sm text-foreground leading-relaxed">${mem.memory}</p>
          <div class="mt-1.5 flex flex-wrap items-center gap-2">
            ${mem.metadata?.source_type ? `<span class="inline-flex rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">${mem.metadata.source_type}</span>` : ''}
            ${mem.metadata?.tags ? mem.metadata.tags.split( ',' ).map( t => `<span class="inline-flex rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary/70">${t.trim()}</span>` ).join( '' ) : ''}
            ${hasStoredFile ? '<span class="inline-flex rounded-md border border-primary/20 bg-primary/5 px-2 py-0.5 text-[10px] font-medium text-primary/90">full document</span>' : ''}
            <span class="text-[10px] text-muted-foreground/50">${formatDate( mem.created_at )}</span>
          </div>
        </div>
        <button class="delete-mem hidden shrink-0 rounded-md p-1 text-muted-foreground/50 transition hover:bg-destructive/10 hover:text-destructive group-hover:block" title="Delete">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>
        </button>
      `;

      if ( hasStoredFile ) {
        card.addEventListener( 'click', () => {
          void showDocumentFromFile( mem );
        } );
      }

      card.querySelector( '.delete-mem' ).addEventListener( 'click', async ( e ) => {
        e.stopPropagation();
        try {
          await api.deleteMemory( mem.id );
          card.remove();
          updateCount();
        } catch ( err ) {
          alert( 'Failed to delete: ' + err.message );
        }
      } );

      memoryListEl.appendChild( card );
    } );
  }

  if ( hasRelations ) {
    const section = document.createElement( 'div' );
    section.className = 'relations-section mt-6';
    section.innerHTML = `
      <p class="mb-3 text-xs font-medium uppercase tracking-widest text-muted-foreground">Knowledge Graph</p>
      <div class="flex flex-wrap gap-2">
        ${relations.map( r => `
          <div class="inline-flex items-center gap-1 rounded-lg border border-border/50 bg-card/30 px-3 py-1.5 text-xs">
            <span class="font-medium text-primary/80">${r.source}</span>
            <span class="text-muted-foreground/50">&rarr;</span>
            <span class="text-muted-foreground">${r.relationship}</span>
            <span class="text-muted-foreground/50">&rarr;</span>
            <span class="font-medium text-purple-300/80">${r.target}</span>
          </div>
        `).join( '' )}
      </div>
    `;
    memoryListEl.appendChild( section );
  }

  updateCount( memories, relations );
}

function updateCount( memories, relations ) {
  const mCount = memories?.length ?? memoryListEl.querySelectorAll( '.memory-card' ).length;
  const rCount = relations?.length ?? 0;
  const parts = [];
  if ( mCount ) parts.push( `${mCount} memor${mCount === 1 ? 'y' : 'ies'}` );
  if ( rCount ) parts.push( `${rCount} relation${rCount === 1 ? '' : 's'}` );
  memoryCountEl.textContent = parts.join( ' · ' ) || '';
}

// ── Load memories ───────────────────────────────────────────────────────────

async function loadMemories() {
  if ( !activeProject ) {
    renderMemories( [], [] );
    return;
  }

  try {
    const data = await api.listMemories( activeProject );
    renderMemories( data.results || [], data.relations || [] );
  } catch ( err ) {
    memoryCountEl.textContent = 'Error loading memories: ' + err.message;
  }
}

// ── Search ──────────────────────────────────────────────────────────────────

searchInput.addEventListener( 'input', () => {
  clearTimeout( searchTimeout );
  const query = searchInput.value.trim();

  if ( !query ) {
    searchTimeout = setTimeout( loadMemories, 200 );
    return;
  }

  searchTimeout = setTimeout( async () => {
    if ( !activeProject ) return;
    try {
      const data = await api.searchMemories( activeProject, query );
      renderMemories( data.results || [], data.relations || [] );
    } catch ( err ) {
      memoryCountEl.textContent = 'Search error: ' + err.message;
    }
  }, 400 );
} );

// ── Add memory modal ────────────────────────────────────────────────────────

$( '#btn-add-memory' ).addEventListener( 'click', () => {
  if ( !activeProject ) {
    alert( 'Select a project first.' );
    return;
  }
  memoryContentInput.value = '';
  modalAddMemory.classList.remove( 'hidden' );
  modalAddMemory.classList.add( 'flex' );
  memoryContentInput.focus();
} );

$( '#btn-cancel-memory' ).addEventListener( 'click', () => {
  modalAddMemory.classList.add( 'hidden' );
  modalAddMemory.classList.remove( 'flex' );
} );

$( '#btn-save-memory' ).addEventListener( 'click', async () => {
  const content = memoryContentInput.value.trim();
  if ( !content || !activeProject ) return;

  const btn = $( '#btn-save-memory' );
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    await api.addMemory( activeProject, content );
    modalAddMemory.classList.add( 'hidden' );
    modalAddMemory.classList.remove( 'flex' );
    await loadMemories();
  } catch ( err ) {
    alert( 'Failed to save: ' + err.message );
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Memory';
  }
} );

// ── New project modal ───────────────────────────────────────────────────────

$( '#btn-new-project' ).addEventListener( 'click', () => {
  projectNameInput.value = '';
  modalNewProject.classList.remove( 'hidden' );
  modalNewProject.classList.add( 'flex' );
  projectNameInput.focus();
} );

$( '#btn-cancel-project' ).addEventListener( 'click', () => {
  modalNewProject.classList.add( 'hidden' );
  modalNewProject.classList.remove( 'flex' );
} );

$( '#btn-create-project' ).addEventListener( 'click', () => {
  const name = projectNameInput.value.trim().toLowerCase().replace( /[^a-z0-9_-]/g, '-' );
  if ( !name ) return;
  if ( name === 'default' ) {
    alert( `"default" is now "${UNASSIGNED_PROJECT}". Use that built-in project instead.` );
    return;
  }
  if ( projects.includes( name ) ) {
    alert( 'Project already exists.' );
    return;
  }

  projects.push( name );
  saveProjects();
  activeProject = name;
  modalNewProject.classList.add( 'hidden' );
  modalNewProject.classList.remove( 'flex' );
  renderProjects();
  loadMemories();
} );

projectNameInput.addEventListener( 'keydown', ( e ) => {
  if ( e.key === 'Enter' ) $( '#btn-create-project' ).click();
} );

// ── Ingest URL ──────────────────────────────────────────────────────────────

function updateIngestBadge() {
  if ( activeProject ) {
    ingestProjectBadge.classList.remove( 'hidden' );
    ingestProjectBadge.classList.add( 'flex' );
    ingestProjectName.textContent = activeProject;
    ingestNoProject.classList.add( 'hidden' );
    ingestNoProject.classList.remove( 'flex' );
  } else {
    ingestProjectBadge.classList.add( 'hidden' );
    ingestProjectBadge.classList.remove( 'flex' );
    ingestNoProject.classList.remove( 'hidden' );
    ingestNoProject.classList.add( 'flex' );
  }
}

ingestForm.addEventListener( 'submit', async ( e ) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if ( !url ) {
    ingestStatus.textContent = 'Enter a URL.';
    return;
  }

  btnIngest.disabled = true;
  btnIngest.textContent = 'Ingesting...';
  ingestStatus.textContent = `Running generic ingest for "${activeProject || UNASSIGNED_PROJECT}"...`;
  ingestResult.classList.add( 'hidden' );
  ingestResult.classList.remove( 'flex' );

  try {
    const payload = await api.ingestUrl( url, activeProject || undefined );
    ingestTitle.textContent = payload.title;
    ingestMeta.textContent = formatIngestMeta( payload );

    if ( api.renderMarkdown ) {
      ingestMarkdown.innerHTML = await api.renderMarkdown( payload.markdown );
    } else {
      ingestMarkdown.textContent = payload.markdown;
    }

    ingestResult.classList.remove( 'hidden' );
    ingestResult.classList.add( 'flex' );
    ingestStatus.textContent = `Ingest complete. Markdown saved locally and memory added to "${payload.project || UNASSIGNED_PROJECT}".`;

    if ( !projects.includes( payload.project ) ) {
      projects.push( payload.project );
      saveProjects();
      renderProjects();
    }

    setTimeout( loadMemories, 1000 );
  } catch ( err ) {
    ingestStatus.textContent = err.message;
  } finally {
    btnIngest.disabled = false;
    btnIngest.textContent = 'Ingest URL';
  }
} );

// ── Chat: Pi Agent ──────────────────────────────────────────────────────────

function escapeHtml( str ) {
  const div = document.createElement( 'div' );
  div.textContent = str;
  return div.innerHTML;
}

function setAgentStatus( status, color ) {
  agentDot.className = `h-1.5 w-1.5 rounded-full ${color}`;
  agentLabel.textContent = status;
}

function addChatMessage( role, content ) {
  chatEmptyEl.classList.add( 'hidden' );

  const id = `msg-${Date.now()}-${Math.random().toString( 36 ).slice( 2, 6 )}`;

  const wrapper = document.createElement( 'div' );
  wrapper.id = id;
  wrapper.className = `chat-message ${role === 'user' ? 'chat-msg-user' : 'chat-msg-assistant'} mb-3`;

  if ( role === 'user' ) {
    wrapper.innerHTML = `
      <div class="ml-8 rounded-xl bg-primary/10 px-4 py-2.5">
        <p class="text-sm text-foreground whitespace-pre-wrap">${escapeHtml( content )}</p>
      </div>
    `;
  } else {
    wrapper.innerHTML = `
      <div class="mr-8 rounded-xl border border-border/50 bg-card/40 px-4 py-2.5">
        <p class="chat-text text-sm text-foreground leading-relaxed whitespace-pre-wrap">${content || ''}</p>
      </div>
    `;
  }

  chatMessagesEl.appendChild( wrapper );
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

  chatMessages.push( { id, role, content } );
  return id;
}

function appendToLastAssistant( text ) {
  const lastMsg = chatMessagesEl.querySelector( '.chat-msg-assistant:last-of-type .chat-text' );
  if ( lastMsg ) {
    lastMsg.textContent += text;
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }
}

function addToolCard( toolName, args, toolCallId ) {
  chatEmptyEl.classList.add( 'hidden' );

  const card = document.createElement( 'div' );
  card.id = `tool-${toolCallId}`;
  card.className = 'chat-tool-card mb-2 rounded-lg border border-border/50 bg-card/20 text-xs overflow-hidden';

  let argsPreview = '';
  if ( args ) {
    if ( toolName === 'bash' && args.command ) {
      argsPreview = args.command;
    } else if ( toolName === 'read' && args.path ) {
      argsPreview = args.path;
    } else if ( toolName === 'edit' && args.path ) {
      argsPreview = args.path;
    } else if ( toolName === 'write' && args.path ) {
      argsPreview = args.path;
    } else {
      argsPreview = JSON.stringify( args ).slice( 0, 120 );
    }
  }

  card.innerHTML = `
    <div class="tool-card-header flex items-center gap-2 px-3 py-2 cursor-pointer select-none" title="Click to expand">
      <span class="tool-icon flex h-5 w-5 items-center justify-center rounded bg-primary/10 text-[10px] font-bold text-primary">${toolName.charAt( 0 ).toUpperCase()}</span>
      <span class="font-medium text-muted-foreground">${escapeHtml( toolName )}</span>
      <span class="flex-1 truncate text-muted-foreground/60">${escapeHtml( argsPreview )}</span>
      <span class="tool-status text-[10px] text-amber-400">running</span>
    </div>
    <div class="tool-card-body hidden border-t border-border/30 bg-background/50">
      <pre class="tool-output max-h-48 overflow-auto px-3 py-2 text-[11px] leading-relaxed text-muted-foreground font-mono whitespace-pre-wrap"></pre>
    </div>
  `;

  card.querySelector( '.tool-card-header' ).addEventListener( 'click', () => {
    const body = card.querySelector( '.tool-card-body' );
    body.classList.toggle( 'hidden' );
  } );

  chatMessagesEl.appendChild( card );
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function updateToolCard( toolCallId, partialText ) {
  const card = chatMessagesEl.querySelector( `#tool-${toolCallId}` );
  if ( !card ) return;
  const output = card.querySelector( '.tool-output' );
  if ( output && partialText ) {
    output.textContent = partialText;
  }
}

function finalizeToolCard( toolCallId, resultText, isError ) {
  const card = chatMessagesEl.querySelector( `#tool-${toolCallId}` );
  if ( !card ) return;

  const status = card.querySelector( '.tool-status' );
  if ( status ) {
    status.textContent = isError ? 'error' : 'done';
    status.className = `tool-status text-[10px] ${isError ? 'text-destructive' : 'text-emerald-400'}`;
  }

  const output = card.querySelector( '.tool-output' );
  if ( output && resultText ) {
    output.textContent = resultText.length > 2000 ? resultText.slice( 0, 2000 ) + '\n…truncated' : resultText;
  }
}

let currentAssistantMsgId = null;

function handleAgentEvent( event ) {
  switch ( event.type ) {
    case 'agent_start':
      agentStreaming = true;
      setAgentStatus( 'Thinking…', 'bg-amber-400 animate-pulse' );
      btnChatSend.disabled = true;
      break;

    case 'message_update':
      if ( event.eventType === 'text_delta' && event.delta ) {
        if ( !currentAssistantMsgId ) {
          currentAssistantMsgId = addChatMessage( 'assistant', '' );
        }
        appendToLastAssistant( event.delta );
      }
      if ( event.eventType === 'text_start' ) {
        setAgentStatus( 'Writing…', 'bg-primary animate-pulse' );
      }
      break;

    case 'tool_execution_start':
      setAgentStatus( `Running ${event.toolName}…`, 'bg-amber-400 animate-pulse' );
      addToolCard( event.toolName, event.args, event.toolCallId );
      break;

    case 'tool_execution_update':
      updateToolCard( event.toolCallId, event.partialText );
      break;

    case 'tool_execution_end':
      finalizeToolCard( event.toolCallId, event.resultText, event.isError );
      break;

    case 'message_end':
      currentAssistantMsgId = null;
      break;

    case 'agent_end':
      agentStreaming = false;
      currentAssistantMsgId = null;
      setAgentStatus( 'Idle', 'bg-emerald-400' );
      btnChatSend.disabled = false;
      chatInput.focus();
      break;
  }
}

async function sendChatMessage() {
  const text = chatInput.value.trim();
  if ( !text || agentStreaming ) return;

  chatInput.value = '';
  addChatMessage( 'user', text );

  const result = await api.agentPrompt( text );
  if ( !result.ok ) {
    addChatMessage( 'assistant', `Error: ${result.error}` );
    setAgentStatus( 'Error', 'bg-destructive' );
    btnChatSend.disabled = false;
  }
}

chatForm.addEventListener( 'submit', ( e ) => {
  e.preventDefault();
  void sendChatMessage();
} );

chatInput.addEventListener( 'keydown', ( e ) => {
  if ( e.key === 'Enter' && !e.shiftKey ) {
    e.preventDefault();
    void sendChatMessage();
  }
} );

// ── Health checks ───────────────────────────────────────────────────────────

async function checkHealth() {
  try {
    const mem0 = await api.mem0Health();
    if ( mem0.ok ) {
      mem0Dot.className = 'h-1.5 w-1.5 rounded-full bg-emerald-400';
      mem0Label.textContent = 'Memory connected';
    } else {
      mem0Dot.className = 'h-1.5 w-1.5 rounded-full bg-amber-400';
      mem0Label.textContent = 'Memory unavailable';
    }
  } catch {
    mem0Dot.className = 'h-1.5 w-1.5 rounded-full bg-red-400';
    mem0Label.textContent = 'Memory offline';
  }
}

async function initAgent() {
  try {
    const result = await api.agentInit();
    if ( result.ok ) {
      setAgentStatus( 'Ready', 'bg-emerald-400' );
    } else {
      setAgentStatus( 'No API key', 'bg-amber-400' );
    }
  } catch {
    setAgentStatus( 'Offline', 'bg-muted-foreground' );
  }
}

// ── Keyboard shortcuts ──────────────────────────────────────────────────────

document.addEventListener( 'keydown', ( e ) => {
  if ( e.key === 'Escape' ) {
    modalAddMemory.classList.add( 'hidden' );
    modalAddMemory.classList.remove( 'flex' );
    modalNewProject.classList.add( 'hidden' );
    modalNewProject.classList.remove( 'flex' );
    if ( docViewer.classList.contains( 'flex' ) ) {
      closeDocViewer();
    }
    if ( agentStreaming ) {
      void api.agentAbort();
    }
  }

  if ( ( e.metaKey || e.ctrlKey ) && e.key === 'k' ) {
    e.preventDefault();
    searchInput.focus();
    switchTab( 'memories' );
  }

  if ( ( e.metaKey || e.ctrlKey ) && e.key === 'n' ) {
    e.preventDefault();
    $( '#btn-new-project' ).click();
  }

  if ( ( e.metaKey || e.ctrlKey ) && e.key === 'l' ) {
    e.preventDefault();
    chatInput.focus();
  }
} );

// ── Init ────────────────────────────────────────────────────────────────────

if ( projects.length > 0 ) {
  activeProject = projects[0];
}

renderProjects();
loadMemories();
checkHealth();
initAgent();

if ( api.onAgentEvent ) {
  api.onAgentEvent( handleAgentEvent );
}
