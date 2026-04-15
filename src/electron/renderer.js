import { Crepe } from '@milkdown/crepe';
import { marked } from 'marked';

const api = window.openPouchDesktop;

// ── State ───────────────────────────────────────────────────────────────────

const UNASSIGNED_PROJECT = 'unassigned';
let projects = [];
let activeProject = null;
let currentTab = 'memories';
let searchTimeout = null;
let agentStreaming = false;
let chatMessages = [];
let docEditor = null;
let activeDocument = null;

function normalizeProjects( list ) {
  const items = Array.isArray( list )
    ? list
      .filter( Boolean )
      .map( project => project === 'default' ? UNASSIGNED_PROJECT : project )
    : [];
  return Array.from( new Set( [ UNASSIGNED_PROJECT, ...items.filter( project => project !== UNASSIGNED_PROJECT ) ] ) );
}

async function refreshProjectsFromFs() {
  const list = await api.listProjects();
  projects = normalizeProjects( list );
}

async function syncAgentToProject( slug ) {
  if ( typeof api.agentSetProject !== 'function' || !slug ) {
    return;
  }

  try {
    await api.agentSetProject( slug );
  } catch {
    // Best effort — agent may not be initialised yet
  }
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
const memoryContentInput = $( '#memory-content-input' );
const memoryCreateStatus = $( '#memory-create-status' );
const btnCreateMemoryFile = $( '#btn-create-memory-file' );
const memoryIngestUrlInput = $( '#memory-ingest-url-input' );
const btnMemoryIngest = $( '#btn-memory-ingest' );
const memoryIngestStatus = $( '#memory-ingest-status' );

const tabMemories = $( '#tab-memories' );
const tabIngest = $( '#tab-ingest' );
const btnTabMemories = $( '#btn-tab-memories' );
const btnTabIngest = $( '#btn-tab-ingest' );

const mem0Dot = $( '#mem0-dot' );
const mem0Label = $( '#mem0-label' );

const modalNewProject = $( '#modal-new-project' );
const projectNameInput = $( '#project-name-input' );

// Doc viewer (inline, replaces modal)
const docViewer = $( '#doc-viewer' );
const docViewerTitle = $( '#doc-viewer-title' );
const docViewerPath = $( '#doc-viewer-path' );
const docViewerBody = $( '#doc-viewer-body' );
const docViewerError = $( '#doc-viewer-error' );
const docSaveStatus = $( '#doc-save-status' );
const btnSaveDoc = $( '#btn-save-doc' );
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
const chatFilePill = $( '#chat-file-pill' );
const chatFileName = $( '#chat-file-name' );
const btnDetachFile = $( '#btn-detach-file' );

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
  if ( !docViewer.classList.contains( 'hidden' ) ) {
    const didClose = closeDocViewer();
    if ( !didClose ) {
      return;
    }
  }

  currentTab = tab;
  tabMemories.classList.toggle( 'hidden', tab !== 'memories' );
  tabIngest.classList.toggle( 'hidden', tab !== 'ingest' );
  btnTabMemories.classList.toggle( 'tab-active', tab === 'memories' );
  btnTabIngest.classList.toggle( 'tab-active', tab === 'ingest' );
}

btnTabMemories.addEventListener( 'click', () => switchTab( 'memories' ) );
btnTabIngest.addEventListener( 'click', () => switchTab( 'ingest' ) );

// ── Chat file pill ──────────────────────────────────────────────────────────

let chatAttachedFile = null;

function syncChatFilePill() {
  if ( chatAttachedFile ) {
    const name = chatAttachedFile.title || chatAttachedFile.filePath.split( '/' ).pop();
    chatFileName.textContent = name;
    chatFileName.title = chatAttachedFile.filePath;
    chatFilePill.classList.remove( 'hidden' );
    chatFilePill.classList.add( 'flex' );
  } else {
    chatFilePill.classList.add( 'hidden' );
    chatFilePill.classList.remove( 'flex' );
  }
}

btnDetachFile.addEventListener( 'click', () => {
  chatAttachedFile = null;
  syncChatFilePill();
} );

// ── Inline document viewer ──────────────────────────────────────────────────

function closeDocViewer() {
  if ( activeDocument?.isDirty && !confirm( 'Discard unsaved changes?' ) ) {
    return false;
  }

  docViewer.classList.add( 'hidden' );
  docViewer.classList.remove( 'flex' );
  docViewerError.classList.add( 'hidden' );
  tabMemories.classList.remove( 'hidden' );
  teardownDocEditor();
  activeDocument = null;
  chatAttachedFile = null;
  syncChatFilePill();
  docViewerBody.innerHTML = '';
  setDocStatus( 'Saved' );
  return true;
}

function openDocViewer() {
  tabMemories.classList.add( 'hidden' );
  tabIngest.classList.add( 'hidden' );
  docViewer.classList.remove( 'hidden' );
  docViewer.classList.add( 'flex' );
}

function setDocStatus( message, tone = 'muted' ) {
  docSaveStatus.textContent = message;
  docSaveStatus.className = 'text-[11px]';

  if ( tone === 'error' ) {
    docSaveStatus.classList.add( 'text-destructive' );
    return;
  }

  if ( tone === 'dirty' ) {
    docSaveStatus.classList.add( 'text-primary' );
    return;
  }

  docSaveStatus.classList.add( 'text-muted-foreground' );
}

function syncDocActions() {
  const canSave = Boolean( activeDocument && docEditor && activeDocument.isDirty && !activeDocument.isSaving && typeof api.writeFile === 'function' );
  btnSaveDoc.disabled = !canSave;

  if ( activeDocument?.isSaving ) {
    btnSaveDoc.textContent = 'Saving...';
    setDocStatus( 'Saving changes…' );
    return;
  }

  btnSaveDoc.textContent = 'Save';

  if ( activeDocument?.isDirty ) {
    setDocStatus( 'Unsaved changes', 'dirty' );
    return;
  }

  setDocStatus( 'Saved' );
}

async function teardownDocEditor() {
  if ( !docEditor ) return;

  const editor = docEditor;
  docEditor = null;

  try {
    await editor.destroy();
  } catch {
    // Best effort during teardown.
  }
}

async function mountDocEditor( markdown ) {
  await teardownDocEditor();
  docViewerBody.innerHTML = '';

  const editor = new Crepe( {
    root: docViewerBody,
    defaultValue: markdown
  } );

  editor.on( listener => {
    listener.markdownUpdated( ( _ctx, nextMarkdown ) => {
      if ( !activeDocument || docEditor !== editor ) return;

      activeDocument.currentMarkdown = nextMarkdown;
      activeDocument.isDirty = nextMarkdown !== activeDocument.initialMarkdown;
      syncDocActions();
    } );
  } );

  await editor.create();

  docEditor = editor;

  const normalizedMarkdown = editor.getMarkdown();
  if ( activeDocument ) {
    activeDocument.initialMarkdown = normalizedMarkdown;
    activeDocument.currentMarkdown = normalizedMarkdown;
    activeDocument.isDirty = false;
    activeDocument.isSaving = false;
  }

  syncDocActions();
}

async function saveActiveDocument() {
  if ( !activeDocument || !docEditor || !activeDocument.isDirty || typeof api.writeFile !== 'function' ) {
    return;
  }

  const markdown = docEditor.getMarkdown();
  activeDocument.isSaving = true;
  syncDocActions();
  docViewerError.classList.add( 'hidden' );

  try {
    await api.writeFile( activeDocument.filePath, markdown );
    activeDocument.initialMarkdown = markdown;
    activeDocument.currentMarkdown = markdown;
    activeDocument.isDirty = false;
    setDocStatus( 'Saved just now' );
  } catch ( err ) {
    docViewerError.textContent = err instanceof Error ? err.message : String( err );
    docViewerError.classList.remove( 'hidden' );
    setDocStatus( 'Save failed', 'error' );
  } finally {
    activeDocument.isSaving = false;
    syncDocActions();
  }
}

async function showDocumentFromFile( mem ) {
  const filePath = mem.metadata?.file_path;
  if ( !filePath || typeof api.readFile !== 'function' ) return;

  if ( activeDocument?.isDirty && activeDocument.filePath !== filePath && !confirm( 'Discard unsaved changes and open another document?' ) ) {
    return;
  }

  openDocViewer();
  docViewerTitle.textContent = mem.metadata?.title || mem.memory;
  docViewerPath.textContent = filePath;
  docViewerBody.innerHTML = '<div class="flex h-full items-center justify-center text-sm text-muted-foreground">Loading editor…</div>';
  docViewerError.classList.add( 'hidden' );
  activeDocument = {
    filePath,
    title: mem.metadata?.title || mem.memory,
    initialMarkdown: '',
    currentMarkdown: '',
    isDirty: false,
    isSaving: false
  };
  chatAttachedFile = { filePath, title: mem.metadata?.title || mem.memory };
  syncChatFilePill();
  setDocStatus( 'Loading…' );
  syncDocActions();

  try {
    const markdown = await api.readFile( filePath );
    await mountDocEditor( markdown );
  } catch ( err ) {
    docViewerError.textContent = err instanceof Error ? err.message : String( err );
    docViewerError.classList.remove( 'hidden' );
    docViewerBody.innerHTML = '';
    setDocStatus( 'Open failed', 'error' );
  }
}

btnCloseDoc.addEventListener( 'click', () => {
  closeDocViewer();
} );
btnSaveDoc.addEventListener( 'click', () => {
  void saveActiveDocument();
} );
document.addEventListener( 'keydown', ( e ) => {
  if ( ( e.metaKey || e.ctrlKey ) && e.key.toLowerCase() === 's' && !docViewer.classList.contains( 'hidden' ) ) {
    e.preventDefault();
    void saveActiveDocument();
  }
} );

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
        await refreshProjectsFromFs();
        if ( activeProject === name ) {
          activeProject = projects[0] || null;
        }
        renderProjects();
        void loadMemories();
        if ( activeProject ) {
          void syncAgentToProject( activeProject );
        }
      } );
    }

    btn.addEventListener( 'click', () => {
      activeProject = name;
      renderProjects();
      void loadMemories();
      void syncAgentToProject( name );
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

function setMemoryCreateStatus( message, tone = 'muted' ) {
  memoryCreateStatus.textContent = message;
  memoryCreateStatus.className = 'min-h-5 text-xs';

  if ( tone === 'error' ) {
    memoryCreateStatus.classList.add( 'text-destructive' );
    return;
  }

  if ( tone === 'success' ) {
    memoryCreateStatus.classList.add( 'text-primary' );
    return;
  }

  memoryCreateStatus.classList.add( 'text-muted-foreground' );
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

// ── Memory file composer ────────────────────────────────────────────────────

async function createMemoryFile() {
  const markdown = memoryContentInput.value.trim();
  const targetProject = activeProject || UNASSIGNED_PROJECT;

  if ( !markdown ) {
    setMemoryCreateStatus( 'Write some markdown before creating the note.', 'error' );
    memoryContentInput.focus();
    return;
  }

  btnCreateMemoryFile.disabled = true;
  btnCreateMemoryFile.textContent = 'Creating...';
  setMemoryCreateStatus( `Creating note in "${targetProject}"...` );

  try {
    const created = await api.createMemoryFile( markdown, targetProject );

    await refreshProjectsFromFs();
    activeProject = created.project;
    memoryContentInput.value = '';
    setMemoryCreateStatus( `Saved "${created.title}" and opened it in the editor.`, 'success' );
    renderProjects();
    void syncAgentToProject( created.project );
    await loadMemories();
    await showDocumentFromFile( {
      memory: created.memory,
      metadata: {
        file_path: created.filePath,
        title: created.title,
        source_type: 'note',
        tags: 'manual,note'
      }
    } );
  } catch ( err ) {
    setMemoryCreateStatus( err instanceof Error ? err.message : String( err ), 'error' );
  } finally {
    btnCreateMemoryFile.disabled = false;
    btnCreateMemoryFile.textContent = 'Create Note';
  }
}

btnCreateMemoryFile.addEventListener( 'click', () => {
  void createMemoryFile();
} );

memoryContentInput.addEventListener( 'keydown', ( e ) => {
  if ( ( e.metaKey || e.ctrlKey ) && e.key === 'Enter' ) {
    e.preventDefault();
    void createMemoryFile();
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

$( '#btn-create-project' ).addEventListener( 'click', async () => {
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

  try {
    await api.createProject( name );
  } catch ( err ) {
    alert( err instanceof Error ? err.message : String( err ) );
    return;
  }

  await refreshProjectsFromFs();
  activeProject = name;
  modalNewProject.classList.add( 'hidden' );
  modalNewProject.classList.remove( 'flex' );
  renderProjects();
  void loadMemories();
  void syncAgentToProject( name );
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

async function runIngest( url, options = {} ) {
  if ( !url ) {
    const statusEl = options.statusEl || ingestStatus;
    statusEl.textContent = 'Enter a URL.';
    return;
  }

  const buttonEl = options.buttonEl || btnIngest;
  const statusEl = options.statusEl || ingestStatus;
  const resetLabel = options.buttonLabel || 'Ingest URL';

  buttonEl.disabled = true;
  buttonEl.textContent = 'Ingesting...';
  statusEl.textContent = `Running generic ingest for "${activeProject || UNASSIGNED_PROJECT}"...`;

  if ( !options.inlineOnly ) {
    ingestResult.classList.add( 'hidden' );
    ingestResult.classList.remove( 'flex' );
  }

  try {
    const payload = await api.ingestUrl( url, activeProject || undefined );

    if ( !options.inlineOnly ) {
      ingestTitle.textContent = payload.title;
      ingestMeta.textContent = formatIngestMeta( payload );

      if ( api.renderMarkdown ) {
        ingestMarkdown.innerHTML = await api.renderMarkdown( payload.markdown );
      } else {
        ingestMarkdown.textContent = payload.markdown;
      }

      ingestResult.classList.remove( 'hidden' );
      ingestResult.classList.add( 'flex' );
    }

    statusEl.textContent = `Ingest complete. Markdown saved locally and memory added to "${payload.project || UNASSIGNED_PROJECT}".`;

    try {
      await refreshProjectsFromFs();
    } catch {
      // Listing projects failed — ingest still succeeded
    }

    renderProjects();

    if ( options.inlineOnly ) {
      memoryIngestUrlInput.value = '';
    }

    setTimeout( loadMemories, 1000 );
  } catch ( err ) {
    statusEl.textContent = err.message;
  } finally {
    buttonEl.disabled = false;
    buttonEl.textContent = resetLabel;
  }
}

ingestForm.addEventListener( 'submit', async ( e ) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  await runIngest( url );
} );

btnMemoryIngest.addEventListener( 'click', () => {
  void runIngest( memoryIngestUrlInput.value.trim(), {
    buttonEl: btnMemoryIngest,
    statusEl: memoryIngestStatus,
    inlineOnly: true
  } );
} );

memoryIngestUrlInput.addEventListener( 'keydown', ( e ) => {
  if ( e.key === 'Enter' ) {
    e.preventDefault();
    void runIngest( memoryIngestUrlInput.value.trim(), {
      buttonEl: btnMemoryIngest,
      statusEl: memoryIngestStatus,
      inlineOnly: true
    } );
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
        <div class="chat-text text-sm text-foreground leading-relaxed whitespace-pre-wrap">${content || ''}</div>
      </div>
    `;
  }

  chatMessagesEl.appendChild( wrapper );
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

  chatMessages.push( { id, role, content } );
  return id;
}

let assistantRawBuffer = '';

function renderMarkdownToEl( el, md ) {
  el.innerHTML = marked.parse( md, { async: false } );
  el.classList.remove( 'whitespace-pre-wrap' );
  el.classList.add( 'markdown-body' );
}

function appendToLastAssistant( text ) {
  const lastMsg = chatMessagesEl.querySelector( '.chat-msg-assistant:last-of-type .chat-text' );
  if ( lastMsg ) {
    assistantRawBuffer += text;
    renderMarkdownToEl( lastMsg, assistantRawBuffer );
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }
}

function finalizeLastAssistant() {
  for ( let i = chatMessages.length - 1; i >= 0; i-- ) {
    if ( chatMessages[i].role === 'assistant' ) {
      chatMessages[i].content = assistantRawBuffer;
      break;
    }
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
          assistantRawBuffer = '';
          currentAssistantMsgId = addChatMessage( 'assistant', '' );
        }
        appendToLastAssistant( event.delta );
      }
      if ( event.eventType === 'text_start' ) {
        assistantRawBuffer = '';
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
      finalizeLastAssistant();
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

async function clearChat() {
  if ( agentStreaming ) {
    await api.agentAbort();
  }

  chatMessagesEl.querySelectorAll( '.chat-message, .chat-tool-card' ).forEach( el => el.remove() );
  chatEmptyEl.classList.remove( 'hidden' );
  chatMessages = [];
  currentAssistantMsgId = null;
  agentStreaming = false;

  setAgentStatus( 'Starting…', 'bg-amber-400 animate-pulse' );
  btnChatSend.disabled = true;

  const result = await api.agentClear();
  if ( result.ok ) {
    setAgentStatus( 'Ready', 'bg-emerald-400' );
  } else {
    setAgentStatus( 'Error', 'bg-destructive' );
    addChatMessage( 'assistant', `Failed to start new session: ${result.error}` );
  }

  btnChatSend.disabled = false;
  chatInput.focus();
}

async function sendChatMessage() {
  const text = chatInput.value.trim();
  if ( !text || agentStreaming ) return;

  chatInput.value = '';

  if ( text === '/clear' ) {
    await clearChat();
    return;
  }

  addChatMessage( 'user', text );

  let prompt = text;
  if ( chatAttachedFile ) {
    prompt = `[Attached file: ${chatAttachedFile.filePath}]\n\n${text}`;
  }

  const result = await api.agentPrompt( prompt );
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
    const project = activeProject || UNASSIGNED_PROJECT;
    const result = await api.agentInit( project );
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

setMemoryCreateStatus( 'New notes are saved into the selected project\'s local markdown files.' );

async function bootstrap() {
  try {
    await refreshProjectsFromFs();
  } catch {
    projects = normalizeProjects( [] );
  }

  if ( projects.length > 0 ) {
    activeProject = projects[0];
  }

  renderProjects();
  void loadMemories();
  checkHealth();
  await initAgent();

  if ( api.onAgentEvent ) {
    api.onAgentEvent( handleAgentEvent );
  }
}

void bootstrap();

document.addEventListener( 'visibilitychange', () => {
  if ( document.visibilityState !== 'visible' ) {
    return;
  }

  const previousProject = activeProject;

  void refreshProjectsFromFs()
    .then( () => {
      if ( activeProject && !projects.includes( activeProject ) ) {
        activeProject = projects[0] || null;
      }

      renderProjects();
      void loadMemories();

      if ( activeProject && activeProject !== previousProject ) {
        void syncAgentToProject( activeProject );
      }
    } )
    .catch( () => {} );
} );
