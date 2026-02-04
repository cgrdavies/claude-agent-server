-- Migration: Add organization and workspace claims to JWT
-- This creates a Custom Access Token Hook that adds org/workspace memberships to the JWT
-- After applying, enable via: Supabase Dashboard > Authentication > Hooks > Custom Access Token
-- Select schema: public, function: custom_access_token_hook

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
BEGIN
  claims := event->'claims';

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

  -- Update claims in event and return
  event := jsonb_set(event, '{claims}', claims);
  RETURN event;
END;
$$;

-- Grant execute to supabase_auth_admin (required for auth hooks)
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;

-- Grant table read access to supabase_auth_admin for the hook
GRANT SELECT ON public.organization_memberships TO supabase_auth_admin;
GRANT SELECT ON public.workspace_memberships TO supabase_auth_admin;
GRANT SELECT ON public.workspaces TO supabase_auth_admin;

-- Revoke execute from other roles for security
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM anon;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM authenticated;
