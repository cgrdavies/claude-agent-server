-- Migration: Enforce project_id is required for all sessions
-- This makes all conversations git-backed by requiring a project association

-- Step 1: Create legacy projects for users with null project_id sessions
-- This creates a "Legacy Conversations" project for each workspace that has orphaned sessions
INSERT INTO public.projects (workspace_id, name, description, created_by, created_at, updated_at)
SELECT DISTINCT
  w.id,
  'Legacy Conversations',
  'Auto-created project for pre-git-backed conversations',
  s.user_id,
  now(),
  now()
FROM public.sessions s
JOIN public.workspace_memberships wm ON s.user_id = wm.user_id
JOIN public.workspaces w ON wm.workspace_id = w.id
WHERE s.project_id IS NULL
  AND s.user_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Step 2: Update null project_id sessions to use legacy project
-- For each orphaned session, find the user's workspace and assign the Legacy Conversations project
UPDATE public.sessions s
SET project_id = (
  SELECT p.id FROM public.projects p
  WHERE p.name = 'Legacy Conversations'
  AND p.workspace_id IN (
    SELECT w.id FROM public.workspaces w
    JOIN public.workspace_memberships wm ON w.id = wm.workspace_id
    WHERE wm.user_id = s.user_id
  )
  LIMIT 1
)
WHERE s.project_id IS NULL
  AND s.user_id IS NOT NULL;

-- Step 3: Delete any remaining orphan sessions (where user_id is also null)
-- These are truly orphaned and cannot be assigned to any project
DELETE FROM public.sessions
WHERE project_id IS NULL;

-- Step 4: Make project_id NOT NULL
-- After backfilling, enforce the constraint
ALTER TABLE public.sessions ALTER COLUMN project_id SET NOT NULL;

-- Update the table comment to reflect the new constraint
COMMENT ON COLUMN public.sessions.project_id IS 'Project ID (required) - all conversations must be associated with a git-backed project';
