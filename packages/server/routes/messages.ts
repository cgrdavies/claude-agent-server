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
 * POST /api/projects/:projectId/sessions/:sessionId/messages
 *
 * Sends a user message, runs the agent loop (tool calling in a loop),
 * and streams the response as SSE events.
 */
messagesRouter.post('/:sessionId/messages', async (c) => {
  const userId = c.get('userId')
  const workspaceId = c.get('workspaceId')
  const projectIdParam = c.req.param('projectId')
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

  const sessionWorkspaceId = session.workspace_id as string | undefined
  if (sessionWorkspaceId && sessionWorkspaceId !== workspaceId) {
    return c.json({ error: 'Session not found' }, 404)
  }

  const projectId = session.project_id as string | undefined
  if (!projectId) {
    return c.json({ error: 'Session has no project_id' }, 400)
  }

  // If this handler is mounted under /api/projects/:projectId/sessions, enforce scoping.
  if (projectIdParam && projectIdParam !== projectId) {
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

  // Create project-scoped tools (needs userId for RLS on doc operations)
  const tools = createDocumentTools(projectId, userId)

  return streamSSE(c, async (stream) => {
    // Send an initial event immediately to establish the SSE connection
    // This ensures errors can be sent back to the client
    await stream.writeSSE({
      event: 'started',
      data: JSON.stringify({ type: 'started', sessionId }),
    })

    let totalTokensIn = 0
    let totalTokensOut = 0
    let stepIndex = 0
    let fullText = ''

    try {
      const result = streamText({
        // Reduce retries to fail faster on rate limits
        maxRetries: 2,
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
      // Extract useful error details, especially for rate limits
      let errorMessage = err instanceof Error ? err.message : String(err)
      let errorCode: string | undefined

      // Check for rate limit errors from Anthropic/AI SDK
      const errAny = err as Record<string, unknown>
      if (errAny.statusCode === 429 || errorMessage.includes('rate limit')) {
        errorCode = 'rate_limit'
        // Try to extract retry-after if available
        const retryAfter = (errAny.responseHeaders as Record<string, string>)?.['retry-after']
        if (retryAfter) {
          errorMessage = `Rate limit exceeded. Please wait ${retryAfter} seconds and try again.`
        } else {
          errorMessage = 'Rate limit exceeded. Please wait a moment and try again.'
        }
      }

      console.error(`[messages] Error in stream:`, errorCode ?? 'unknown', errorMessage)

      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({
          type: 'error',
          error: errorMessage,
          code: errorCode,
        } satisfies StreamEvent),
      })
    }
  })
})
