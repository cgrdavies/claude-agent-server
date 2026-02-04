import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { streamText, stepCountIs } from 'ai'
import type { SendMessageRequest, StreamEvent } from '@claude-agent/shared'
import { withRLS } from '../lib/db'
import { getModel } from '../lib/providers'
import { createDocumentTools } from '../tools/document-tools'
import {
  loadSessionMessages,
  saveUserMessage,
  saveAssistantMessage,
  saveToolResultMessage,
} from '../lib/messages'

type Env = { Variables: { userId: string; workspaceId: string } }

export const messagesRouter = new Hono<Env>()

/**
 * POST /api/sessions/:sessionId/messages
 *
 * Sends a user message, runs the agent loop (tool calling in a loop),
 * and streams the response as SSE events.
 */
messagesRouter.post('/:sessionId/messages', async (c) => {
  const userId = c.get('userId')
  const workspaceId = c.get('workspaceId')
  const sessionId = c.req.param('sessionId')
  const body = await c.req.json<SendMessageRequest>()

  // Verify session exists and user has access (RLS handles this)
  const sessions = await withRLS(userId, (sql) =>
    sql`SELECT * FROM agent_sessions WHERE id = ${sessionId} LIMIT 1`
  )
  const session = sessions[0] as Record<string, unknown> | undefined

  if (!session) {
    return c.json({ error: 'Session not found' }, 404)
  }

  // Use session's model/provider unless overridden in this message
  const provider = body.provider ?? (session.provider as 'anthropic' | 'openai' | 'openrouter')
  const modelId = body.model ?? (session.model as string)
  const model = getModel(provider, modelId)

  // Save user message
  await saveUserMessage(userId, sessionId, body.content)

  // Load full conversation history for this session
  const previousMessages = await loadSessionMessages(userId, sessionId)

  // Create workspace-scoped tools (needs userId for RLS on doc operations)
  const tools = createDocumentTools(workspaceId, userId)

  return streamSSE(c, async (stream) => {
    let totalTokensIn = 0
    let totalTokensOut = 0
    let stepIndex = 0
    let fullText = ''

    try {
      const result = streamText({
        model,
        messages: previousMessages,
        tools,
        stopWhen: stepCountIs(20),
        system: (session.system_prompt as string) ?? undefined,
        onStepFinish: async (step) => {
          // Persist assistant message after each step
          if (step.text || step.toolCalls?.length) {
            await saveAssistantMessage(userId, sessionId, {
              text: step.text,
              toolCalls: step.toolCalls?.map((tc) => ({
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                input: tc.input,
              })),
              model: modelId,
              tokensIn: step.usage?.inputTokens ?? 0,
              tokensOut: step.usage?.outputTokens ?? 0,
            })
          }

          // Persist tool results
          if (step.toolResults) {
            for (const tr of step.toolResults) {
              await saveToolResultMessage(
                userId,
                sessionId,
                tr.toolCallId,
                tr.toolName,
                tr.output,
              )
            }
          }

          totalTokensIn += step.usage?.inputTokens ?? 0
          totalTokensOut += step.usage?.outputTokens ?? 0
          stepIndex++

          await stream.writeSSE({
            event: 'step-complete',
            data: JSON.stringify({
              type: 'step-complete',
              stepIndex,
              tokensIn: step.usage?.inputTokens ?? 0,
              tokensOut: step.usage?.outputTokens ?? 0,
            } satisfies StreamEvent),
          })
        },
      })

      // Stream text deltas and tool events to the client
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          fullText += part.text
          await stream.writeSSE({
            event: 'text-delta',
            data: JSON.stringify({
              type: 'text-delta',
              delta: part.text,
            } satisfies StreamEvent),
          })
        } else if (part.type === 'tool-call') {
          await stream.writeSSE({
            event: 'tool-call-complete',
            data: JSON.stringify({
              type: 'tool-call-complete',
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              args: part.input as Record<string, unknown>,
            } satisfies StreamEvent),
          })
        } else if (part.type === 'tool-result') {
          await stream.writeSSE({
            event: 'tool-result',
            data: JSON.stringify({
              type: 'tool-result',
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              result: part.output,
              isError: false,
            } satisfies StreamEvent),
          })
        }
      }

      // Update session last_message_at
      await withRLS(userId, (sql) =>
        sql`UPDATE agent_sessions
            SET last_message_at = now(), updated_at = now()
            WHERE id = ${sessionId}`
      )

      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({
          type: 'done',
          text: fullText,
          totalTokensIn,
          totalTokensOut,
          totalSteps: stepIndex,
        } satisfies StreamEvent),
      })
    } catch (err) {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({
          type: 'error',
          error: err instanceof Error ? err.message : String(err),
        } satisfies StreamEvent),
      })
    }
  })
})
