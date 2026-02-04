-- Migration: Add workspace name to JWT claims
-- Updates the custom_access_token_hook to include workspace.name in workspace memberships

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

  -- Get workspace memberships with org context and name (uses idx_workspace_memberships_user_id)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'workspace_id', wm.workspace_id,
    'workspace_name', w.name,
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
