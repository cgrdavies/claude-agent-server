-- Migration: Create sessions table (shared between Git and Sync plans)
-- Part of: Unified Plan - Git-Backed Project Files + Conversation Sync
-- Owner: Dev B creates, both Dev A and Dev B use

-- Sessions table tracks Claude CLI conversation sessions
-- Git columns owned by Dev A, Sync columns owned by Dev B
CREATE TABLE IF NOT EXISTS public.sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL UNIQUE,  -- Claude CLI session ID
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.users(id),

  -- Git columns (Dev A)
  branch_name TEXT,                   -- Git branch for this session
  start_commit TEXT,                  -- Commit hash when session started
  current_commit TEXT,                -- Current HEAD commit hash
  base_main_commit TEXT,              -- Main branch commit this branched from
  workspace_path TEXT,                -- Local workspace directory path
  last_turn_at TIMESTAMPTZ,           -- Updated on each turn:completed, used for ordering
  destroyed_at TIMESTAMPTZ,           -- NULL = active, set = soft-deleted

  -- Sync columns (Dev B)
  r2_path TEXT,                       -- R2 storage path for JSONL content
  local_synced_at TIMESTAMPTZ,        -- When local was last synced to R2
  remote_synced_at TIMESTAMPTZ,       -- When R2 was last synced to local
  sync_status TEXT DEFAULT 'local_only',  -- 'local_only' | 'synced' | 'remote_only'

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON public.sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON public.sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_destroyed_at ON public.sessions(destroyed_at) WHERE destroyed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_last_turn_at ON public.sessions(last_turn_at DESC) WHERE destroyed_at IS NULL;

-- Enable RLS
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Users can only access sessions they own or have project access to
-- Drop existing policies first to make migration idempotent
DROP POLICY IF EXISTS "Users can view their own sessions" ON public.sessions;
DROP POLICY IF EXISTS "Users can view sessions in their projects" ON public.sessions;
DROP POLICY IF EXISTS "Users can insert their own sessions" ON public.sessions;
DROP POLICY IF EXISTS "Users can update their own sessions" ON public.sessions;

CREATE POLICY "Users can view their own sessions"
  ON public.sessions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can view sessions in their projects"
  ON public.sessions FOR SELECT
  USING (
    project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.workspaces w ON p.workspace_id = w.id
      JOIN public.workspace_memberships wm ON w.id = wm.workspace_id
      WHERE wm.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert their own sessions"
  ON public.sessions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own sessions"
  ON public.sessions FOR UPDATE
  USING (auth.uid() = user_id);

-- Note: The soft-delete policy is covered by "Users can update their own sessions"
-- We can't prevent un-deletion via RLS alone (would need a trigger for that)

-- Trigger to update updated_at on changes
CREATE OR REPLACE FUNCTION public.update_sessions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sessions_updated_at ON public.sessions;
CREATE TRIGGER sessions_updated_at
  BEFORE UPDATE ON public.sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_sessions_updated_at();

-- Comments for documentation
COMMENT ON TABLE public.sessions IS 'Claude CLI conversation sessions with git and sync metadata';
COMMENT ON COLUMN public.sessions.session_id IS 'Unique Claude CLI session identifier';
COMMENT ON COLUMN public.sessions.destroyed_at IS 'Soft delete timestamp - NULL means active';
COMMENT ON COLUMN public.sessions.sync_status IS 'Sync state: local_only, synced, or remote_only';
