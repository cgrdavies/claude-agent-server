-- Test database seed file
-- This file runs after migrations during `supabase db reset`

-- Create the reset function for cleaning up between tests
-- This truncates only the agent-related tables, preserving workspaces/users
CREATE OR REPLACE FUNCTION reset_agent_tables()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Disable triggers temporarily to avoid FK constraint issues
  SET session_replication_role = 'replica';

  -- Truncate agent tables in dependency order
  -- CASCADE handles the FK relationships
  TRUNCATE TABLE messages RESTART IDENTITY CASCADE;
  TRUNCATE TABLE documents RESTART IDENTITY CASCADE;
  TRUNCATE TABLE folders RESTART IDENTITY CASCADE;
  TRUNCATE TABLE agent_sessions RESTART IDENTITY CASCADE;

  -- Re-enable triggers
  SET session_replication_role = 'origin';
END;
$$;

-- Grant execute to authenticated users (needed for test setup)
GRANT EXECUTE ON FUNCTION reset_agent_tables() TO service_role;
