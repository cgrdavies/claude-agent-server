-- Migration: Add session metadata columns for Supabase-backed session info
-- These columns mirror the local SessionInfoService fields for cloud sync

-- Add metadata columns to sessions table
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS custom_name TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS continuation_session_id TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS permission_mode TEXT DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS initial_commit_head TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS creator_id UUID REFERENCES public.users(id);

-- Index for filtering by archived/pinned status
CREATE INDEX IF NOT EXISTS idx_sessions_archived ON public.sessions(archived) WHERE destroyed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_pinned ON public.sessions(pinned) WHERE destroyed_at IS NULL;

-- Index for creator-based queries
CREATE INDEX IF NOT EXISTS idx_sessions_creator_id ON public.sessions(creator_id);

-- Comments for documentation
COMMENT ON COLUMN public.sessions.custom_name IS 'User-defined name for the session';
COMMENT ON COLUMN public.sessions.pinned IS 'Whether the session is pinned to the top of the list';
COMMENT ON COLUMN public.sessions.archived IS 'Whether the session is archived (hidden from default view)';
COMMENT ON COLUMN public.sessions.continuation_session_id IS 'Session ID of the continuation (resumed) session';
COMMENT ON COLUMN public.sessions.permission_mode IS 'Permission mode used for the session (default, acceptEdits, bypassPermissions, plan)';
COMMENT ON COLUMN public.sessions.initial_commit_head IS 'Git commit HEAD when the session started';
COMMENT ON COLUMN public.sessions.creator_id IS 'User ID who created this session';
