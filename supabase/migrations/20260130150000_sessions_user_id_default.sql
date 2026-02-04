-- ============================================================================
-- Migration: Add default value for sessions.user_id
--
-- This allows inserts/upserts without explicitly providing user_id since RLS
-- already enforces that auth.uid() = user_id. The default ensures the
-- column gets populated automatically.
--
-- This matches the pattern used for git_credentials.user_id.
-- ============================================================================

ALTER TABLE public.sessions ALTER COLUMN user_id SET DEFAULT auth.uid();
