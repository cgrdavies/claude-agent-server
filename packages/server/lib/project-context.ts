import { withRLS } from './db'
import { getBreadcrumb } from '../folder-manager'

/**
 * Document summary for system prompt inclusion (small projects).
 *
 * Note: The domain model uses folder IDs (not path strings). For the system
 * prompt we present a human-readable "folder_path" derived from folder
 * breadcrumbs, e.g. "/" or "/Design/Backend/".
 */
export type DocSummary = {
  id: string
  name: string
  folder_path: string
  updated_at: string
}

/**
 * Project context for AI system prompt.
 */
export type ProjectContext = {
  projectId: string
  projectName: string
  documentCount: number
  /** For small projects: list of docs. Empty for large projects. */
  documents: DocSummary[]
  /** True if project has more docs than can fit in prompt */
  isLargeProject: boolean
}

const SMALL_PROJECT_DOC_LIMIT = 20

function breadcrumbToPath(names: string[]): string {
  if (names.length === 0) return '/'
  return `/${names.join('/')}/`
}

/**
 * Build project context for AI system prompt injection.
 *
 * Small projects (<=20 docs): returns a doc list ordered by most recently updated.
 * Large projects: returns count only; the AI should use tools to query.
 */
export async function buildProjectContext(
  userId: string,
  projectId: string,
): Promise<ProjectContext | null> {
  // Get project info
  const projectRows = await withRLS(userId, (sql) =>
    sql`SELECT id, name
        FROM projects
        WHERE id = ${projectId} AND deleted_at IS NULL
        LIMIT 1`,
  )
  const project = projectRows[0] as { id: string; name: string } | undefined
  if (!project) return null

  // Count documents (exclude soft-deleted)
  const countRows = await withRLS(userId, (sql) =>
    sql`SELECT COUNT(*)::int as count
        FROM documents
        WHERE project_id = ${projectId} AND deleted_at IS NULL`,
  )
  const documentCount = (countRows[0] as { count: number } | undefined)?.count ?? 0

  const isLargeProject = documentCount > SMALL_PROJECT_DOC_LIMIT
  const documents: DocSummary[] = []

  if (!isLargeProject && documentCount > 0) {
    const docRows = await withRLS(userId, (sql) =>
      sql`SELECT id, name, folder_id, updated_at
          FROM documents
          WHERE project_id = ${projectId} AND deleted_at IS NULL
          ORDER BY updated_at DESC
          LIMIT ${SMALL_PROJECT_DOC_LIMIT}`,
    )

    for (const row of docRows as unknown as Array<{
      id: string
      name: string
      folder_id: string | null
      updated_at: string
    }>) {
      const breadcrumb = await getBreadcrumb(userId, projectId, row.folder_id)
      documents.push({
        id: row.id,
        name: row.name,
        folder_path: breadcrumbToPath(breadcrumb.map((b) => b.name)),
        updated_at: row.updated_at,
      })
    }
  }

  return {
    projectId: project.id,
    projectName: project.name,
    documentCount,
    documents,
    isLargeProject,
  }
}

/**
 * Format project context as markdown for system prompt injection.
 */
export function formatProjectContextPrompt(context: ProjectContext): string {
  const lines: string[] = [
    `## Project Context`,
    ``,
    `You are working in project "${context.projectName}".`,
    ``,
  ]

  if (context.isLargeProject) {
    lines.push(
      `This project contains ${context.documentCount} documents. Use the document tools to:`,
      `- \`doc_list\` - List documents (supports pagination with \`folder_id\`, \`limit\`, and \`offset\`)`,
      `- \`doc_search\` - Search documents by name`,
      `- \`doc_read\` - Read a specific document by ID`,
      ``,
      `When the user mentions a document by name, use doc_search to find it first.`,
    )
  } else if (context.documents.length > 0) {
    lines.push(`### Documents in this project:`)
    lines.push(``)
    for (const doc of context.documents) {
      const pathDisplay = doc.folder_path === '/' ? '' : ` (${doc.folder_path})`
      lines.push(`- **${doc.name}**${pathDisplay} - ID: \`${doc.id}\``)
    }
    lines.push(``)
    lines.push(`You can read any document using \`doc_read\` with its ID.`)
  } else {
    lines.push(`This project has no documents yet. Use \`doc_create\` to create one.`)
  }

  return lines.join('\n')
}

