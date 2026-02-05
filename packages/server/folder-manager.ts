import { withRLS, db } from './lib/db'
import type { Folder, BreadcrumbItem } from '@claude-agent/shared'

export type FolderInfo = Folder

const MAX_FOLDER_DEPTH = 5
const MAX_FOLDER_NAME_LENGTH = 100

/**
 * Validate folder name.
 * Throws an error if the name is invalid.
 */
export function validateFolderName(name: string): void {
  if (!name || !name.trim()) {
    throw new Error('Folder name cannot be empty')
  }
  if (name.length > MAX_FOLDER_NAME_LENGTH) {
    throw new Error(`Folder name cannot exceed ${MAX_FOLDER_NAME_LENGTH} characters`)
  }
  // Disallow filesystem-unsafe characters
  if (/[<>:"/\\|?*\x00-\x1f]/g.test(name)) {
    throw new Error('Folder name contains invalid characters')
  }
}

/**
 * Check if adding a folder at this parent would exceed max depth.
 * Throws an error if max depth would be exceeded.
 */
export async function checkDepthLimit(
  userId: string,
  projectId: string,
  parentId: string | null,
): Promise<void> {
  if (!parentId) return // Root level is always OK

  let depth = 1
  let currentParentId: string | null = parentId

  while (currentParentId) {
    depth++
    if (depth > MAX_FOLDER_DEPTH) {
      throw new Error(`Maximum folder depth of ${MAX_FOLDER_DEPTH} exceeded`)
    }

    const rows = await withRLS(userId, sql =>
      sql`SELECT parent_id FROM folders WHERE id = ${currentParentId} AND project_id = ${projectId} LIMIT 1`
    )
    const row = rows[0] as { parent_id: string | null } | undefined
    if (!row) break
    currentParentId = row.parent_id
  }
}

/**
 * Create a new folder in a project.
 */
export async function createFolder(
  userId: string,
  projectId: string,
  name: string,
  parentId?: string | null,
): Promise<FolderInfo> {
  validateFolderName(name)
  await checkDepthLimit(userId, projectId, parentId ?? null)

  const rows = await withRLS(userId, sql =>
    sql`INSERT INTO folders (project_id, parent_id, name, created_by)
        VALUES (${projectId}, ${parentId ?? null}, ${name.trim()}, ${userId})
        RETURNING id, project_id, parent_id, name, created_by, created_at, updated_at`
  )

  return rows[0] as FolderInfo
}

/**
 * List folders in a project, optionally filtered by parent.
 *
 * @param parentId - undefined: all folders, null: root folders only, string: children of that parent
 */
export async function listFolders(
  userId: string,
  projectId: string,
  parentId?: string | null,
): Promise<FolderInfo[]> {
  if (parentId === undefined) {
    // All folders in project
    const rows = await withRLS(userId, sql =>
      sql`SELECT id, project_id, parent_id, name, created_by, created_at, updated_at
          FROM folders
          WHERE project_id = ${projectId} AND deleted_at IS NULL
          ORDER BY name ASC`
    )
    return rows as unknown as FolderInfo[]
  }

  // Folders in specific parent (null = root)
  const rows = await withRLS(userId, sql =>
    parentId === null
      ? sql`SELECT id, project_id, parent_id, name, created_by, created_at, updated_at
            FROM folders
            WHERE project_id = ${projectId} AND parent_id IS NULL AND deleted_at IS NULL
            ORDER BY name ASC`
      : sql`SELECT id, project_id, parent_id, name, created_by, created_at, updated_at
            FROM folders
            WHERE project_id = ${projectId} AND parent_id = ${parentId} AND deleted_at IS NULL
            ORDER BY name ASC`
  )
  return rows as unknown as FolderInfo[]
}

/**
 * Get a single folder by ID.
 */
export async function getFolder(
  userId: string,
  projectId: string,
  id: string,
): Promise<FolderInfo | null> {
  const rows = await withRLS(userId, sql =>
    sql`SELECT id, project_id, parent_id, name, created_by, created_at, updated_at
        FROM folders
        WHERE id = ${id} AND project_id = ${projectId} AND deleted_at IS NULL
        LIMIT 1`
  )
  return (rows[0] as FolderInfo | undefined) ?? null
}

/**
 * Rename a folder.
 */
export async function renameFolder(
  userId: string,
  projectId: string,
  id: string,
  name: string,
): Promise<FolderInfo | null> {
  validateFolderName(name)

  const rows = await withRLS(userId, sql =>
    sql`UPDATE folders
        SET name = ${name.trim()}, updated_at = now()
        WHERE id = ${id} AND project_id = ${projectId} AND deleted_at IS NULL
        RETURNING id, project_id, parent_id, name, created_by, created_at, updated_at`
  )
  return (rows[0] as FolderInfo | undefined) ?? null
}

/**
 * Move a folder to a new parent.
 * Validates that we're not creating a cycle (moving folder into itself or descendants)
 * and that the move wouldn't exceed max folder depth (including subtree).
 */
export async function moveFolder(
  userId: string,
  projectId: string,
  id: string,
  newParentId: string | null,
): Promise<FolderInfo | null> {
  // Check we're not moving into ourselves or our descendants
  if (newParentId) {
    let checkId: string | null = newParentId
    while (checkId) {
      if (checkId === id) {
        throw new Error('Cannot move folder into itself or its descendants')
      }
      const rows = await withRLS(userId, sql =>
        sql`SELECT parent_id FROM folders WHERE id = ${checkId} LIMIT 1`
      )
      const row = rows[0] as { parent_id: string | null } | undefined
      checkId = row?.parent_id ?? null
    }
  }

  // Calculate the depth of the new parent location
  let newParentDepth = 0
  if (newParentId) {
    let currentId: string | null = newParentId
    while (currentId) {
      newParentDepth++
      const rows = await withRLS(userId, sql =>
        sql`SELECT parent_id FROM folders WHERE id = ${currentId} AND project_id = ${projectId} LIMIT 1`
      )
      const row = rows[0] as { parent_id: string | null } | undefined
      if (!row) break
      currentId = row.parent_id
    }
  }

  // Calculate the max depth of descendants of the folder being moved
  const subtreeRows = await withRLS(userId, sql =>
    sql`WITH RECURSIVE subtree AS (
          SELECT id, 0 as depth FROM folders WHERE id = ${id} AND project_id = ${projectId} AND deleted_at IS NULL
          UNION ALL
          SELECT f.id, s.depth + 1 FROM folders f
          JOIN subtree s ON f.parent_id = s.id
          WHERE f.deleted_at IS NULL
        )
        SELECT MAX(depth)::int as max_depth FROM subtree`
  )
  const subtreeMaxDepth = (subtreeRows[0] as { max_depth: number } | undefined)?.max_depth ?? 0

  // The total depth would be: new parent depth + 1 (for the folder itself) + subtree depth
  const totalDepth = newParentDepth + 1 + subtreeMaxDepth
  if (totalDepth > MAX_FOLDER_DEPTH) {
    throw new Error(`Maximum folder depth of ${MAX_FOLDER_DEPTH} exceeded`)
  }

  const rows = await withRLS(userId, sql =>
    sql`UPDATE folders
        SET parent_id = ${newParentId}, updated_at = now()
        WHERE id = ${id} AND project_id = ${projectId} AND deleted_at IS NULL
        RETURNING id, project_id, parent_id, name, created_by, created_at, updated_at`
  )
  return (rows[0] as FolderInfo | undefined) ?? null
}

/**
 * Soft delete a folder and its contents.
 * Returns stats about what was deleted.
 *
 * Note: We verify access via RLS first, then use direct db connection
 * for the cascade updates to avoid RLS blocking the system operation.
 */
export async function deleteFolder(
  userId: string,
  projectId: string,
  id: string,
): Promise<{ deleted: boolean; documentsDeleted: number; foldersDeleted: number }> {
  // First verify the user has access and get counts via RLS
  const countRows = await withRLS(userId, sql =>
    sql`WITH RECURSIVE folder_tree AS (
          SELECT id FROM folders WHERE id = ${id} AND project_id = ${projectId} AND deleted_at IS NULL
          UNION ALL
          SELECT f.id FROM folders f
          JOIN folder_tree ft ON f.parent_id = ft.id
          WHERE f.deleted_at IS NULL
        )
        SELECT
          (SELECT COUNT(*)::int FROM folder_tree) - 1 as folders_count,
          (SELECT COUNT(*)::int FROM documents WHERE folder_id IN (SELECT id FROM folder_tree) AND deleted_at IS NULL) as docs_count,
          (SELECT COUNT(*)::int FROM folder_tree WHERE id = ${id}) as exists_check`
  )
  const counts = countRows[0] as { folders_count: number; docs_count: number; exists_check: number } | undefined

  if (!counts || counts.exists_check === 0) {
    return { deleted: false, documentsDeleted: 0, foldersDeleted: 0 }
  }

  // Now do the cascade deletes using direct db connection (bypasses RLS)
  // This is safe because we already verified access above
  await db.begin(async sql => {
    // Soft delete all documents in the folder tree
    await sql`WITH RECURSIVE folder_tree AS (
          SELECT id FROM folders WHERE id = ${id} AND project_id = ${projectId}
          UNION ALL
          SELECT f.id FROM folders f
          JOIN folder_tree ft ON f.parent_id = ft.id
        )
        UPDATE documents SET deleted_at = now()
        WHERE folder_id IN (SELECT id FROM folder_tree) AND deleted_at IS NULL`

    // Soft delete all folders in the tree
    await sql`WITH RECURSIVE folder_tree AS (
          SELECT id FROM folders WHERE id = ${id} AND project_id = ${projectId}
          UNION ALL
          SELECT f.id FROM folders f
          JOIN folder_tree ft ON f.parent_id = ft.id
        )
        UPDATE folders SET deleted_at = now()
        WHERE id IN (SELECT id FROM folder_tree) AND deleted_at IS NULL`
  })

  return {
    deleted: true,
    documentsDeleted: counts.docs_count,
    foldersDeleted: counts.folders_count,
  }
}

/**
 * Get folder contents info (for delete confirmation).
 * Returns counts of documents and subfolders.
 */
export async function getFolderContents(
  userId: string,
  projectId: string,
  id: string,
): Promise<{ documentsCount: number; foldersCount: number } | null> {
  const rows = await withRLS(userId, sql =>
    sql`WITH RECURSIVE folder_tree AS (
          SELECT id FROM folders WHERE id = ${id} AND project_id = ${projectId} AND deleted_at IS NULL
          UNION ALL
          SELECT f.id FROM folders f
          JOIN folder_tree ft ON f.parent_id = ft.id
          WHERE f.deleted_at IS NULL
        )
        SELECT
          (SELECT COUNT(*)::int FROM folder_tree) - 1 as folders_count,
          (SELECT COUNT(*)::int FROM documents WHERE folder_id IN (SELECT id FROM folder_tree) AND deleted_at IS NULL) as docs_count`
  )
  const row = rows[0] as { folders_count: number; docs_count: number } | undefined
  // If folder doesn't exist, folder_tree is empty, so COUNT(*) - 1 = -1
  if (!row || row.folders_count < 0) return null

  return {
    documentsCount: row.docs_count,
    foldersCount: row.folders_count,
  }
}

/**
 * Build breadcrumb path from a folder up to project root.
 * Returns an array of BreadcrumbItems from root to the specified folder.
 */
export async function getBreadcrumb(
  userId: string,
  projectId: string,
  folderId: string | null,
): Promise<BreadcrumbItem[]> {
  if (!folderId) return []

  const rows = await withRLS(userId, sql =>
    sql`WITH RECURSIVE ancestors AS (
          SELECT id, parent_id, name, 1 as depth
          FROM folders
          WHERE id = ${folderId} AND project_id = ${projectId} AND deleted_at IS NULL
          UNION ALL
          SELECT f.id, f.parent_id, f.name, a.depth + 1
          FROM folders f
          JOIN ancestors a ON f.id = a.parent_id
          WHERE f.deleted_at IS NULL
        )
        SELECT id, name FROM ancestors ORDER BY depth DESC`
  )

  return (rows as unknown as { id: string; name: string }[]).map(r => ({
    id: r.id,
    name: r.name,
    type: 'folder' as const,
  }))
}
