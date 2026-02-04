-- Migration: Add published_at column to sessions table
-- Tracks when a session's work was merged to main and pushed to remote
-- Part of: Happy Path Publish feature

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

-- Index for querying published sessions
CREATE INDEX IF NOT EXISTS idx_sessions_published_at
  ON public.sessions(published_at)
  WHERE published_at IS NOT NULL;

-- Comment for documentation
COMMENT ON COLUMN public.sessions.published_at IS 'Timestamp when session branch was merged to main and pushed to remote';
