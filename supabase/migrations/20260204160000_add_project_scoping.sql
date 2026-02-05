-- ============================================================
-- Add project scoping to documents and agent_sessions
-- Add soft delete support to projects
-- ============================================================

-- 1. Add deleted_at column to projects for soft delete
ALTER TABLE projects
  ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX idx_projects_deleted_at ON projects(deleted_at);

-- 2. Clear existing data (dev environment - no migration needed)
TRUNCATE TABLE documents CASCADE;
TRUNCATE TABLE agent_sessions CASCADE;
TRUNCATE TABLE messages CASCADE;

-- 3. Add project_id to documents
ALTER TABLE documents
  ADD COLUMN project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE;

-- 4. Create index for documents by project
CREATE INDEX idx_documents_project ON documents(project_id);

-- 5. Add project_id to agent_sessions
ALTER TABLE agent_sessions
  ADD COLUMN project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE;

-- 6. Create index for agent_sessions by project
CREATE INDEX idx_agent_sessions_project ON agent_sessions(project_id);

-- 7. Update RLS policies for documents to check project access
DROP POLICY IF EXISTS documents_select ON documents;
DROP POLICY IF EXISTS documents_insert ON documents;
DROP POLICY IF EXISTS documents_update ON documents;
DROP POLICY IF EXISTS documents_delete ON documents;

-- Documents: user must have access to the project's workspace
CREATE POLICY documents_select ON documents FOR SELECT USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
      AND p.deleted_at IS NULL
  )
);

CREATE POLICY documents_insert ON documents FOR INSERT WITH CHECK (
  created_by = auth.uid()
  AND project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
      AND p.deleted_at IS NULL
  )
);

CREATE POLICY documents_update ON documents FOR UPDATE USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
      AND p.deleted_at IS NULL
  )
);

CREATE POLICY documents_delete ON documents FOR DELETE USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
      AND p.deleted_at IS NULL
  )
);

-- 8. Update RLS policies for agent_sessions to check project access
DROP POLICY IF EXISTS agent_sessions_select ON agent_sessions;
DROP POLICY IF EXISTS agent_sessions_insert ON agent_sessions;
DROP POLICY IF EXISTS agent_sessions_update ON agent_sessions;

CREATE POLICY agent_sessions_select ON agent_sessions FOR SELECT USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
      AND p.deleted_at IS NULL
  )
);

CREATE POLICY agent_sessions_insert ON agent_sessions FOR INSERT WITH CHECK (
  created_by = auth.uid()
  AND project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
      AND p.deleted_at IS NULL
  )
);

CREATE POLICY agent_sessions_update ON agent_sessions FOR UPDATE USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
      AND p.deleted_at IS NULL
  )
);
