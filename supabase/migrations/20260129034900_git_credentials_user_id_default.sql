-- ============================================================================
-- Migration: Add default value for git_credentials.user_id
--
-- This allows inserts without explicitly providing user_id since RLS
-- already enforces that auth.uid() = user_id. The default ensures the
-- column gets populated automatically.
-- ============================================================================

ALTER TABLE public.git_credentials ALTER COLUMN user_id SET DEFAULT auth.uid();
