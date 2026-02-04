import { Database } from 'bun:sqlite'
import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync } from 'node:fs'

import { WORKSPACE_DIR_NAME } from './const'

const dbDir = join(homedir(), WORKSPACE_DIR_NAME)

// Ensure the workspace directory exists
mkdirSync(dbDir, { recursive: true })

const dbPath = join(dbDir, 'documents.db')

const db = new Database(dbPath, { create: true })

// Enable WAL mode for better concurrent read/write performance
db.run('PRAGMA journal_mode = WAL')

db.run(`
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    state BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

export default db
