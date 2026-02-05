import { tool } from 'ai'
import { z } from 'zod'

import * as docManager from '../document-manager'
import * as folderManager from '../folder-manager'

const MAX_CONTENT_LENGTH = 50_000 // ~50KB, roughly 12k tokens

function unquote(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length < 2) return trimmed
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if ((first === '"' || first === "'" || first === '`') && last === first) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function oldTextCandidates(oldText: string): string[] {
  const candidates = new Set<string>()
  const add = (value: string) => {
    const trimmed = value.trim()
    if (trimmed) candidates.add(trimmed)
  }

  add(oldText)
  add(unquote(oldText))

  const unquoted = unquote(oldText)
  const headingStripped = unquoted.replace(/^\s{0,3}#{1,6}\s+/, '')
  if (headingStripped !== unquoted) add(headingStripped)

  return [...candidates]
}

/**
 * Creates project-scoped document tools for the AI SDK agent loop.
 * All operations are scoped to the user's project via RLS.
 */
export function createDocumentTools(projectId: string, userId: string) {
  return {
    doc_create: tool({
      description: 'Create a new markdown document. Optionally specify a folder.',
      inputSchema: z.object({
        name: z.string().describe('Document name/title'),
        content: z.string().optional().describe('Initial markdown content'),
        folder_id: z.string().optional().describe('Folder ID to create in. Omit for project root.'),
      }),
      execute: async ({ name, content, folder_id }) => {
        const info = await docManager.createDoc(
          userId,
          projectId,
          name,
          content,
          folder_id,
        )
        return { id: info.id, name: info.name, folder_id: info.folder_id }
      },
    }),

    doc_read: tool({
      description:
        'Read a document as markdown. For large documents, content may be truncated.',
      inputSchema: z.object({
        id: z.string().describe('Document ID'),
      }),
      execute: async ({ id }) => {
        const result = await docManager.readDocAsText(userId, projectId, id)
        if (!result) return { error: 'Document not found' }

        // Guard against large documents crowding the model context.
        let content = result.content
        let truncated = false
        if (content.length > MAX_CONTENT_LENGTH) {
          content = content.slice(0, MAX_CONTENT_LENGTH)
          truncated = true
        }

        return {
          id,
          name: result.name,
          content,
          truncated,
          ...(truncated && {
            note: `Content truncated at ${MAX_CONTENT_LENGTH} characters (document is ${result.content.length} characters total).`,
          }),
        }
      },
    }),

    doc_edit: tool({
      description:
        'Find and replace text in a document. The old_text must match exactly.',
      inputSchema: z.object({
        id: z.string().describe('Document ID'),
        old_text: z.string().describe('Text to find (must match exactly)'),
        new_text: z.string().describe('Text to replace it with'),
      }),
      execute: async ({ id, old_text, new_text }) => {
        try {
          const newText = unquote(new_text)
          const candidates = oldTextCandidates(old_text)
          let success = false

          for (const candidate of candidates) {
            success = await docManager.editDoc(
              userId,
              projectId,
              id,
              candidate,
              newText,
            )
            if (success) break
          }

          if (!success)
            return { success: false, error: 'old_text not found in document' }
          return { success: true }
        } catch (err) {
          return { success: false, error: String(err) }
        }
      },
    }),

    doc_append: tool({
      description: 'Append markdown content to the end of a document.',
      inputSchema: z.object({
        id: z.string().describe('Document ID'),
        content: z.string().describe('Markdown content to append'),
      }),
      execute: async ({ id, content }) => {
        try {
          await docManager.appendDoc(userId, projectId, id, content)
          return { success: true }
        } catch (err) {
          return { success: false, error: String(err) }
        }
      },
    }),

    doc_list: tool({
      description: 'List documents in the project. Supports pagination for large projects.',
      inputSchema: z.object({
        folder_id: z
          .string()
          .nullable()
          .optional()
          .describe('Folder ID to list. Omit for all documents. Use null for project root.'),
        limit: z.number().optional().describe('Max documents to return (default 50, max 100)'),
        offset: z.number().optional().describe('Skip this many documents (for pagination)'),
      }),
      execute: async ({ folder_id, limit, offset }) => {
        const safeLimit = Math.min(limit ?? 50, 100)
        const safeOffset = Math.max(offset ?? 0, 0)

        const result = await docManager.listDocsPage(userId, projectId, {
          folderId: folder_id,
          limit: safeLimit,
          offset: safeOffset,
        })

        return {
          documents: result.documents.map((d) => ({
            id: d.id,
            name: d.name,
            folder_id: d.folder_id,
          })),
          total: result.total,
          limit: safeLimit,
          offset: safeOffset,
        }
      },
    }),

    doc_search: tool({
      description: 'Search documents by name (case-insensitive).',
      inputSchema: z.object({
        query: z.string().describe('Search query (matched against document name)'),
        limit: z.number().optional().describe('Max results to return (default 20, max 100)'),
      }),
      execute: async ({ query, limit }) => {
        const results = await docManager.searchDocs(
          userId,
          projectId,
          query,
          limit ?? 20,
        )
        return {
          documents: results.map((d) => ({
            id: d.id,
            name: d.name,
            folder_id: d.folder_id,
          })),
        }
      },
    }),

    doc_move: tool({
      description: 'Move a document to a different folder.',
      inputSchema: z.object({
        id: z.string().describe('Document ID'),
        folder_id: z.string().nullable().describe('Target folder ID, or null for project root'),
      }),
      execute: async ({ id, folder_id }) => {
        await docManager.moveDoc(userId, projectId, id, folder_id)
        return { success: true }
      },
    }),

    doc_delete: tool({
      description: 'Delete a document permanently. This cannot be undone.',
      inputSchema: z.object({
        id: z.string().describe('Document ID'),
      }),
      execute: async ({ id }) => {
        await docManager.deleteDoc(userId, projectId, id)
        return { success: true }
      },
    }),

    folder_create: tool({
      description: 'Create a new folder.',
      inputSchema: z.object({
        name: z.string().describe('Folder name'),
        parent_id: z.string().optional().describe('Parent folder ID. Omit for project root.'),
      }),
      execute: async ({ name, parent_id }) => {
        const folder = await folderManager.createFolder(userId, projectId, name, parent_id)
        return { id: folder.id, name: folder.name, parent_id: folder.parent_id }
      },
    }),

    folder_list: tool({
      description: 'List folders.',
      inputSchema: z.object({
        parent_id: z.string().optional().describe('Parent folder ID. Omit for all folders.'),
      }),
      execute: async ({ parent_id }) => {
        const folders = await folderManager.listFolders(userId, projectId, parent_id)
        return { folders: folders.map(f => ({ id: f.id, name: f.name, parent_id: f.parent_id })) }
      },
    }),
  }
}
