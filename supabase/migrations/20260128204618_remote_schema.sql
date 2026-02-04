


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."accept_organization_invitation"("invite_token_param" "text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  invite_record RECORD;
  user_record RECORD;
  org_name TEXT;
  current_user_id UUID;
BEGIN
  -- Get current user from auth context
  current_user_id := auth.uid();

  IF current_user_id IS NULL THEN
    RETURN JSON_BUILD_OBJECT(
      'success', false,
      'error', 'User not authenticated'
    );
  END IF;

  -- Get invitation details
  SELECT * INTO invite_record
  FROM public.organization_invitations
  WHERE invite_token = invite_token_param
  AND expires_at > NOW()
  AND accepted_at IS NULL;

  IF NOT FOUND THEN
    RETURN JSON_BUILD_OBJECT(
      'success', false,
      'error', 'Invalid or expired invitation token'
    );
  END IF;

  -- Get user details
  SELECT * INTO user_record
  FROM public.users
  WHERE id = current_user_id;

  IF NOT FOUND THEN
    RETURN JSON_BUILD_OBJECT(
      'success', false,
      'error', 'User record not found'
    );
  END IF;

  -- Verify email matches invitation
  IF user_record.email != invite_record.email THEN
    RETURN JSON_BUILD_OBJECT(
      'success', false,
      'error', 'Email does not match invitation'
    );
  END IF;

  -- Check if user is already a member
  IF EXISTS (
    SELECT 1 FROM public.organization_memberships
    WHERE organization_id = invite_record.organization_id
    AND user_id = current_user_id
  ) THEN
    RETURN JSON_BUILD_OBJECT(
      'success', false,
      'error', 'User is already a member of this organization'
    );
  END IF;

  -- Get organization name
  SELECT name INTO org_name
  FROM public.organizations
  WHERE id = invite_record.organization_id;

  -- Update user.account_id to match organization's account_id
  UPDATE public.users
  SET account_id = (
    SELECT account_id
    FROM public.organizations
    WHERE id = invite_record.organization_id
  )
  WHERE id = current_user_id;

  -- Create organization membership
  INSERT INTO public.organization_memberships (
    organization_id,
    user_id,
    role,
    created_at,
    updated_at
  ) VALUES (
    invite_record.organization_id,
    current_user_id,
    invite_record.role,
    NOW(),
    NOW()
  );

  -- Mark invitation as accepted
  UPDATE public.organization_invitations
  SET accepted_at = NOW(),
      accepted_by = current_user_id
  WHERE id = invite_record.id;

  -- Log to audit table
  INSERT INTO public.audit_log (
    user_id,
    action,
    resource_type,
    resource_id,
    metadata,
    created_at
  ) VALUES (
    current_user_id,
    'accept_invitation',
    'organization',
    invite_record.organization_id,
    JSON_BUILD_OBJECT(
      'invitation_id', invite_record.id,
      'role', invite_record.role,
      'organization_name', org_name
    ),
    NOW()
  );

  RETURN JSON_BUILD_OBJECT(
    'success', true,
    'organization_name', org_name,
    'role', invite_record.role,
    'membership_id', current_user_id -- Return the membership info
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN JSON_BUILD_OBJECT(
      'success', false,
      'error', SQLERRM
    );
END;
$$;


ALTER FUNCTION "public"."accept_organization_invitation"("invite_token_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."accept_organization_invitation"("user_id" "uuid", "invite_token_param" "text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  invite_record RECORD;
  user_record RECORD;
  org_name TEXT;
BEGIN
  -- Get invitation details
  SELECT * INTO invite_record
  FROM public.organization_invitations
  WHERE invite_token = invite_token_param
  AND expires_at > NOW()
  AND accepted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or expired invitation token';
  END IF;

  -- Get user details
  SELECT * INTO user_record
  FROM public.users
  WHERE id = user_id;

  -- Verify email matches (case insensitive)
  IF LOWER(user_record.email) != LOWER(invite_record.email) THEN
    RAISE EXCEPTION 'Email address does not match invitation';
  END IF;

  -- Get organization name
  SELECT name INTO org_name
  FROM public.organizations
  WHERE id = invite_record.organization_id;

  -- Add user to organization
  INSERT INTO public.organization_memberships (user_id, organization_id, role)
  VALUES (user_id, invite_record.organization_id, invite_record.role)
  ON CONFLICT (user_id, organization_id)
  DO UPDATE SET
    role = EXCLUDED.role,
    updated_at = NOW();

  -- Mark invitation as accepted
  UPDATE public.organization_invitations
  SET
    accepted_at = NOW(),
    accepted_by = user_id,
    updated_at = NOW()
  WHERE id = invite_record.id;

  -- Clear invite token from user
  UPDATE public.users
  SET invite_token = NULL
  WHERE id = user_id;

  RETURN JSON_BUILD_OBJECT(
    'success', true,
    'organization_id', invite_record.organization_id,
    'organization_name', org_name,
    'role', invite_record.role
  );
END;
$$;


ALTER FUNCTION "public"."accept_organization_invitation"("user_id" "uuid", "invite_token_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."auto_create_user_organization"("user_id" "uuid", "user_email" "text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  domain_part TEXT;
  username_part TEXT;
  org_name TEXT;
  account_name TEXT;
  result JSON;
  personal_domains TEXT[] := ARRAY['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'protonmail.com', 'aol.com'];
BEGIN
  -- Extract parts from email
  username_part := SPLIT_PART(user_email, '@', 1);
  domain_part := SPLIT_PART(user_email, '@', 2);

  -- Smart organization naming logic
  IF domain_part = ANY(personal_domains) THEN
    -- Personal email domains - use username + "Personal"
    org_name := INITCAP(username_part) || ' Personal';
    account_name := INITCAP(username_part);
  ELSE
    -- Business email - use domain name
    org_name := INITCAP(REPLACE(SPLIT_PART(domain_part, '.', 1), '-', ' '));
    account_name := org_name;
  END IF;

  -- Create account and organization using existing function
  SELECT public.setup_user_account(user_id, account_name, org_name) INTO result;

  -- Add logging for debugging
  INSERT INTO public.audit_log (
    user_id,
    action,
    details,
    created_at
  ) VALUES (
    user_id,
    'auto_org_created',
    JSON_BUILD_OBJECT(
      'email', user_email,
      'org_name', org_name,
      'account_name', account_name,
      'result', result
    ),
    NOW()
  ) ON CONFLICT DO NOTHING; -- Ignore if audit_log doesn't exist

  RETURN JSON_BUILD_OBJECT(
    'success', true,
    'organization_name', org_name,
    'account_name', account_name,
    'setup_result', result
  );
EXCEPTION
  WHEN OTHERS THEN
    -- Log the error but don't fail the user creation
    INSERT INTO public.audit_log (
      user_id,
      action,
      details,
      created_at
    ) VALUES (
      user_id,
      'auto_org_failed',
      JSON_BUILD_OBJECT(
        'email', user_email,
        'error', SQLERRM
      ),
      NOW()
    ) ON CONFLICT DO NOTHING;

    RETURN JSON_BUILD_OBJECT(
      'success', false,
      'error', SQLERRM
    );
END;
$$;


ALTER FUNCTION "public"."auto_create_user_organization"("user_id" "uuid", "user_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_expired_invitations"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.organization_invitations
  WHERE expires_at < NOW() - INTERVAL '30 days'
  AND accepted_at IS NULL;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;


ALTER FUNCTION "public"."cleanup_expired_invitations"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_organization_invitation"("org_id" "uuid", "invite_email" "text", "invite_role" "text" DEFAULT 'member'::"text", "invited_by_user_id" "uuid" DEFAULT "auth"."uid"()) RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  invite_token TEXT;
  expiry_date TIMESTAMP WITH TIME ZONE;
  org_name TEXT;
  inviter_name TEXT;
BEGIN
  -- Validate the inviter has admin permission
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships
    WHERE organization_id = org_id
    AND user_id = invited_by_user_id
    AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions to send invitations';
  END IF;

  -- Validate invite_role is valid
  IF invite_role NOT IN ('admin', 'member', 'viewer') THEN
    RAISE EXCEPTION 'Invalid role. Must be admin, member, or viewer';
  END IF;

  -- Get organization and inviter details
  SELECT name INTO org_name FROM public.organizations WHERE id = org_id;
  SELECT COALESCE(full_name, email) INTO inviter_name
  FROM public.users WHERE id = invited_by_user_id;

  -- Generate secure invite token
  invite_token := 'invite_' || REPLACE(gen_random_uuid()::TEXT, '-', '');
  expiry_date := NOW() + INTERVAL '7 days';

  -- Create invitation record (upsert to handle re-invites)
  INSERT INTO public.organization_invitations (
    organization_id, email, role, invited_by, invite_token, expires_at
  )
  VALUES (
    org_id, LOWER(invite_email), invite_role, invited_by_user_id, invite_token, expiry_date
  )
  ON CONFLICT (organization_id, email)
  DO UPDATE SET
    role = EXCLUDED.role,
    invited_by = EXCLUDED.invited_by,
    invite_token = EXCLUDED.invite_token,
    expires_at = EXCLUDED.expires_at,
    created_at = NOW(),
    accepted_at = NULL,
    accepted_by = NULL;

  RETURN JSON_BUILD_OBJECT(
    'success', true,
    'invite_token', invite_token,
    'expires_at', expiry_date,
    'email', invite_email,
    'organization_name', org_name,
    'inviter_name', inviter_name
  );
END;
$$;


ALTER FUNCTION "public"."create_organization_invitation"("org_id" "uuid", "invite_email" "text", "invite_role" "text", "invited_by_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_sync_workspace"("workspace_name" "text", "workspace_slug" "text", "organization_id" "uuid", "plan_type" "text" DEFAULT 'free'::"text", "created_by_user_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  new_workspace_id UUID;
BEGIN
  -- Create the workspace
  INSERT INTO public.workspaces (
    name,
    slug,
    organization_id,
    plan_type,
    sync_status,
    created_by,
    description
  ) VALUES (
    workspace_name,
    workspace_slug,
    organization_id,
    plan_type,
    'provisioning',
    created_by_user_id,
    'Sync workspace for ' || workspace_name
  )
  RETURNING id INTO new_workspace_id;

  -- Add creator as owner if specified
  IF created_by_user_id IS NOT NULL THEN
    INSERT INTO public.workspace_members (workspace_id, user_id, role)
    VALUES (new_workspace_id, created_by_user_id, 'owner')
    ON CONFLICT (workspace_id, user_id) DO NOTHING;
  END IF;

  -- Log the creation
  INSERT INTO public.workspace_activity_log (workspace_id, user_id, action, details)
  VALUES (new_workspace_id, created_by_user_id, 'created', jsonb_build_object(
    'name', workspace_name,
    'slug', workspace_slug,
    'plan_type', plan_type
  ));

  RETURN jsonb_build_object('workspace_id', new_workspace_id);
END;
$$;


ALTER FUNCTION "public"."create_sync_workspace"("workspace_name" "text", "workspace_slug" "text", "organization_id" "uuid", "plan_type" "text", "created_by_user_id" "uuid") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."claude_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "access_token" "text" NOT NULL,
    "refresh_token" "text",
    "expires_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."claude_connections" OWNER TO "postgres";


COMMENT ON TABLE "public"."claude_connections" IS 'Stores Claude OAuth credentials for each user';



COMMENT ON COLUMN "public"."claude_connections"."access_token" IS 'Encrypted Claude OAuth access token';



COMMENT ON COLUMN "public"."claude_connections"."refresh_token" IS 'Encrypted Claude OAuth refresh token';



COMMENT ON COLUMN "public"."claude_connections"."metadata" IS 'Claude user metadata like email, plan type, capabilities, etc.';



CREATE OR REPLACE FUNCTION "public"."get_claude_connection"("p_user_id" "uuid") RETURNS "public"."claude_connections"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  result claude_connections;
BEGIN
  SELECT * INTO result
  FROM claude_connections
  WHERE user_id = p_user_id;

  RETURN result;
END;
$$;


ALTER FUNCTION "public"."get_claude_connection"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_invitation_details"("invite_token_param" "text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  invite_record RECORD;
  org_name TEXT;
  inviter_name TEXT;
BEGIN
  -- Get invitation with organization details
  SELECT
    oi.*,
    o.name as org_name,
    COALESCE(u.full_name, u.email) as inviter_name
  INTO invite_record
  FROM public.organization_invitations oi
  JOIN public.organizations o ON o.id = oi.organization_id
  LEFT JOIN public.users u ON u.id = oi.invited_by
  WHERE oi.invite_token = invite_token_param
  AND oi.expires_at > NOW();

  IF NOT FOUND THEN
    RETURN JSON_BUILD_OBJECT(
      'success', false,
      'error', 'Invalid or expired invitation'
    );
  END IF;

  RETURN JSON_BUILD_OBJECT(
    'success', true,
    'email', invite_record.email,
    'organization_name', invite_record.org_name,
    'role', invite_record.role,
    'inviter_name', invite_record.inviter_name,
    'expires_at', invite_record.expires_at,
    'is_accepted', invite_record.accepted_at IS NOT NULL
  );
END;
$$;


ALTER FUNCTION "public"."get_invitation_details"("invite_token_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."grant_project_access"("project_id" "uuid", "user_id" "uuid", "permission" "text", "granted_by_user_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  -- Verify the granter has admin access to the project
  IF NOT EXISTS (
    SELECT 1 FROM public.project_permissions pp
    WHERE pp.project_id = grant_project_access.project_id
    AND pp.user_id = granted_by_user_id
    AND pp.permission = 'admin'
  ) AND NOT EXISTS (
    -- Or is organization admin
    SELECT 1 FROM public.projects p
    JOIN public.workspaces w ON w.id = p.workspace_id
    JOIN public.organization_memberships om ON om.organization_id = w.organization_id
    WHERE p.id = grant_project_access.project_id
    AND om.user_id = granted_by_user_id
    AND om.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions to grant access';
  END IF;

  -- Insert or update permission
  INSERT INTO public.project_permissions (project_id, user_id, permission, granted_by)
  VALUES (project_id, user_id, permission, granted_by_user_id)
  ON CONFLICT (user_id, project_id)
  DO UPDATE SET
    permission = EXCLUDED.permission,
    granted_by = EXCLUDED.granted_by;

  RETURN TRUE;
END;
$$;


ALTER FUNCTION "public"."grant_project_access"("project_id" "uuid", "user_id" "uuid", "permission" "text", "granted_by_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  invite_record RECORD;
  auto_org_result JSON;
BEGIN
  -- Create user record first
  INSERT INTO public.users (id, email, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    NEW.raw_user_meta_data->>'avatar_url'
  );

  -- Check for pending invitation (most recent valid one)
  SELECT * INTO invite_record
  FROM public.organization_invitations
  WHERE LOWER(email) = LOWER(NEW.email)
  AND expires_at > NOW()
  AND accepted_at IS NULL
  ORDER BY created_at DESC
  LIMIT 1;

  IF FOUND THEN
    -- Path 2: Invited user - set invite token for later processing
    UPDATE public.users
    SET invite_token = invite_record.invite_token
    WHERE id = NEW.id;

    -- Log the invite detection
    INSERT INTO public.audit_log (
      user_id,
      action,
      details,
      created_at
    ) VALUES (
      NEW.id,
      'invite_detected',
      JSON_BUILD_OBJECT(
        'email', NEW.email,
        'invite_token', invite_record.invite_token,
        'organization_id', invite_record.organization_id
      ),
      NOW()
    ) ON CONFLICT DO NOTHING;
  ELSE
    -- Path 1: Self-signup - auto-create organization
    SELECT public.auto_create_user_organization(NEW.id, NEW.email) INTO auto_org_result;
  END IF;

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Log error but don't fail user creation
    INSERT INTO public.audit_log (
      user_id,
      action,
      details,
      created_at
    ) VALUES (
      NEW.id,
      'signup_error',
      JSON_BUILD_OBJECT(
        'email', NEW.email,
        'error', SQLERRM
      ),
      NOW()
    ) ON CONFLICT DO NOTHING;

    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_claude_connection"("p_user_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM claude_connections
    WHERE user_id = p_user_id
  );
END;
$$;


ALTER FUNCTION "public"."has_claude_connection"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."migrate_orphaned_users"() RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  user_record RECORD;
  migration_count INTEGER := 0;
  error_count INTEGER := 0;
  result JSON;
BEGIN
  FOR user_record IN
    SELECT id, email
    FROM public.users
    WHERE account_id IS NULL
    ORDER BY created_at
  LOOP
    BEGIN
      SELECT public.auto_create_user_organization(user_record.id, user_record.email) INTO result;
      IF (result->>'success')::BOOLEAN THEN
        migration_count := migration_count + 1;
      ELSE
        error_count := error_count + 1;
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        error_count := error_count + 1;
    END;
  END LOOP;

  RETURN JSON_BUILD_OBJECT(
    'success', true,
    'migrated_users', migration_count,
    'errors', error_count
  );
END;
$$;


ALTER FUNCTION "public"."migrate_orphaned_users"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."provision_client"("user_id" "uuid", "organization_id" "uuid", "device_name" "text" DEFAULT NULL::"text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  new_client_id TEXT;
  new_sync_token TEXT;
  client_record_id UUID;
BEGIN
  -- Generate unique client_id and sync_token
  new_client_id := 'client_' || REPLACE(gen_random_uuid()::TEXT, '-', '');
  new_sync_token := 'sync_' || REPLACE(gen_random_uuid()::TEXT, '-', '');

  -- Insert client record
  INSERT INTO public.clients (
    user_id,
    organization_id,
    client_id,
    sync_token,
    device_name
  )
  VALUES (
    user_id,
    organization_id,
    new_client_id,
    new_sync_token,
    COALESCE(device_name, 'Unknown Device')
  )
  RETURNING id INTO client_record_id;

  RETURN JSON_BUILD_OBJECT(
    'id', client_record_id,
    'client_id', new_client_id,
    'sync_token', new_sync_token
  );
END;
$$;


ALTER FUNCTION "public"."provision_client"("user_id" "uuid", "organization_id" "uuid", "device_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."setup_user_account"("user_id" "uuid", "account_name" "text", "org_name" "text" DEFAULT NULL::"text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  new_account_id UUID;
  new_org_id UUID;
  new_workspace_id UUID;
  account_slug TEXT;
  org_slug TEXT;
BEGIN
  -- Generate account slug
  account_slug := LOWER(REGEXP_REPLACE(account_name, '[^a-zA-Z0-9]', '-', 'g'));
  account_slug := REGEXP_REPLACE(account_slug, '-+', '-', 'g');
  account_slug := TRIM(BOTH '-' FROM account_slug);

  -- Create account
  INSERT INTO public.accounts (name, slug, owner_id)
  VALUES (account_name, account_slug, user_id)
  RETURNING id INTO new_account_id;

  -- Update user with account_id
  UPDATE public.users
  SET account_id = new_account_id
  WHERE id = user_id;

  -- Create default organization if org_name provided
  IF org_name IS NOT NULL THEN
    org_slug := LOWER(REGEXP_REPLACE(org_name, '[^a-zA-Z0-9]', '-', 'g'));
    org_slug := REGEXP_REPLACE(org_slug, '-+', '-', 'g');
    org_slug := TRIM(BOTH '-' FROM org_slug);

    INSERT INTO public.organizations (name, slug, account_id)
    VALUES (org_name, org_slug, new_account_id)
    RETURNING id INTO new_org_id;

    -- Add user as organization admin (was 'owner')
    INSERT INTO public.organization_memberships (user_id, organization_id, role)
    VALUES (user_id, new_org_id, 'admin');

    -- Create default workspace
    INSERT INTO public.workspaces (name, description, organization_id)
    VALUES (org_name || ' Workspace', 'Default workspace for ' || org_name, new_org_id)
    RETURNING id INTO new_workspace_id;
  END IF;

  RETURN JSON_BUILD_OBJECT(
    'account_id', new_account_id,
    'organization_id', new_org_id,
    'workspace_id', new_workspace_id
  );
END;
$$;


ALTER FUNCTION "public"."setup_user_account"("user_id" "uuid", "account_name" "text", "org_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_sessions_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$                                                                                                                                                                                                                                                                                                                                                                                                                  
  BEGIN                                                                                                                                                                                                                                                                                                                                                                                                                                  
    NEW.updated_at = now();                                                                                                                                                                                                                                                                                                                                                                                                              
    RETURN NEW;                                                                                                                                                                                                                                                                                                                                                                                                                          
  END;                                                                                                                                                                                                                                                                                                                                                                                                                                   
  $$;


ALTER FUNCTION "public"."update_sessions_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_workspace_health"("p_workspace_id" "uuid", "p_is_healthy" boolean, "p_error" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  UPDATE public.workspaces
  SET
    last_health_check = NOW(),
    last_health_error = CASE WHEN p_is_healthy THEN NULL ELSE p_error END,
    sync_status = CASE
      WHEN p_is_healthy THEN 'active'
      WHEN sync_status = 'active' THEN 'error'
      ELSE sync_status
    END,
    updated_at = NOW()
  WHERE id = p_workspace_id;
END;
$$;


ALTER FUNCTION "public"."update_workspace_health"("p_workspace_id" "uuid", "p_is_healthy" boolean, "p_error" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_workspace_infrastructure"("workspace_id" "uuid", "infrastructure_data" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  UPDATE public.workspaces
  SET
    infrastructure_worker_name = infrastructure_data->>'workerName',
    infrastructure_bucket_name = infrastructure_data->>'bucketName',
    infrastructure_workspace_token = infrastructure_data->>'workspaceToken',
    workspace_url = infrastructure_data->>'workerUrl',
    sync_status = 'active',
    updated_at = NOW()
  WHERE id = workspace_id;

  -- Log the infrastructure update
  INSERT INTO public.workspace_activity_log (workspace_id, user_id, action, details)
  VALUES (workspace_id, NULL, 'infrastructure_updated', infrastructure_data);
END;
$$;


ALTER FUNCTION "public"."update_workspace_infrastructure"("workspace_id" "uuid", "infrastructure_data" "jsonb") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "description" "text",
    "owner_id" "uuid",
    "billing_plan" "text" DEFAULT 'free'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "accounts_billing_plan_check" CHECK (("billing_plan" = ANY (ARRAY['free'::"text", 'pro'::"text", 'enterprise'::"text"])))
);


ALTER TABLE "public"."accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "action" "text" NOT NULL,
    "details" json,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."audit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."clients" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "organization_id" "uuid",
    "client_id" "text" NOT NULL,
    "sync_token" "text" NOT NULL,
    "device_name" "text",
    "last_active" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."clients" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organization_invitations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid",
    "email" "text" NOT NULL,
    "role" "text" DEFAULT 'member'::"text",
    "invited_by" "uuid",
    "invite_token" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "accepted_at" timestamp with time zone,
    "accepted_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "organization_invitations_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'member'::"text", 'viewer'::"text"])))
);


ALTER TABLE "public"."organization_invitations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organization_memberships" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "organization_id" "uuid",
    "role" "text" DEFAULT 'member'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "organization_memberships_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'member'::"text", 'viewer'::"text"])))
);


ALTER TABLE "public"."organization_memberships" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organizations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "description" "text",
    "account_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."organizations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text",
    "full_name" "text",
    "avatar_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."project_permissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "project_id" "uuid",
    "permission" "text" NOT NULL,
    "granted_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "project_permissions_permission_check" CHECK (("permission" = ANY (ARRAY['read'::"text", 'write'::"text", 'admin'::"text"])))
);


ALTER TABLE "public"."project_permissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."projects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "workspace_id" "uuid",
    "created_by" "uuid",
    "is_archived" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "remote_url" "text",
    "default_branch" "text" DEFAULT 'main'::"text"
);


ALTER TABLE "public"."projects" OWNER TO "postgres";


COMMENT ON COLUMN "public"."projects"."remote_url" IS 'Git remote URL for project repository (e.g., Gitea)';



COMMENT ON COLUMN "public"."projects"."default_branch" IS 'Default branch name for the project repository';



CREATE TABLE IF NOT EXISTS "public"."sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "text" NOT NULL,
    "project_id" "uuid",
    "user_id" "uuid",
    "branch_name" "text",
    "start_commit" "text",
    "current_commit" "text",
    "base_main_commit" "text",
    "workspace_path" "text",
    "last_turn_at" timestamp with time zone,
    "destroyed_at" timestamp with time zone,
    "r2_path" "text",
    "local_synced_at" timestamp with time zone,
    "remote_synced_at" timestamp with time zone,
    "sync_status" "text" DEFAULT 'local_only'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "full_name" "text",
    "avatar_url" "text",
    "account_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "invite_token" "text"
);


ALTER TABLE "public"."users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workspace_activity_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "action" "text" NOT NULL,
    "details" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."workspace_activity_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workspace_memberships" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" DEFAULT 'member'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "workspace_members_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'admin'::"text", 'member'::"text", 'viewer'::"text"])))
);


ALTER TABLE "public"."workspace_memberships" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workspaces" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "organization_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "slug" "text",
    "plan_type" "text" DEFAULT 'free'::"text",
    "sync_status" "text" DEFAULT 'pending'::"text",
    "workspace_url" "text",
    "infrastructure_worker_name" "text",
    "infrastructure_bucket_name" "text",
    "infrastructure_workspace_token" "text",
    "suspension_reason" "text",
    "last_health_check" timestamp with time zone,
    "last_health_error" "text",
    "created_by" "uuid",
    CONSTRAINT "workspaces_plan_type_check" CHECK (("plan_type" = ANY (ARRAY['free'::"text", 'pro'::"text", 'enterprise'::"text"]))),
    CONSTRAINT "workspaces_sync_status_check" CHECK (("sync_status" = ANY (ARRAY['pending'::"text", 'provisioning'::"text", 'active'::"text", 'suspended'::"text", 'error'::"text", 'deleted'::"text"])))
);


ALTER TABLE "public"."workspaces" OWNER TO "postgres";


ALTER TABLE ONLY "public"."accounts"
    ADD CONSTRAINT "accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."accounts"
    ADD CONSTRAINT "accounts_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claude_connections"
    ADD CONSTRAINT "claude_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claude_connections"
    ADD CONSTRAINT "claude_connections_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_client_id_key" UNIQUE ("client_id");



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organization_invitations"
    ADD CONSTRAINT "organization_invitations_invite_token_key" UNIQUE ("invite_token");



ALTER TABLE ONLY "public"."organization_invitations"
    ADD CONSTRAINT "organization_invitations_organization_id_email_key" UNIQUE ("organization_id", "email");



ALTER TABLE ONLY "public"."organization_invitations"
    ADD CONSTRAINT "organization_invitations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organization_memberships"
    ADD CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organization_memberships"
    ADD CONSTRAINT "organization_memberships_user_id_organization_id_key" UNIQUE ("user_id", "organization_id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_account_id_slug_key" UNIQUE ("account_id", "slug");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_permissions"
    ADD CONSTRAINT "project_permissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_permissions"
    ADD CONSTRAINT "project_permissions_user_id_project_id_key" UNIQUE ("user_id", "project_id");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sessions"
    ADD CONSTRAINT "sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sessions"
    ADD CONSTRAINT "sessions_session_id_key" UNIQUE ("session_id");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workspace_activity_log"
    ADD CONSTRAINT "workspace_activity_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workspace_memberships"
    ADD CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workspace_memberships"
    ADD CONSTRAINT "workspace_members_workspace_id_user_id_key" UNIQUE ("workspace_id", "user_id");



ALTER TABLE ONLY "public"."workspaces"
    ADD CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workspaces"
    ADD CONSTRAINT "workspaces_slug_key" UNIQUE ("slug");



CREATE INDEX "idx_accounts_slug" ON "public"."accounts" USING "btree" ("slug");



CREATE INDEX "idx_audit_log_action" ON "public"."audit_log" USING "btree" ("action");



CREATE INDEX "idx_audit_log_created_at" ON "public"."audit_log" USING "btree" ("created_at");



CREATE INDEX "idx_audit_log_user_id" ON "public"."audit_log" USING "btree" ("user_id");



CREATE INDEX "idx_claude_connections_expires_at" ON "public"."claude_connections" USING "btree" ("expires_at") WHERE ("expires_at" IS NOT NULL);



CREATE INDEX "idx_claude_connections_user_id" ON "public"."claude_connections" USING "btree" ("user_id");



CREATE INDEX "idx_clients_client_id" ON "public"."clients" USING "btree" ("client_id");



CREATE INDEX "idx_clients_org_id" ON "public"."clients" USING "btree" ("organization_id");



CREATE INDEX "idx_clients_user_id" ON "public"."clients" USING "btree" ("user_id");



CREATE INDEX "idx_organization_invitations_email" ON "public"."organization_invitations" USING "btree" ("email");



CREATE INDEX "idx_organization_invitations_expires" ON "public"."organization_invitations" USING "btree" ("expires_at");



CREATE INDEX "idx_organization_invitations_org_id" ON "public"."organization_invitations" USING "btree" ("organization_id");



CREATE INDEX "idx_organization_invitations_token" ON "public"."organization_invitations" USING "btree" ("invite_token");



CREATE INDEX "idx_organization_memberships_org_id" ON "public"."organization_memberships" USING "btree" ("organization_id");



CREATE INDEX "idx_organization_memberships_user_id" ON "public"."organization_memberships" USING "btree" ("user_id");



CREATE INDEX "idx_organizations_account_id" ON "public"."organizations" USING "btree" ("account_id");



CREATE INDEX "idx_organizations_slug" ON "public"."organizations" USING "btree" ("account_id", "slug");



CREATE INDEX "idx_project_permissions_project_id" ON "public"."project_permissions" USING "btree" ("project_id");



CREATE INDEX "idx_project_permissions_user_id" ON "public"."project_permissions" USING "btree" ("user_id");



CREATE INDEX "idx_projects_workspace_id" ON "public"."projects" USING "btree" ("workspace_id");



CREATE INDEX "idx_sessions_destroyed_at" ON "public"."sessions" USING "btree" ("destroyed_at") WHERE ("destroyed_at" IS NULL);



CREATE INDEX "idx_sessions_last_turn_at" ON "public"."sessions" USING "btree" ("last_turn_at" DESC) WHERE ("destroyed_at" IS NULL);



CREATE INDEX "idx_sessions_project_id" ON "public"."sessions" USING "btree" ("project_id");



CREATE INDEX "idx_sessions_user_id" ON "public"."sessions" USING "btree" ("user_id");



CREATE INDEX "idx_users_account_id" ON "public"."users" USING "btree" ("account_id");



CREATE INDEX "idx_users_email" ON "public"."users" USING "btree" ("email");



CREATE INDEX "idx_users_invite_token" ON "public"."users" USING "btree" ("invite_token") WHERE ("invite_token" IS NOT NULL);



CREATE INDEX "idx_workspace_activity_log_workspace_id" ON "public"."workspace_activity_log" USING "btree" ("workspace_id");



CREATE INDEX "idx_workspace_memberships_user_id" ON "public"."workspace_memberships" USING "btree" ("user_id");



CREATE INDEX "idx_workspace_memberships_workspace_id" ON "public"."workspace_memberships" USING "btree" ("workspace_id");



CREATE INDEX "idx_workspaces_org_id" ON "public"."workspaces" USING "btree" ("organization_id");



CREATE INDEX "idx_workspaces_organization_id" ON "public"."workspaces" USING "btree" ("organization_id");



CREATE INDEX "idx_workspaces_sync_status" ON "public"."workspaces" USING "btree" ("sync_status");



CREATE OR REPLACE TRIGGER "sessions_updated_at" BEFORE UPDATE ON "public"."sessions" FOR EACH ROW EXECUTE FUNCTION "public"."update_sessions_updated_at"();



CREATE OR REPLACE TRIGGER "update_claude_connections_updated_at" BEFORE UPDATE ON "public"."claude_connections" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



ALTER TABLE ONLY "public"."accounts"
    ADD CONSTRAINT "accounts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id");



ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."claude_connections"
    ADD CONSTRAINT "claude_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "fk_users_account_id" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id");



ALTER TABLE ONLY "public"."organization_invitations"
    ADD CONSTRAINT "organization_invitations_accepted_by_fkey" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id");



ALTER TABLE ONLY "public"."organization_invitations"
    ADD CONSTRAINT "organization_invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id");



ALTER TABLE ONLY "public"."organization_invitations"
    ADD CONSTRAINT "organization_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organization_memberships"
    ADD CONSTRAINT "organization_memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organization_memberships"
    ADD CONSTRAINT "organization_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."project_permissions"
    ADD CONSTRAINT "project_permissions_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id");



ALTER TABLE ONLY "public"."project_permissions"
    ADD CONSTRAINT "project_permissions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_permissions"
    ADD CONSTRAINT "project_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sessions"
    ADD CONSTRAINT "sessions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sessions"
    ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."workspace_activity_log"
    ADD CONSTRAINT "workspace_activity_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."workspace_activity_log"
    ADD CONSTRAINT "workspace_activity_log_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workspace_memberships"
    ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workspace_memberships"
    ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workspaces"
    ADD CONSTRAINT "workspaces_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."workspaces"
    ADD CONSTRAINT "workspaces_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



CREATE POLICY "Account owners can manage organizations" ON "public"."organizations" USING ((EXISTS ( SELECT 1
   FROM "public"."accounts"
  WHERE (("accounts"."id" = "organizations"."account_id") AND ("accounts"."owner_id" = "auth"."uid"())))));



CREATE POLICY "Account owners can manage their account" ON "public"."accounts" USING (("auth"."uid"() = "owner_id"));



CREATE POLICY "Org admins can delete memberships" ON "public"."organization_memberships" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."organization_memberships" "om"
  WHERE (("om"."organization_id" = "organization_memberships"."organization_id") AND ("om"."user_id" = "auth"."uid"()) AND ("om"."role" = 'admin'::"text")))));



CREATE POLICY "Org admins can insert memberships" ON "public"."organization_memberships" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."organization_memberships" "om"
  WHERE (("om"."organization_id" = "organization_memberships"."organization_id") AND ("om"."user_id" = "auth"."uid"()) AND ("om"."role" = 'admin'::"text")))));



CREATE POLICY "Org admins can manage invitations" ON "public"."organization_invitations" USING ((EXISTS ( SELECT 1
   FROM "public"."organization_memberships"
  WHERE (("organization_memberships"."organization_id" = "organization_invitations"."organization_id") AND ("organization_memberships"."user_id" = "auth"."uid"()) AND ("organization_memberships"."role" = 'admin'::"text")))));



CREATE POLICY "Org admins can manage workspaces" ON "public"."workspaces" USING ((EXISTS ( SELECT 1
   FROM "public"."organization_memberships"
  WHERE (("organization_memberships"."organization_id" = "workspaces"."organization_id") AND ("organization_memberships"."user_id" = "auth"."uid"()) AND ("organization_memberships"."role" = 'admin'::"text")))));



CREATE POLICY "Org admins can update memberships" ON "public"."organization_memberships" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."organization_memberships" "om"
  WHERE (("om"."organization_id" = "organization_memberships"."organization_id") AND ("om"."user_id" = "auth"."uid"()) AND ("om"."role" = 'admin'::"text")))));



CREATE POLICY "Org admins can view org clients" ON "public"."clients" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."organization_memberships"
  WHERE (("organization_memberships"."organization_id" = "clients"."organization_id") AND ("organization_memberships"."user_id" = "auth"."uid"()) AND ("organization_memberships"."role" = 'admin'::"text")))));



CREATE POLICY "Organization members can view workspaces" ON "public"."workspaces" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."organization_memberships"
  WHERE (("organization_memberships"."organization_id" = "workspaces"."organization_id") AND ("organization_memberships"."user_id" = "auth"."uid"())))));



CREATE POLICY "Project admins can manage permissions" ON "public"."project_permissions" USING (((EXISTS ( SELECT 1
   FROM "public"."project_permissions" "pp"
  WHERE (("pp"."project_id" = "project_permissions"."project_id") AND ("pp"."user_id" = "auth"."uid"()) AND ("pp"."permission" = 'admin'::"text")))) OR (EXISTS ( SELECT 1
   FROM (("public"."projects" "p"
     JOIN "public"."workspaces" "w" ON (("w"."id" = "p"."workspace_id")))
     JOIN "public"."organization_memberships" "om" ON (("om"."organization_id" = "w"."organization_id")))
  WHERE (("p"."id" = "project_permissions"."project_id") AND ("om"."user_id" = "auth"."uid"()) AND ("om"."role" = 'admin'::"text"))))));



CREATE POLICY "Project admins can manage projects" ON "public"."projects" USING (((EXISTS ( SELECT 1
   FROM "public"."project_permissions"
  WHERE (("project_permissions"."project_id" = "projects"."id") AND ("project_permissions"."user_id" = "auth"."uid"()) AND ("project_permissions"."permission" = 'admin'::"text")))) OR (EXISTS ( SELECT 1
   FROM ("public"."organization_memberships" "om"
     JOIN "public"."workspaces" "w" ON (("w"."organization_id" = "om"."organization_id")))
  WHERE (("w"."id" = "projects"."workspace_id") AND ("om"."user_id" = "auth"."uid"()) AND ("om"."role" = 'admin'::"text"))))));



CREATE POLICY "Service role full access to workspace_activity_log" ON "public"."workspace_activity_log" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Service role full access to workspace_members" ON "public"."workspace_memberships" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Users can delete their own Claude connections" ON "public"."claude_connections" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own profile" ON "public"."profiles" FOR INSERT WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "Users can insert their own Claude connections" ON "public"."claude_connections" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert their own sessions" ON "public"."sessions" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage their own clients" ON "public"."clients" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can update own profile" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can update own profile" ON "public"."users" FOR UPDATE USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can update their own Claude connections" ON "public"."claude_connections" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update their own sessions" ON "public"."sessions" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view activity for their workspaces" ON "public"."workspace_activity_log" FOR SELECT USING (("workspace_id" IN ( SELECT "workspace_memberships"."workspace_id"
   FROM "public"."workspace_memberships"
  WHERE ("workspace_memberships"."user_id" = "auth"."uid"()))));



CREATE POLICY "Users can view organizations they belong to" ON "public"."organizations" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."organization_memberships"
  WHERE (("organization_memberships"."organization_id" = "organizations"."id") AND ("organization_memberships"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can view own audit logs" ON "public"."audit_log" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own profile" ON "public"."profiles" FOR SELECT USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can view own profile" ON "public"."users" FOR SELECT USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can view projects they have access to" ON "public"."projects" FOR SELECT USING (((EXISTS ( SELECT 1
   FROM "public"."project_permissions"
  WHERE (("project_permissions"."project_id" = "projects"."id") AND ("project_permissions"."user_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM ("public"."organization_memberships" "om"
     JOIN "public"."workspaces" "w" ON (("w"."organization_id" = "om"."organization_id")))
  WHERE (("w"."id" = "projects"."workspace_id") AND ("om"."user_id" = "auth"."uid"()) AND ("om"."role" = 'admin'::"text"))))));



CREATE POLICY "Users can view sessions in their projects" ON "public"."sessions" FOR SELECT USING (("project_id" IN ( SELECT "p"."id"
   FROM (("public"."projects" "p"
     JOIN "public"."workspaces" "w" ON (("p"."workspace_id" = "w"."id")))
     JOIN "public"."workspace_memberships" "wm" ON (("w"."id" = "wm"."workspace_id")))
  WHERE ("wm"."user_id" = "auth"."uid"()))));



CREATE POLICY "Users can view their account" ON "public"."accounts" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."users"
  WHERE (("users"."id" = "auth"."uid"()) AND ("users"."account_id" = "accounts"."id")))));



CREATE POLICY "Users can view their invitations" ON "public"."organization_invitations" FOR SELECT USING ((("email" = (( SELECT "users"."email"
   FROM "auth"."users"
  WHERE ("users"."id" = "auth"."uid"())))::"text") OR ("auth"."uid"() = "invited_by")));



CREATE POLICY "Users can view their memberships" ON "public"."organization_memberships" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can view their own Claude connections" ON "public"."claude_connections" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own sessions" ON "public"."sessions" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their project permissions" ON "public"."project_permissions" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can view workspace memberships they belong to" ON "public"."workspace_memberships" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR ("workspace_id" IN ( SELECT "workspace_memberships_1"."workspace_id"
   FROM "public"."workspace_memberships" "workspace_memberships_1"
  WHERE ("workspace_memberships_1"."user_id" = "auth"."uid"())))));



CREATE POLICY "Workspace admins can manage members" ON "public"."workspace_memberships" USING (("workspace_id" IN ( SELECT "workspace_memberships_1"."workspace_id"
   FROM "public"."workspace_memberships" "workspace_memberships_1"
  WHERE (("workspace_memberships_1"."user_id" = "auth"."uid"()) AND ("workspace_memberships_1"."role" = ANY (ARRAY['owner'::"text", 'admin'::"text"]))))));



ALTER TABLE "public"."accounts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."audit_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."claude_connections" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."clients" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."organization_invitations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."organization_memberships" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."organizations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."project_permissions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."projects" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."workspace_activity_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."workspace_memberships" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."workspaces" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

























































































































































GRANT ALL ON FUNCTION "public"."accept_organization_invitation"("invite_token_param" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."accept_organization_invitation"("invite_token_param" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."accept_organization_invitation"("invite_token_param" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."accept_organization_invitation"("user_id" "uuid", "invite_token_param" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."accept_organization_invitation"("user_id" "uuid", "invite_token_param" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."accept_organization_invitation"("user_id" "uuid", "invite_token_param" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."auto_create_user_organization"("user_id" "uuid", "user_email" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."auto_create_user_organization"("user_id" "uuid", "user_email" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."auto_create_user_organization"("user_id" "uuid", "user_email" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."cleanup_expired_invitations"() TO "anon";
GRANT ALL ON FUNCTION "public"."cleanup_expired_invitations"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."cleanup_expired_invitations"() TO "service_role";



GRANT ALL ON FUNCTION "public"."create_organization_invitation"("org_id" "uuid", "invite_email" "text", "invite_role" "text", "invited_by_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."create_organization_invitation"("org_id" "uuid", "invite_email" "text", "invite_role" "text", "invited_by_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_organization_invitation"("org_id" "uuid", "invite_email" "text", "invite_role" "text", "invited_by_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_sync_workspace"("workspace_name" "text", "workspace_slug" "text", "organization_id" "uuid", "plan_type" "text", "created_by_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."create_sync_workspace"("workspace_name" "text", "workspace_slug" "text", "organization_id" "uuid", "plan_type" "text", "created_by_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_sync_workspace"("workspace_name" "text", "workspace_slug" "text", "organization_id" "uuid", "plan_type" "text", "created_by_user_id" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."claude_connections" TO "anon";
GRANT ALL ON TABLE "public"."claude_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."claude_connections" TO "service_role";



GRANT ALL ON FUNCTION "public"."get_claude_connection"("p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_claude_connection"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_claude_connection"("p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_invitation_details"("invite_token_param" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_invitation_details"("invite_token_param" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_invitation_details"("invite_token_param" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."grant_project_access"("project_id" "uuid", "user_id" "uuid", "permission" "text", "granted_by_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."grant_project_access"("project_id" "uuid", "user_id" "uuid", "permission" "text", "granted_by_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."grant_project_access"("project_id" "uuid", "user_id" "uuid", "permission" "text", "granted_by_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."has_claude_connection"("p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."has_claude_connection"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_claude_connection"("p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."migrate_orphaned_users"() TO "anon";
GRANT ALL ON FUNCTION "public"."migrate_orphaned_users"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."migrate_orphaned_users"() TO "service_role";



GRANT ALL ON FUNCTION "public"."provision_client"("user_id" "uuid", "organization_id" "uuid", "device_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."provision_client"("user_id" "uuid", "organization_id" "uuid", "device_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."provision_client"("user_id" "uuid", "organization_id" "uuid", "device_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."setup_user_account"("user_id" "uuid", "account_name" "text", "org_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."setup_user_account"("user_id" "uuid", "account_name" "text", "org_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."setup_user_account"("user_id" "uuid", "account_name" "text", "org_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_sessions_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_sessions_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_sessions_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_workspace_health"("p_workspace_id" "uuid", "p_is_healthy" boolean, "p_error" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."update_workspace_health"("p_workspace_id" "uuid", "p_is_healthy" boolean, "p_error" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_workspace_health"("p_workspace_id" "uuid", "p_is_healthy" boolean, "p_error" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_workspace_infrastructure"("workspace_id" "uuid", "infrastructure_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."update_workspace_infrastructure"("workspace_id" "uuid", "infrastructure_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_workspace_infrastructure"("workspace_id" "uuid", "infrastructure_data" "jsonb") TO "service_role";


















GRANT ALL ON TABLE "public"."accounts" TO "anon";
GRANT ALL ON TABLE "public"."accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."accounts" TO "service_role";



GRANT ALL ON TABLE "public"."audit_log" TO "anon";
GRANT ALL ON TABLE "public"."audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."clients" TO "anon";
GRANT ALL ON TABLE "public"."clients" TO "authenticated";
GRANT ALL ON TABLE "public"."clients" TO "service_role";



GRANT ALL ON TABLE "public"."organization_invitations" TO "anon";
GRANT ALL ON TABLE "public"."organization_invitations" TO "authenticated";
GRANT ALL ON TABLE "public"."organization_invitations" TO "service_role";



GRANT ALL ON TABLE "public"."organization_memberships" TO "anon";
GRANT ALL ON TABLE "public"."organization_memberships" TO "authenticated";
GRANT ALL ON TABLE "public"."organization_memberships" TO "service_role";



GRANT ALL ON TABLE "public"."organizations" TO "anon";
GRANT ALL ON TABLE "public"."organizations" TO "authenticated";
GRANT ALL ON TABLE "public"."organizations" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."project_permissions" TO "anon";
GRANT ALL ON TABLE "public"."project_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."project_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."projects" TO "anon";
GRANT ALL ON TABLE "public"."projects" TO "authenticated";
GRANT ALL ON TABLE "public"."projects" TO "service_role";



GRANT ALL ON TABLE "public"."sessions" TO "anon";
GRANT ALL ON TABLE "public"."sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."sessions" TO "service_role";



GRANT ALL ON TABLE "public"."users" TO "anon";
GRANT ALL ON TABLE "public"."users" TO "authenticated";
GRANT ALL ON TABLE "public"."users" TO "service_role";



GRANT ALL ON TABLE "public"."workspace_activity_log" TO "anon";
GRANT ALL ON TABLE "public"."workspace_activity_log" TO "authenticated";
GRANT ALL ON TABLE "public"."workspace_activity_log" TO "service_role";



GRANT ALL ON TABLE "public"."workspace_memberships" TO "anon";
GRANT ALL ON TABLE "public"."workspace_memberships" TO "authenticated";
GRANT ALL ON TABLE "public"."workspace_memberships" TO "service_role";



GRANT ALL ON TABLE "public"."workspaces" TO "anon";
GRANT ALL ON TABLE "public"."workspaces" TO "authenticated";
GRANT ALL ON TABLE "public"."workspaces" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































drop extension if exists "pg_net";

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


