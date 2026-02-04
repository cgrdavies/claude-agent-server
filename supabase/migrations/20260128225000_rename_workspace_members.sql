-- Migration: Rename workspace_members to workspace_memberships
-- Reason: Consistency with organization_memberships naming convention
-- Note: This is now a no-op since remote_schema.sql already uses workspace_memberships

-- Only rename if old table exists (idempotent)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'workspace_members') THEN
    ALTER TABLE public.workspace_members RENAME TO workspace_memberships;
  END IF;
END $$;

-- Rename any indexes (if they exist with old naming)
ALTER INDEX IF EXISTS idx_workspace_members_workspace_id RENAME TO idx_workspace_memberships_workspace_id;
ALTER INDEX IF EXISTS idx_workspace_members_user_id RENAME TO idx_workspace_memberships_user_id;
