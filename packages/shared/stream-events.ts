/**
 * SSE event types for the POST /sessions/:id/messages streaming endpoint.
 * Each event is sent as: `event: <type>\ndata: <JSON>\n\n`
 */

/** Assistant is producing text */
export type TextDeltaEvent = {
  type: 'text-delta'
  delta: string
}

/** Tool call is complete, execution is starting */
export type ToolCallCompleteEvent = {
  type: 'tool-call-complete'
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
}

/** Tool has finished executing, result is available */
export type ToolResultEvent = {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  result: unknown
  isError: boolean
}

/** A full step (LLM round-trip) has completed. */
export type StepCompleteEvent = {
  type: 'step-complete'
  /** Step number in the agent loop (1-based). Increments after each LLM round-trip. */
  stepIndex: number
  tokensIn: number
  tokensOut: number
}

/** The agent loop has finished (no more tool calls or step limit reached) */
export type DoneEvent = {
  type: 'done'
  /** The final assistant text (full, not delta) */
  text: string
  totalTokensIn: number
  totalTokensOut: number
  /** Total LLM round-trips in this response */
  totalSteps: number
}

/** An error occurred during generation */
export type ErrorEvent = {
  type: 'error'
  error: string
  code?: string
}

export type StreamEvent =
  | TextDeltaEvent
  | ToolCallCompleteEvent
  | ToolResultEvent
  | StepCompleteEvent
  | DoneEvent
  | ErrorEvent
