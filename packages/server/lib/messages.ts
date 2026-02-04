import type { SQL } from 'bun'
import type { ModelMessage } from 'ai'
import { withRLS } from './db'

/**
 * Load all messages for a session, ordered by creation time.
 * Returns ModelMessage[] suitable for passing directly to AI SDK.
 */
export async function loadSessionMessages(
  userId: string,
  sessionId: string,
): Promise<ModelMessage[]> {
  const rows = await withRLS(userId, (sql) =>
    sql`SELECT * FROM messages
        WHERE session_id = ${sessionId}
        ORDER BY created_at ASC`
  )
  return rows.map(rowToModelMessage)
}

/**
 * Persist a user message to the database.
 */
export async function saveUserMessage(
  userId: string,
  sessionId: string,
  content: string,
) {
  await withRLS(userId, (sql) =>
    sql`INSERT INTO messages (session_id, role, content)
        VALUES (${sessionId}, 'user', ${JSON.stringify(content)})`
  )
}

/**
 * Persist an assistant message. Stores the full content array including
 * both text parts and tool-call parts as a single JSON value.
 */
export async function saveAssistantMessage(
  userId: string,
  sessionId: string,
  opts: {
    text: string
    toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>
    model: string
    tokensIn: number
    tokensOut: number
  },
) {
  // Build the content array in ModelMessage format
  const contentParts: unknown[] = []
  if (opts.text) {
    contentParts.push({ type: 'text', text: opts.text })
  }
  if (opts.toolCalls?.length) {
    for (const tc of opts.toolCalls) {
      contentParts.push({
        type: 'tool-call',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.input,
      })
    }
  }

  // If only text and no tool calls, store as plain string for simplicity
  const content = contentParts.length === 1 && !opts.toolCalls?.length
    ? JSON.stringify(opts.text)
    : JSON.stringify(contentParts)

  await withRLS(userId, (sql) =>
    sql`INSERT INTO messages (session_id, role, content, model, tokens_in, tokens_out)
        VALUES (
          ${sessionId},
          'assistant',
          ${content},
          ${opts.model},
          ${opts.tokensIn},
          ${opts.tokensOut}
        )`
  )
}

/**
 * Persist a tool result message. Stores the full tool-result content
 * part so it can be replayed directly.
 */
export async function saveToolResultMessage(
  userId: string,
  sessionId: string,
  toolCallId: string,
  toolName: string,
  result: unknown,
) {
  const content = JSON.stringify([{
    type: 'tool-result',
    toolCallId,
    toolName,
    result,
  }])

  await withRLS(userId, (sql) =>
    sql`INSERT INTO messages (session_id, role, content)
        VALUES (${sessionId}, 'tool', ${content})`
  )
}

/**
 * Convert a DB row back to a ModelMessage for AI SDK replay.
 * Since we store the content in ModelMessage format, reconstruction
 * is just JSON.parse + wrapping with the role.
 */
function rowToModelMessage(row: Record<string, unknown>): ModelMessage {
  const role = row.role as string
  const content = JSON.parse(row.content as string)

  return { role, content } as ModelMessage
}
