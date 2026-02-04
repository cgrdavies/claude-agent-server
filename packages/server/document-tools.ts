import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import * as docManager from './document-manager'

export const docCreate = tool(
  'doc_create',
  'Create a new markdown document in the workspace',
  {
    name: z.string().describe('Document name/title'),
    content: z.string().optional().describe('Initial markdown content'),
  },
  async ({ name, content }) => {
    const id = crypto.randomUUID()
    docManager.createDoc(id, name, content)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ id, name }) }],
    }
  },
)

export const docRead = tool(
  'doc_read',
  'Read a document as markdown. Returns the full document content.',
  {
    id: z.string().describe('Document ID'),
  },
  async ({ id }) => {
    const content = docManager.readDocAsText(id)
    if (content === null) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Document not found' }) }],
        isError: true,
      }
    }
    const info = docManager.getDocInfo(id)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ id, name: info?.name, content }) }],
    }
  },
)

export const docEdit = tool(
  'doc_edit',
  'Find and replace text in a document. The old_text must match exactly. The edit is applied as a Yjs transaction, so connected editors see the change atomically.',
  {
    id: z.string().describe('Document ID'),
    old_text: z.string().describe('Text to find (must match exactly)'),
    new_text: z.string().describe('Text to replace it with'),
  },
  async ({ id, old_text, new_text }) => {
    try {
      const success = docManager.editDoc(id, old_text, new_text)
      if (!success) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'old_text not found in document' }),
          }],
        }
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error) }) }],
        isError: true,
      }
    }
  },
)

export const docAppend = tool(
  'doc_append',
  'Append markdown content to the end of a document. Useful for building a document incrementally.',
  {
    id: z.string().describe('Document ID'),
    content: z.string().describe('Markdown content to append'),
  },
  async ({ id, content }) => {
    try {
      docManager.appendDoc(id, content)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error) }) }],
        isError: true,
      }
    }
  },
)

export const docList = tool(
  'doc_list',
  'List all documents in the workspace with their IDs, names, and timestamps.',
  {},
  async () => {
    const documents = docManager.listDocs()
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ documents }) }],
    }
  },
)

export const docDelete = tool(
  'doc_delete',
  'Delete a document permanently. This cannot be undone.',
  {
    id: z.string().describe('Document ID'),
  },
  async ({ id }) => {
    docManager.deleteDoc(id)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
    }
  },
)

export const documentToolsServer = createSdkMcpServer({
  name: 'document-tools',
  tools: [docCreate, docRead, docEdit, docAppend, docList, docDelete],
})
