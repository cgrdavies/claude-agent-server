-- ============================================================================
-- Migration: Add Git Provider Configuration (Provider-Agnostic Design)
--
-- This migration adds:
-- 1. Workspace-level git provider settings (type, URL, organization)
-- 2. User-level encrypted git credentials table
-- 3. RLS policies for secure credential access
-- ============================================================================

-- ============================================================================
-- Part 1: Workspace Git Provider Configuration
-- ============================================================================

ALTER TABLE public.workspaces
ADD COLUMN IF NOT EXISTS git_provider_type TEXT,
ADD COLUMN IF NOT EXISTS git_provider_url TEXT,
ADD COLUMN IF NOT EXISTS git_organization TEXT;

COMMENT ON COLUMN public.workspaces.git_provider_type IS 'Git provider type: gitea, github, gitlab';
COMMENT ON COLUMN public.workspaces.git_provider_url IS 'Git provider server URL (e.g., https://gitea.example.com)';
COMMENT ON COLUMN public.workspaces.git_organization IS 'Optional organization/owner for repository creation';

-- ============================================================================
-- Part 2: User Git Credentials Table (Provider-Agnostic)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.git_credentials (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    encrypted_token TEXT NOT NULL,
    username TEXT NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT git_credentials_user_id_key UNIQUE (user_id)
);

COMMENT ON TABLE public.git_credentials IS 'Encrypted git credentials per user (provider-agnostic)';
COMMENT ON COLUMN public.git_credentials.encrypted_token IS 'AES-256-CBC encrypted Personal Access Token or OAuth token';
COMMENT ON COLUMN public.git_credentials.username IS 'Git username for URL construction';
COMMENT ON COLUMN public.git_credentials.metadata IS 'Optional metadata (scopes, provider hints, etc.)';

-- ============================================================================
-- Part 3: Indexes
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_git_credentials_user_id ON public.git_credentials USING btree (user_id);

-- ============================================================================
-- Part 4: Updated_at Trigger
-- ============================================================================

CREATE OR REPLACE TRIGGER update_git_credentials_updated_at
    BEFORE UPDATE ON public.git_credentials
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================================
-- Part 5: RLS Policies
-- ============================================================================

ALTER TABLE public.git_credentials ENABLE ROW LEVEL SECURITY;

-- Users can view their own git credentials
CREATE POLICY "Users can view their own git credentials"
    ON public.git_credentials
    FOR SELECT
    USING (auth.uid() = user_id);

-- Users can insert their own git credentials
CREATE POLICY "Users can insert their own git credentials"
    ON public.git_credentials
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own git credentials
CREATE POLICY "Users can update their own git credentials"
    ON public.git_credentials
    FOR UPDATE
    USING (auth.uid() = user_id);

-- Users can delete their own git credentials
CREATE POLICY "Users can delete their own git credentials"
    ON public.git_credentials
    FOR DELETE
    USING (auth.uid() = user_id);

-- ============================================================================
-- Part 6: Grants
-- ============================================================================

GRANT ALL ON TABLE public.git_credentials TO authenticated;
GRANT ALL ON TABLE public.git_credentials TO service_role;
