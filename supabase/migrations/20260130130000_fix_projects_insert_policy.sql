-- Fix: Add INSERT policy for projects table
-- The projects table needs a separate INSERT policy since UPDATE/DELETE are handled separately

-- Create helper function for checking if user can create projects in a workspace
CREATE OR REPLACE FUNCTION public.user_can_create_project_in_workspace(
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
    SELECT 1
    FROM organization_memberships om
    JOIN workspaces w ON w.organization_id = om.organization_id
    WHERE w.id = p_workspace_id
      AND om.user_id = p_user_id
      AND om.role = 'admin'
  );
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION public.user_can_create_project_in_workspace(UUID, UUID) TO authenticated;

-- Allow org admins to insert projects into their workspaces
CREATE POLICY "Org admins can create projects" ON "public"."projects"
FOR INSERT
WITH CHECK (
  public.user_can_create_project_in_workspace(workspace_id, auth.uid())
);
