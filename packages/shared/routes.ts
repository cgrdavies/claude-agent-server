/**
 * API route map. Used for documentation and client SDK generation.
 * All routes are prefixed with /api.
 * All routes except /health require Authorization: Bearer <supabase_jwt>.
 */
export const API_ROUTES = {
  // Health
  health: 'GET /health',

  // Projects
  createProject:  'POST   /api/projects',
  listProjects:   'GET    /api/projects',
  getProject:     'GET    /api/projects/:id',
  updateProject:  'PATCH  /api/projects/:id',
  deleteProject:  'DELETE /api/projects/:id',
  restoreProject: 'POST   /api/projects/:id/restore',

  // Folders (nested under projects)
  createFolder:   'POST   /api/projects/:projectId/folders',
  listFolders:    'GET    /api/projects/:projectId/folders',
  getFolder:      'GET    /api/projects/:projectId/folders/:id',
  getFolderContents: 'GET /api/projects/:projectId/folders/:id/contents',
  updateFolder:   'PATCH  /api/projects/:projectId/folders/:id',
  deleteFolder:   'DELETE /api/projects/:projectId/folders/:id',

  // Tree View
  getTree:        'GET    /api/projects/:projectId/tree',

  // Search
  search:         'GET    /api/projects/:projectId/search',

  // Documents (nested under projects)
  createDocument: 'POST   /api/projects/:projectId/documents',
  listDocuments:  'GET    /api/projects/:projectId/documents',
  getDocument:    'GET    /api/projects/:projectId/documents/:id',
  updateDocument: 'PATCH  /api/projects/:projectId/documents/:id',
  deleteDocument: 'DELETE /api/projects/:projectId/documents/:id',

  // Sessions (nested under projects)
  createSession:  'POST   /api/projects/:projectId/sessions',
  listSessions:   'GET    /api/projects/:projectId/sessions',
  getSession:     'GET    /api/projects/:projectId/sessions/:id',
  updateSession:  'PATCH  /api/projects/:projectId/sessions/:id',

  // Messages (streaming)
  sendMessage:    'POST   /api/projects/:projectId/sessions/:id/messages',

  // Yjs WebSocket (upgrade)
  documentSync:   'GET    /ws/documents/:id',
} as const
