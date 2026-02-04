-- Seed script for local Supabase development
-- Creates a test user with full org/workspace setup
--
-- User: cdavies@shopped.com / password123
--
-- Run via: supabase db reset (applies migrations then seeds)

-- Use a fixed UUID so the seed is idempotent
DO $$
DECLARE
  seed_user_id UUID := '11111111-1111-1111-1111-111111111111';
  seed_workspace_id UUID;
BEGIN
  -- 1. Create the auth.users entry
  --    This triggers handle_new_user() which creates:
  --    - public.users row
  --    - account
  --    - organization + organization_membership
  --    - workspace
  INSERT INTO auth.users (
    id,
    instance_id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    confirmation_token,
    recovery_token,
    email_change,
    email_change_token_new,
    email_change_token_current,
    phone_change,
    phone_change_token,
    reauthentication_token,
    is_sso_user,
    is_anonymous
  ) VALUES (
    seed_user_id,
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'cdavies@shopped.com',
    crypt('password123', gen_salt('bf')),
    now(),
    '{"provider": "email", "providers": ["email"]}'::jsonb,
    '{"full_name": "C Davies"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    false,
    false
  );

  -- 2. Create the identity entry (required for email/password sign-in)
  INSERT INTO auth.identities (
    id,
    user_id,
    provider_id,
    identity_data,
    provider,
    last_sign_in_at,
    created_at,
    updated_at
  ) VALUES (
    gen_random_uuid(),
    seed_user_id,
    'cdavies@shopped.com',
    jsonb_build_object(
      'sub', seed_user_id::text,
      'email', 'cdavies@shopped.com',
      'full_name', 'C Davies',
      'email_verified', true
    ),
    'email',
    now(),
    now(),
    now()
  );

  -- 3. Find the workspace that was auto-created by the trigger chain
  SELECT w.id INTO seed_workspace_id
  FROM workspaces w
  JOIN organizations o ON o.id = w.organization_id
  JOIN organization_memberships om ON om.organization_id = o.id
  WHERE om.user_id = seed_user_id
  LIMIT 1;

  -- 4. Create workspace_membership (the trigger chain creates the workspace
  --    but does not add the user as a workspace member)
  IF seed_workspace_id IS NOT NULL THEN
    INSERT INTO workspace_memberships (workspace_id, user_id, role)
    VALUES (seed_workspace_id, seed_user_id, 'owner');

    RAISE NOTICE 'Seed complete. workspace_id = %', seed_workspace_id;
  ELSE
    RAISE WARNING 'No workspace found after trigger - creating manually';

    -- Fallback: create workspace directly if trigger chain didn't fire
    INSERT INTO workspaces (name, description, slug)
    VALUES ('Shopped Workspace', 'Default workspace', 'shopped')
    RETURNING id INTO seed_workspace_id;

    INSERT INTO workspace_memberships (workspace_id, user_id, role)
    VALUES (seed_workspace_id, seed_user_id, 'owner');

    RAISE NOTICE 'Seed complete (fallback). workspace_id = %', seed_workspace_id;
  END IF;
END $$;
