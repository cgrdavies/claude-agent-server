-- Migration: Add agent_sessions, messages, and documents tables
-- These tables support the multitenant agent server with workspace-scoped
-- sessions, conversation history, and collaborative documents.

-- ============================================================
-- 1. agent_sessions
-- ============================================================

CREATE TABLE agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New Session',
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  system_prompt TEXT,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  last_message_at TIMESTAMPTZ,
  archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_sessions_workspace ON agent_sessions(workspace_id);
CREATE INDEX idx_agent_sessions_created_by ON agent_sessions(created_by);
CREATE INDEX idx_agent_sessions_workspace_archived ON agent_sessions(workspace_id, archived);

ALTER TABLE agent_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY agent_sessions_select ON agent_sessions FOR SELECT USING (
  workspace_id IN (
    SELECT workspace_id FROM workspace_memberships WHERE user_id = auth.uid()
  )
);

CREATE POLICY agent_sessions_insert ON agent_sessions FOR INSERT WITH CHECK (
  created_by = auth.uid()
  AND workspace_id IN (
    SELECT workspace_id FROM workspace_memberships WHERE user_id = auth.uid()
  )
);

CREATE POLICY agent_sessions_update ON agent_sessions FOR UPDATE USING (
  workspace_id IN (
    SELECT workspace_id FROM workspace_memberships WHERE user_id = auth.uid()
  )
);

-- ============================================================
-- 2. messages
-- ============================================================

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content TEXT NOT NULL,
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_session ON messages(session_id);
CREATE INDEX idx_messages_session_created ON messages(session_id, created_at);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY messages_select ON messages FOR SELECT USING (
  session_id IN (
    SELECT id FROM agent_sessions WHERE workspace_id IN (
      SELECT workspace_id FROM workspace_memberships WHERE user_id = auth.uid()
    )
  )
);

CREATE POLICY messages_insert ON messages FOR INSERT WITH CHECK (
  session_id IN (
    SELECT id FROM agent_sessions WHERE workspace_id IN (
      SELECT workspace_id FROM workspace_memberships WHERE user_id = auth.uid()
    )
  )
);

-- ============================================================
-- 3. documents
-- ============================================================

CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  yjs_state BYTEA NOT NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_documents_workspace ON documents(workspace_id);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY documents_select ON documents FOR SELECT USING (
  workspace_id IN (
    SELECT workspace_id FROM workspace_memberships WHERE user_id = auth.uid()
  )
);

CREATE POLICY documents_insert ON documents FOR INSERT WITH CHECK (
  created_by = auth.uid()
  AND workspace_id IN (
    SELECT workspace_id FROM workspace_memberships WHERE user_id = auth.uid()
  )
);

CREATE POLICY documents_update ON documents FOR UPDATE USING (
  workspace_id IN (
    SELECT workspace_id FROM workspace_memberships WHERE user_id = auth.uid()
  )
);

CREATE POLICY documents_delete ON documents FOR DELETE USING (
  workspace_id IN (
    SELECT workspace_id FROM workspace_memberships WHERE user_id = auth.uid()
  )
);
