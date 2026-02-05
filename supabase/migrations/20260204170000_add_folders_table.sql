-- ============================================================
-- Add explicit folders table for project hierarchy
-- ============================================================

-- 1. Create folders table
CREATE TABLE folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,  -- soft delete

  -- No duplicate folder names in same parent (within project)
  CONSTRAINT folders_unique_name_in_parent
    UNIQUE NULLS NOT DISTINCT (project_id, parent_id, name)
);

-- 2. Add indexes
CREATE INDEX idx_folders_project ON folders(project_id);
CREATE INDEX idx_folders_parent ON folders(parent_id);
CREATE INDEX idx_folders_project_parent ON folders(project_id, parent_id);

-- 3. Add folder_id to documents (nullable = root level)
ALTER TABLE documents
  ADD COLUMN folder_id UUID REFERENCES folders(id) ON DELETE SET NULL;

-- 4. Create index for documents by folder
CREATE INDEX idx_documents_folder ON documents(folder_id);

-- 5. Add unique constraint: no duplicate doc names in same folder
ALTER TABLE documents
  ADD CONSTRAINT documents_unique_name_in_folder
    UNIQUE NULLS NOT DISTINCT (project_id, folder_id, name);

-- 6. RLS policies for folders
ALTER TABLE folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY folders_select ON folders FOR SELECT USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
  )
  AND deleted_at IS NULL
);

CREATE POLICY folders_insert ON folders FOR INSERT WITH CHECK (
  created_by = auth.uid()
  AND project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
  )
);

CREATE POLICY folders_update ON folders FOR UPDATE USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
  )
)
WITH CHECK (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
  )
);

CREATE POLICY folders_delete ON folders FOR DELETE USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
  )
);

-- 7. Function to check folder depth (max 5 levels)
-- Uses SECURITY DEFINER to bypass RLS for the depth check query
CREATE OR REPLACE FUNCTION check_folder_depth()
RETURNS TRIGGER
SECURITY DEFINER
AS $$
DECLARE
  depth INTEGER := 1;
  current_parent UUID := NEW.parent_id;
BEGIN
  -- Skip depth check if this is an UPDATE that doesn't change parent_id
  -- (e.g., soft delete only changes deleted_at)
  IF TG_OP = 'UPDATE' AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id THEN
    RETURN NEW;
  END IF;

  WHILE current_parent IS NOT NULL LOOP
    depth := depth + 1;
    IF depth > 5 THEN
      RAISE EXCEPTION 'Maximum folder depth of 5 exceeded';
    END IF;
    SELECT parent_id INTO current_parent FROM folders WHERE id = current_parent;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_folder_depth
  BEFORE INSERT OR UPDATE ON folders
  FOR EACH ROW
  EXECUTE FUNCTION check_folder_depth();

-- 8. Cascade soft delete is handled in application code (folder-manager.ts)
-- This avoids RLS issues with triggers trying to update rows without proper user context.
-- The application code does the cascade manually in a single transaction.

-- 9. Add deleted_at to documents if not exists
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- 10. Update documents RLS to exclude soft-deleted
DROP POLICY IF EXISTS documents_select ON documents;
CREATE POLICY documents_select ON documents FOR SELECT USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
  )
  AND deleted_at IS NULL
);
