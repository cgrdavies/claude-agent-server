import { tool } from 'ai'
import { z } from 'zod'

import * as docManager from '../document-manager'
import * as folderManager from '../folder-manager'

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
        'Read a document as markdown. Returns the full document content.',
      inputSchema: z.object({
        id: z.string().describe('Document ID'),
      }),
      execute: async ({ id }) => {
        const result = await docManager.readDocAsText(userId, projectId, id)
        if (!result) return { error: 'Document not found' }
        return { id, name: result.name, content: result.content }
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
      description: 'List documents. Optionally filter by folder.',
      inputSchema: z.object({
        folder_id: z.string().optional().describe('Folder ID to list. Omit for all documents.'),
      }),
      execute: async ({ folder_id }) => {
        const docs = await docManager.listDocs(userId, projectId, folder_id)
        return { documents: docs.map(d => ({ id: d.id, name: d.name, folder_id: d.folder_id })) }
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
