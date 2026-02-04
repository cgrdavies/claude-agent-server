-- Migration: Add published_commit column to sessions table
-- Tracks which commit hash was last published to main
-- Enables republishing when new commits exist after initial publish

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS published_commit TEXT;

-- Comment for documentation
COMMENT ON COLUMN public.sessions.published_commit IS 'Git commit hash that was last published to main. Compare with current_commit to detect unpublished changes.';
