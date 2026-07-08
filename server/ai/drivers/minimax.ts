/**
 * MiniMax driver — direct HTTP against the MiniMax OpenAI-compatible endpoint.
 *
 * MiniMax speaks the OpenAI `/v1/chat/completions` wire protocol; the shared
 * `http/chatCompletions.ts` module owns the message mapping + SSE translation.
 * This file owns only MiniMax-specific concerns: credential validation, live
 * model catalogue (`/v1/models`), and fallback models.
 *
 * Auth: `apiKey` mode. The API key is sent as a Bearer token.
 * Base URL is `https://api.minimaxi.com/v1` — the official MiniMax API endpoint
 * (Chinese platform; international users may prefer `https://api.minimax.io/v1`).
 *
 * MiniMax models as of mid-2026:
 *   - MiniMax-M3              — flagship, 1M context, strong coding + agent
 *   - MiniMax-M2.7            — previous-gen, fast reasoning
 *   - MiniMax-M2.7-highspeed  — speed-optimised M2.7
 *   - MiniMax-M2.5            — cost-efficient, solid all-round
 *   - MiniMax-M2.5-highspeed  — speed-optimised M2.5
 *   - MiniMax-M2.1            — legacy, very fast
 *   - MiniMax-M2              — legacy
 *
 * IMPORTANT: MiniMax M3 enables "thinking" by default. The driver sends
 * `thinking: { type: 'disabled' }` so the output is plain text — reasoning
 * tokens (`<think>…</think>`) are NOT currently surfaced in the Instatic UI.
 *
 * NOTE: MiniMax's OpenAI-compatible endpoint has deprecated `max_tokens` in
 * favour of `max_completion_tokens`. The shared `chatCompletions.ts` adapter
 * does NOT send either by default (relies on the model's own limit), which is
 * safe. If a limit is needed later, use `max_completion_tokens` in a
 * MiniMax-specific `buildRequestBody` override.
 *
 * Tool calling is supported on M3 via the standard `tools` / `tool_calls`
 * wire format (identical to OpenAI). M2.x tool calling uses a separate API
 * surface and is NOT covered by this driver.
 */

import { Type, parseValue } from '@core/utils/typeboxHelpers'
import type {
  AiAuthMode,
  AiProviderId,
  AiStreamEvent,
} from '../runtime/types'
import type {
  AiProvider,
  AiProviderModel,
  AiResolvedCredential,
  AiStreamRequest,
} from './types'
import { runToolLoop } from './http/toolLoop'
import { makeChatCompletionsAdapter, normalizeOpenAiBaseUrl } from './http/chatCompletions'

const MINIMAX_BASE_URL = 'https://api.minimaxi.com/v1'

const SUPPORTED_AUTH_MODES: AiAuthMode[] = ['apiKey']

/** Hardcoded fallback models shown in the picker when the live catalogue is unreachable. */
const FALLBACK_MODELS: AiProviderModel[] = [
  {
    id: 'MiniMax-M3',
    label: 'MiniMax-M3',
    tier: 'smart',
    catalogueSource: 'fallback',
    capabilities: { toolCalling: true, visionInput: true, promptCache: false, streaming: true },
  },
  {
    id: 'MiniMax-M2.7',
    label: 'MiniMax-M2.7',
    tier: 'smart',
    catalogueSource: 'fallback',
    capabilities: { toolCalling: false, visionInput: false, promptCache: false, streaming: true },
  },
  {
    id: 'MiniMax-M2.5',
    label: 'MiniMax-M2.5',
    tier: 'fast',
    catalogueSource: 'fallback',
    capabilities: { toolCalling: false, visionInput: false, promptCache: false, streaming: true },
  },
]

export const minimaxDriver: AiProvider = {
  id: 'minimax' as AiProviderId,
  label: 'MiniMax',
  supportedAuthModes: SUPPORTED_AUTH_MODES,

  capabilities(modelId: string) {
    const model = FALLBACK_MODELS.find((m) => m.id === modelId)
    return model?.capabilities ?? {
      toolCalling: true,
      visionInput: false,
      promptCache: false,
      streaming: true,
    }
  },

  async listModels(creds: AiResolvedCredential) {
    if (creds.authMode !== 'apiKey' || !creds.apiKey) return FALLBACK_MODELS
    return fetchMinimaxModels(creds.apiKey)
  },

  async *stream(req: AiStreamRequest): AsyncIterable<AiStreamEvent> {
    if (req.credentials.authMode !== 'apiKey' || !req.credentials.apiKey) {
      yield {
        type: 'error',
        message:
          'MiniMax requires an API key. Add an API-key credential in /admin/ai/providers and pick it for the site default.',
      }
      return
    }

    // Build the standard OpenAI-compatible adapter, then override
    // `buildRequestBody` to inject MiniMax-specific parameters:
    //   - `thinking: { type: 'disabled' }` — M3 reasoning tokens would otherwise
    //     pollute the text stream with `<think>…</think>` tags.
    //   - `max_completion_tokens` — MiniMax has deprecated `max_tokens`;
    //     `max_completion_tokens` is the correct param when a limit is needed.
    const base = makeChatCompletionsAdapter({
      baseUrl: MINIMAX_BASE_URL,
      apiKey: req.credentials.apiKey,
      label: 'MiniMax',
    })

    const adapter: typeof base = {
      ...base,
      buildRequestBody(messages, innerReq) {
        const body = base.buildRequestBody(messages, innerReq) as Record<string, unknown>
        // MiniMax-specific tweaks:
        // 1. Disable M3 thinking so the output is plain text (otherwise
        //    `<think>…</think>` tags leak into the text stream).
        // 2. Remove `stream_options` — MiniMax always returns `usage` on the
        //    final chunk; `stream_options` is an OpenAI extension that M2.x
        //    models may reject with 400.
        body.thinking = { type: 'disabled' }
        delete body.stream_options
        return body
      },
    }

    yield* runToolLoop(adapter, req)
  },
}

// ---------------------------------------------------------------------------
// Live model catalogue — GET /v1/models (standard OpenAI list shape)
// ---------------------------------------------------------------------------

const ModelsResponseSchema = Type.Object(
  { data: Type.Array(Type.Object({ id: Type.String() }, { additionalProperties: true })) },
  { additionalProperties: true },
)

/**
 * Fetch the model catalogue from `GET ${MINIMAX_BASE_URL}/v1/models`.
 * Filter to only MiniMax-owned models. Any failure (offline, non-OK,
 * unparseable) returns FALLBACK_MODELS so the picker stays usable.
 */
async function fetchMinimaxModels(apiKey: string): Promise<AiProviderModel[]> {
  try {
    const res = await fetch(`${normalizeOpenAiBaseUrl(MINIMAX_BASE_URL)}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) return FALLBACK_MODELS
    const parsed = parseValue(ModelsResponseSchema, await res.json())

    // Map live models to the picker shape. Capability detection is based on
    // model prefix: M3 supports tool calling + vision; M2.x is text-only and
    // tool calling is NOT supported via the OpenAI-compatible endpoint.
    const models = parsed.data
      .filter((m) => m.id.toLowerCase().startsWith('minimax'))
      .map((m) => {
        const isM3 = m.id.startsWith('MiniMax-M3')
        return {
          id: m.id,
          label: m.id,
          catalogueSource: 'live' as const,
          capabilities: {
            toolCalling: isM3,
            visionInput: isM3,
            promptCache: false,
            streaming: true,
          },
        }
      })

    return models.length > 0 ? models : FALLBACK_MODELS
  } catch (err) {
    console.error('[ai/minimax] models request failed:', err)
    return FALLBACK_MODELS
  }
}
