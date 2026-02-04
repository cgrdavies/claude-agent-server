-- Comprehensive RLS fix migration
-- This migration ensures RLS is properly enabled and policies are non-recursive

-- =============================================================================
-- PART 1: Ensure RLS is enabled on all tables that need it
-- =============================================================================

-- The projects table was found to have RLS disabled despite policies existing
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

-- Double-check other critical tables have RLS enabled
ALTER TABLE public.project_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.git_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- PART 2: Create additional helper functions for remaining recursive patterns
-- =============================================================================

-- Helper to check if user is member of an organization (for org-related policies)
CREATE OR REPLACE FUNCTION public.user_is_org_member(
  p_organization_id UUID,
  p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_memberships
    WHERE organization_id = p_organization_id
    AND user_id = p_user_id
  );
$$;

-- Helper to check if user is admin of an organization
CREATE OR REPLACE FUNCTION public.user_is_org_admin(
  p_organization_id UUID,
  p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_memberships
    WHERE organization_id = p_organization_id
    AND user_id = p_user_id
    AND role = 'admin'
  );
$$;

-- Helper to get organization IDs where user is a member
CREATE OR REPLACE FUNCTION public.user_organization_ids(p_user_id UUID)
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT organization_id FROM organization_memberships
  WHERE user_id = p_user_id;
$$;

-- Helper to check if user owns an account
CREATE OR REPLACE FUNCTION public.user_owns_account(
  p_account_id UUID,
  p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM accounts
    WHERE id = p_account_id
    AND owner_id = p_user_id
  );
$$;

-- Grant execute permissions on new helper functions
GRANT EXECUTE ON FUNCTION public.user_is_org_member(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_is_org_admin(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_organization_ids(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_owns_account(UUID, UUID) TO authenticated;

-- =============================================================================
-- PART 3: Fix self-referential policies on organizations table
-- =============================================================================

-- Drop old recursive policies
DROP POLICY IF EXISTS "Users can view organizations they belong to" ON public.organizations;
DROP POLICY IF EXISTS "Account owners can manage organizations" ON public.organizations;

-- Create non-recursive SELECT policy
CREATE POLICY "Users can view organizations they belong to"
ON public.organizations
FOR SELECT
USING (
  public.user_is_org_member(id, auth.uid())
);

-- Create non-recursive management policy (for account owners)
-- Note: This checks account ownership through the accounts table
CREATE POLICY "Account owners can manage organizations"
ON public.organizations
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = organizations.account_id
    AND a.owner_id = auth.uid()
  )
);

-- =============================================================================
-- PART 4: Fix self-referential policies on workspaces table
-- =============================================================================

-- Drop old recursive policies
DROP POLICY IF EXISTS "Org admins can manage workspaces" ON public.workspaces;
DROP POLICY IF EXISTS "Organization members can view workspaces" ON public.workspaces;

-- Create non-recursive SELECT policy
CREATE POLICY "Organization members can view workspaces"
ON public.workspaces
FOR SELECT
USING (
  public.user_is_org_member(organization_id, auth.uid())
);

-- Create non-recursive management policy for org admins
CREATE POLICY "Org admins can manage workspaces"
ON public.workspaces
FOR ALL
USING (
  public.user_is_org_admin(organization_id, auth.uid())
);

-- =============================================================================
-- PART 5: Fix self-referential policies on organization_memberships table
-- =============================================================================

-- Drop old recursive policies (keep service role and user-self-view policies)
DROP POLICY IF EXISTS "Org admins can delete memberships" ON public.organization_memberships;
DROP POLICY IF EXISTS "Org admins can insert memberships" ON public.organization_memberships;
DROP POLICY IF EXISTS "Org admins can update memberships" ON public.organization_memberships;

-- Create non-recursive INSERT policy for org admins
CREATE POLICY "Org admins can insert memberships"
ON public.organization_memberships
FOR INSERT
WITH CHECK (
  public.user_is_org_admin(organization_id, auth.uid())
);

-- Create non-recursive UPDATE policy for org admins
CREATE POLICY "Org admins can update memberships"
ON public.organization_memberships
FOR UPDATE
USING (
  public.user_is_org_admin(organization_id, auth.uid())
);

-- Create non-recursive DELETE policy for org admins
CREATE POLICY "Org admins can delete memberships"
ON public.organization_memberships
FOR DELETE
USING (
  public.user_is_org_admin(organization_id, auth.uid())
);

-- =============================================================================
-- PART 6: Fix self-referential policies on organization_invitations table
-- =============================================================================

DROP POLICY IF EXISTS "Org admins can manage invitations" ON public.organization_invitations;

CREATE POLICY "Org admins can manage invitations"
ON public.organization_invitations
FOR ALL
USING (
  public.user_is_org_admin(organization_id, auth.uid())
);

-- =============================================================================
-- PART 7: Ensure sessions policies work correctly with projects RLS
-- =============================================================================

-- The sessions "Users can view sessions in their projects" policy joins through
-- projects -> workspaces -> workspace_memberships
-- Now that projects has RLS, we need to ensure this doesn't cause issues
-- Using workspace_memberships directly is safer

DROP POLICY IF EXISTS "Users can view sessions in their projects" ON public.sessions;

CREATE POLICY "Users can view sessions in their projects"
ON public.sessions
FOR SELECT
USING (
  -- User owns the session
  auth.uid() = user_id
  OR
  -- User has access to the project's workspace
  EXISTS (
    SELECT 1 FROM workspaces w
    JOIN workspace_memberships wm ON w.id = wm.workspace_id
    WHERE w.id = (SELECT workspace_id FROM projects WHERE id = sessions.project_id)
    AND wm.user_id = auth.uid()
  )
);

-- Note: This policy still references the projects table in a subquery, but that's
-- acceptable because we're just fetching a single value (workspace_id), not iterating.
-- The SECURITY DEFINER pattern isn't needed here because we're not checking permissions
-- on the projects table itself - we're just dereferencing a foreign key.

-- =============================================================================
-- VERIFICATION QUERIES (for manual testing)
-- =============================================================================
-- Run these after applying the migration to verify everything is correct:
--
-- Check RLS is enabled on all tables:
-- SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
--
-- Check all policies exist:
-- SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname;
--
-- Check helper functions are accessible:
-- SELECT routine_name FROM information_schema.routines WHERE routine_schema = 'public' AND routine_name LIKE 'user_%';
