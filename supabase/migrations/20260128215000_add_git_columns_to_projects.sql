-- Migration: Add git-related columns to projects table for Dev A (Git-backed project files)
-- Part of: Unified Plan - Git-Backed Project Files + Conversation Sync

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS remote_url TEXT,           -- Git remote URL (Gitea)
  ADD COLUMN IF NOT EXISTS default_branch TEXT DEFAULT 'main';

COMMENT ON COLUMN public.projects.remote_url IS 'Git remote URL for project repository (e.g., Gitea)';
COMMENT ON COLUMN public.projects.default_branch IS 'Default branch name for the project repository';
