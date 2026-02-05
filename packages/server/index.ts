import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { authMiddleware } from './middleware/auth'
import { sessionsRouter } from './routes/sessions'
import { messagesRouter } from './routes/messages'
import { documentsRouter } from './routes/documents'
import { projectsRouter } from './routes/projects'
import { handleYjsUpgrade, yjsWebsocket } from './ws/yjs'

const app = new Hono()

// Global middleware
app.use('*', logger())
app.use('*', cors({
  origin: Bun.env.FRONTEND_URL ?? 'http://localhost:5173',
  credentials: true,
}))

// Public
app.get('/health', (c) =>
  c.json({ status: 'ok', timestamp: new Date().toISOString() }),
)

// Protected API routes
const api = new Hono()
api.use('*', authMiddleware)
api.route('/projects', projectsRouter)
api.route('/sessions', sessionsRouter)
api.route('/documents', documentsRouter)

// Messages are nested under sessions but defined separately for clarity
// POST /api/sessions/:sessionId/messages
api.route('/sessions', messagesRouter)

app.route('/api', api)

// Only start server when run directly (not when imported for testing)
if (import.meta.main) {
  const server = Bun.serve({
    port: Number(Bun.env.PORT ?? 4000),
    fetch(req, server) {
      // Handle WebSocket upgrades for Yjs
      const upgraded = handleYjsUpgrade(req, server)
      if (upgraded) return undefined

      return app.fetch(req)
    },
    websocket: yjsWebsocket,
  })

  console.log(`Server running on http://localhost:${server.port}`)
}

export { app }
