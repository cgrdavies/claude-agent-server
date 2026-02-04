import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'
import type { Provider } from '@claude-agent/shared'

const openrouter = createOpenRouter({
  apiKey: Bun.env.OPENROUTER_API_KEY,
})

/**
 * Resolve a provider + model string to a LanguageModel instance.
 * Provider SDKs may return LanguageModelV1 which doesn't satisfy
 * the AI SDK v6 LanguageModel type at the type level, but works
 * at runtime via internal backwards-compatibility handling.
 */
export function getModel(provider: Provider, model: string): LanguageModel {
  switch (provider) {
    case 'anthropic':
      return anthropic(model) as unknown as LanguageModel
    case 'openai':
      return openai(model) as unknown as LanguageModel
    case 'openrouter':
      return openrouter(model) as unknown as LanguageModel
    default:
      throw new Error(`Unknown provider: ${provider}`)
  }
}

export const DEFAULT_MODEL = 'claude-sonnet-4-20250514'
export const DEFAULT_PROVIDER: Provider = 'anthropic'
