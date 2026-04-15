import { contextBridge, ipcRenderer } from 'electron';
import { parse as markedParse } from 'marked';

contextBridge.exposeInMainWorld( 'openPouchDesktop', {
  parseMarkdown: ( md: string ) => markedParse( md, { async: false } ) as string,
  getConfig: () => ipcRenderer.invoke( 'output:get-config' ),
  getHealth: () => ipcRenderer.invoke( 'output:health' ),
  ingestUrl: ( url: string, project?: string ) => ipcRenderer.invoke( 'output:ingest-url', { url, project } ),
  renderMarkdown: ( markdown: string ) => ipcRenderer.invoke( 'output:render-markdown', { markdown } ),
  readFile: ( filePath: string ) => ipcRenderer.invoke( 'content:read-file', { filePath } ),
  writeFile: ( filePath: string, markdown: string ) => ipcRenderer.invoke( 'content:write-file', { filePath, markdown } ),

  mem0Health: () => ipcRenderer.invoke( 'mem0:health' ),
  listMemories: ( project: string ) => ipcRenderer.invoke( 'mem0:list-memories', { project } ),
  searchMemories: ( project: string, query: string ) => ipcRenderer.invoke( 'mem0:search', { project, query } ),
  addMemory: ( project: string, content: string, metadata?: Record<string, string> ) => ipcRenderer.invoke( 'mem0:add-memory', { project, content, metadata } ),
  deleteMemory: ( memoryId: string ) => ipcRenderer.invoke( 'mem0:delete-memory', { memoryId } ),
  deleteProject: ( project: string ) => ipcRenderer.invoke( 'mem0:delete-project', { project } ),

  agentInit: () => ipcRenderer.invoke( 'agent:init' ),
  agentPrompt: ( message: string ) => ipcRenderer.invoke( 'agent:prompt', { message } ),
  agentAbort: () => ipcRenderer.invoke( 'agent:abort' ),
  agentClear: () => ipcRenderer.invoke( 'agent:clear' ),
  agentGetContentDir: () => ipcRenderer.invoke( 'agent:get-content-dir' ),
  onAgentEvent: ( callback: ( event: unknown ) => void ) => {
    const handler = ( _ipcEvent: Electron.IpcRendererEvent, data: unknown ) => callback( data );
    ipcRenderer.on( 'agent:event', handler );
    return () => ipcRenderer.removeListener( 'agent:event', handler );
  }
} );
