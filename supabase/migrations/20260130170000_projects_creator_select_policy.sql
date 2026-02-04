-- Add SELECT policy for project creators
--
-- The existing "Users can view projects" policy uses user_is_org_admin_for_project()
-- which self-joins on the projects table. This causes RETURNING * to fail after INSERT
-- because the newly inserted row isn't visible within the same transaction for the self-join.
--
-- This simpler policy allows creators to view their own projects without a self-join,
-- enabling INSERT ... RETURNING to work correctly.

CREATE POLICY "Creator can view own projects" ON public.projects
FOR SELECT USING (created_by = auth.uid());
