-- Fix recursive RLS policy bugs on projects, project_permissions, and workspace_memberships tables
-- The original policies queried the same tables they protected, causing recursion

-- =============================================================================
-- SECURITY DEFINER helper functions (bypass RLS for permission checks)
-- =============================================================================

-- Check if user is a member of a workspace (bypasses RLS)
CREATE OR REPLACE FUNCTION public.user_is_workspace_member(
  p_workspace_id UUID,
  p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_memberships
    WHERE workspace_id = p_workspace_id
    AND user_id = p_user_id
  );
$$;

-- Check if user is workspace admin or owner (bypasses RLS)
CREATE OR REPLACE FUNCTION public.user_is_workspace_admin(
  p_workspace_id UUID,
  p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_memberships
    WHERE workspace_id = p_workspace_id
    AND user_id = p_user_id
    AND role IN ('owner', 'admin')
  );
$$;

-- Get workspace IDs where user is a member (bypasses RLS)
CREATE OR REPLACE FUNCTION public.user_workspace_ids(p_user_id UUID)
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT workspace_id FROM workspace_memberships
  WHERE user_id = p_user_id;
$$;

-- Check if user has specific permission on a project (bypasses RLS)
CREATE OR REPLACE FUNCTION public.user_has_project_permission(
  p_project_id UUID,
  p_user_id UUID,
  p_permission TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM project_permissions
    WHERE project_id = p_project_id
    AND user_id = p_user_id
    AND permission = p_permission
  );
$$;

-- Check if user has ANY permission on a project (bypasses RLS)
CREATE OR REPLACE FUNCTION public.user_has_any_project_permission(
  p_project_id UUID,
  p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM project_permissions
    WHERE project_id = p_project_id
    AND user_id = p_user_id
  );
$$;

-- Check if user is org admin for a project's workspace (bypasses RLS)
CREATE OR REPLACE FUNCTION public.user_is_org_admin_for_project(
  p_project_id UUID,
  p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM projects p
    JOIN workspaces w ON w.id = p.workspace_id
    JOIN organization_memberships om ON om.organization_id = w.organization_id
    WHERE p.id = p_project_id
    AND om.user_id = p_user_id
    AND om.role = 'admin'
  );
$$;

-- Grant execute permissions to authenticated users
GRANT EXECUTE ON FUNCTION public.user_is_workspace_member(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_is_workspace_admin(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_workspace_ids(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_has_project_permission(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_has_any_project_permission(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_is_org_admin_for_project(UUID, UUID) TO authenticated;

-- =============================================================================
-- Drop old recursive policies
-- =============================================================================

-- workspace_memberships policies
DROP POLICY IF EXISTS "Users can view workspace memberships they belong to" ON public.workspace_memberships;
DROP POLICY IF EXISTS "Workspace admins can manage members" ON public.workspace_memberships;

-- project policies
DROP POLICY IF EXISTS "Project admins can manage permissions" ON public.project_permissions;
DROP POLICY IF EXISTS "Project admins can manage projects" ON public.projects;
DROP POLICY IF EXISTS "Users can view projects they have access to" ON public.projects;
DROP POLICY IF EXISTS "Users can view their project permissions" ON public.project_permissions;

-- =============================================================================
-- Create new non-recursive policies using helper functions
-- =============================================================================

-- -----------------------------------------------------------------------------
-- workspace_memberships policies
-- -----------------------------------------------------------------------------

-- Policy: Users can view workspace memberships they belong to
-- Uses SECURITY DEFINER function instead of self-referencing subquery
CREATE POLICY "Users can view workspace memberships they belong to"
ON public.workspace_memberships
FOR SELECT
USING (
  user_id = auth.uid()
  OR public.user_is_workspace_member(workspace_id, auth.uid())
);

-- Policy: Workspace admins can manage members
-- Uses SECURITY DEFINER function instead of self-referencing subquery
CREATE POLICY "Workspace admins can manage members"
ON public.workspace_memberships
FOR ALL
USING (
  public.user_is_workspace_admin(workspace_id, auth.uid())
);

-- -----------------------------------------------------------------------------
-- project_permissions policies
-- -----------------------------------------------------------------------------

-- Policy: Users can view their own project permissions
-- Simple user_id check - no recursion
CREATE POLICY "Users can view their project permissions"
ON public.project_permissions
FOR SELECT
USING (user_id = auth.uid());

-- Policy: Project admins can manage permissions
-- Uses SECURITY DEFINER functions instead of self-referencing subquery
CREATE POLICY "Project admins can manage permissions"
ON public.project_permissions
FOR ALL
USING (
  public.user_has_project_permission(project_id, auth.uid(), 'admin')
  OR public.user_is_org_admin_for_project(project_id, auth.uid())
);

-- Policy: Users can view projects they have access to
-- Uses SECURITY DEFINER function to check project_permissions
CREATE POLICY "Users can view projects"
ON public.projects
FOR SELECT
USING (
  public.user_has_any_project_permission(id, auth.uid())
  OR public.user_is_org_admin_for_project(id, auth.uid())
);

-- Policy: Project admins can update projects
-- Uses SECURITY DEFINER function to avoid recursive RLS check
CREATE POLICY "Admins can update projects"
ON public.projects
FOR UPDATE
USING (
  public.user_has_project_permission(id, auth.uid(), 'admin')
  OR public.user_is_org_admin_for_project(id, auth.uid())
)
WITH CHECK (
  public.user_has_project_permission(id, auth.uid(), 'admin')
  OR public.user_is_org_admin_for_project(id, auth.uid())
);

-- Policy: Project admins can delete projects
-- Uses SECURITY DEFINER function to avoid recursive RLS check
CREATE POLICY "Admins can delete projects"
ON public.projects
FOR DELETE
USING (
  public.user_has_project_permission(id, auth.uid(), 'admin')
  OR public.user_is_org_admin_for_project(id, auth.uid())
);

-- =============================================================================
-- Re-enable RLS on both tables (was disabled in seed.sql as workaround)
-- =============================================================================

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_permissions ENABLE ROW LEVEL SECURITY;
