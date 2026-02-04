-- Migration: Add is_superuser column and JWT claim
-- Superusers are internal employees who can access all organizations for support purposes

-- Add column to users table
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_superuser boolean DEFAULT false;

-- Index for quick lookup in JWT hook
CREATE INDEX IF NOT EXISTS idx_users_is_superuser ON public.users (id) WHERE is_superuser = true;

-- Update the custom access token hook to include is_superuser claim
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claims jsonb;
  org_memberships jsonb;
  workspace_memberships jsonb;
  user_is_superuser boolean;
BEGIN
  claims := event->'claims';

  -- Check if user is superuser
  SELECT COALESCE(u.is_superuser, false)
  INTO user_is_superuser
  FROM users u
  WHERE u.id = (event->>'user_id')::uuid;

  -- Get organization memberships (uses idx_organization_memberships_user_id)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'org_id', om.organization_id,
    'role', om.role
  )), '[]'::jsonb)
  INTO org_memberships
  FROM organization_memberships om
  WHERE om.user_id = (event->>'user_id')::uuid;

  -- Get workspace memberships with org context (uses idx_workspace_memberships_user_id)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'workspace_id', wm.workspace_id,
    'organization_id', w.organization_id,
    'role', wm.role
  )), '[]'::jsonb)
  INTO workspace_memberships
  FROM workspace_memberships wm
  JOIN workspaces w ON w.id = wm.workspace_id
  WHERE wm.user_id = (event->>'user_id')::uuid;

  -- Add custom claims to JWT
  claims := jsonb_set(claims, '{organizations}', org_memberships);
  claims := jsonb_set(claims, '{workspaces}', workspace_memberships);
  claims := jsonb_set(claims, '{is_superuser}', to_jsonb(user_is_superuser));

  -- Update claims in event and return
  event := jsonb_set(event, '{claims}', claims);
  RETURN event;
END;
$$;

-- Grant read access on users table to auth hook
GRANT SELECT ON public.users TO supabase_auth_admin;
