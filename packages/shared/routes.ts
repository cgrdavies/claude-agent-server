/**
 * API route map. Used for documentation and client SDK generation.
 * All routes are prefixed with /api.
 * All routes except /health require Authorization: Bearer <supabase_jwt>.
 */
export const API_ROUTES = {
  // Health
  health: 'GET /health',

  // Sessions
  createSession:  'POST   /api/sessions',
  listSessions:   'GET    /api/sessions',
  getSession:     'GET    /api/sessions/:id',
  updateSession:  'PATCH  /api/sessions/:id',

  // Messages (streaming)
  sendMessage:    'POST   /api/sessions/:id/messages',

  // Documents
  createDocument: 'POST   /api/documents',
  listDocuments:  'GET    /api/documents',
  getDocument:    'GET    /api/documents/:id',
  updateDocument: 'PATCH  /api/documents/:id',
  deleteDocument: 'DELETE /api/documents/:id',

  // Yjs WebSocket (upgrade)
  documentSync:   'GET    /ws/documents/:id',
} as const
