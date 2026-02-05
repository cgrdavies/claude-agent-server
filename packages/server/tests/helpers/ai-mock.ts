/**
 * AI SDK mock helpers for tests.
 *
 * Uses the Vercel AI SDK's built-in test utilities to create
 * deterministic mock models that don't make real API calls.
 */

import { MockLanguageModelV3 } from 'ai/test'
import { simulateReadableStream } from 'ai'
import type { LanguageModel } from 'ai'

export interface MockModelOptions {
  /** The text response to return */
  response?: string
  /** Tool calls to include in the response */
  toolCalls?: Array<{
    toolCallId: string
    toolName: string
    args: Record<string, unknown>
  }>
  /** Token usage to report */
  usage?: { inputTokens: number; outputTokens: number }
  /** Finish reason */
  finishReason?: 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error'
  /** Whether to simulate streaming */
  streaming?: boolean
  /** Delay between stream chunks (ms) */
  chunkDelayMs?: number
  /** Simulate an error */
  error?: Error
}

/**
 * Create a mock language model with controlled responses.
 * The mock is stateful for tool calls - it will only return tool calls
 * on the first call, then return just text on subsequent calls.
 *
 * @example
 * ```ts
 * const model = createMockModel({
 *   response: 'Hello, world!',
 *   streaming: true,
 * })
 * ```
 */
export function createMockModel(options: MockModelOptions = {}): LanguageModel {
  const {
    response = 'Mock response',
    toolCalls = [],
    usage = { inputTokens: 10, outputTokens: 20 },
    finishReason = toolCalls.length > 0 ? 'tool-calls' : 'stop',
    streaming = false,
    chunkDelayMs = 0,
    error,
  } = options

  // Track whether we've already returned tool calls
  // This ensures the agent loop terminates after one round of tool use
  let toolCallsReturned = false

  if (error) {
    return new MockLanguageModelV3({
      doGenerate: async () => { throw error },
      doStream: async () => { throw error },
    }) as unknown as LanguageModel
  }

  if (streaming) {
    return new MockLanguageModelV3({
      doStream: (async () => {
        // Only return tool calls on first invocation
        const currentToolCalls = toolCallsReturned ? [] : toolCalls
        const currentFinishReason = toolCallsReturned ? 'stop' : finishReason
        toolCallsReturned = toolCalls.length > 0

        return {
          stream: simulateReadableStream({
            initialDelayInMs: chunkDelayMs,
            chunkDelayInMs: chunkDelayMs,
            chunks: buildStreamChunks(response, currentToolCalls, usage, currentFinishReason),
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        }
      }) as never,
    }) as unknown as LanguageModel
  }

  return new MockLanguageModelV3({
    doGenerate: (async () => {
      // Only return tool calls on first invocation
      const currentToolCalls = toolCallsReturned ? [] : toolCalls
      const currentFinishReason = toolCallsReturned ? 'stop' : finishReason
      toolCallsReturned = toolCalls.length > 0

      return {
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: currentFinishReason,
        usage: {
          inputTokens: { total: usage.inputTokens },
          outputTokens: { total: usage.outputTokens },
        },
        text: response,
        content: [{ type: 'text' as const, text: response }],
        warnings: [],
        toolCalls: currentToolCalls.map((tc) => ({
          toolCallType: 'function' as const,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.args, // AI SDK v6 expects 'input' not 'args'
        })),
      }
    }) as never,
  }) as unknown as LanguageModel
}

/**
 * Build stream chunks for the mock model.
 * Uses AI SDK v6 format for usage: { inputTokens: { total }, outputTokens: { total } }
 */
function buildStreamChunks(
  response: string,
  toolCalls: MockModelOptions['toolCalls'],
  usage: { inputTokens: number; outputTokens: number },
  finishReason: string
) {
  const chunks: unknown[] = []

  // Text chunks
  if (response) {
    chunks.push({ type: 'text-start', id: 'text-1' })

    // Split response into words for more realistic streaming
    const words = response.split(' ')
    for (let i = 0; i < words.length; i++) {
      const word = i === 0 ? words[i] : ' ' + words[i]
      chunks.push({ type: 'text-delta', id: 'text-1', delta: word })
    }

    chunks.push({ type: 'text-end', id: 'text-1' })
  }

  // Tool call chunks - AI SDK v6 expects 'input' not 'args'
  for (const tc of toolCalls ?? []) {
    chunks.push({
      type: 'tool-call',
      toolCallType: 'function',
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      input: tc.args, // Must be object, not JSON string
    })
  }

  // Finish chunk - AI SDK v6 expects nested usage structure
  chunks.push({
    type: 'finish',
    finishReason: { unified: finishReason, raw: undefined },
    usage: {
      inputTokens: { total: usage.inputTokens },
      outputTokens: { total: usage.outputTokens },
    },
  })

  return chunks
}

/**
 * Create a mock model that makes tool calls.
 *
 * @example
 * ```ts
 * const model = createToolCallingMock([
 *   { name: 'doc_create', args: { name: 'test.md', content: 'Hello' } },
 * ])
 * ```
 */
export function createToolCallingMock(
  tools: Array<{ name: string; args: Record<string, unknown> }>,
  options?: Omit<MockModelOptions, 'toolCalls'>
): LanguageModel {
  return createMockModel({
    ...options,
    toolCalls: tools.map((t, i) => ({
      toolCallId: `call_${i}`,
      toolName: t.name,
      args: t.args,
    })),
  })
}

/**
 * Create a mock model that simulates a rate limit error.
 */
export function createRateLimitMock(): LanguageModel {
  const error = new Error('Rate limit exceeded')
  ;(error as unknown as { status: number }).status = 429
  return createMockModel({ error })
}

/**
 * Create a mock model that simulates a network error.
 */
export function createNetworkErrorMock(): LanguageModel {
  return createMockModel({ error: new Error('Network error') })
}

/**
 * Module mock setup for replacing the providers module.
 * Call this with Bun's mock.module() in your test setup.
 *
 * @example
 * ```ts
 * import { mock } from 'bun:test'
 * import { createProvidersMock } from './helpers/ai-mock'
 *
 * mock.module('../../lib/providers', () =>
 *   createProvidersMock({ response: 'Test response', streaming: true })
 * )
 * ```
 */
export function createProvidersMock(options: MockModelOptions = {}) {
  const mockModel = createMockModel(options)

  return {
    getModel: () => mockModel,
    DEFAULT_MODEL: 'mock-model',
    DEFAULT_PROVIDER: 'mock',
  }
}
