/**
 * Local tool handlers for skill tools that require real external API calls.
 *
 * Why this exists
 * ---------------
 * The plugin tool builder (`buildAiToolFromSkillTool` in `./index.ts`)
 * originally dispatched every skill tool through a plugin worker RPC
 * (`runAiToolInWorker` in `server/plugins/host/rpc.ts`). That function is
 * not yet implemented, so any skill tool that actually needs to reach the
 * network would fail at runtime.
 *
 * The fix: `buildAiToolFromSkillTool` now consults `lookupLocalHandler`
 * first. When a `(pluginId, toolName)` pair is registered here, the handler
 * runs directly in the server process — no worker round-trip needed.
 *
 * When to add a handler here
 * -------------------------
 *   - The skill makes outbound HTTP requests (weather, youtube…).
 *   - The skill needs server-only resources (DB, fs) and a worker entrypoint
 *     would be overkill.
 *
 * Skills that are pure AI reasoning (e.g. `humanizer`) do NOT need a local
 * handler — the `systemPrompt` alone is enough, and the model does the work
 * inline in its response. If the model still tries to call such a tool, the
 * fallback worker RPC path returns a graceful error.
 *
 * Handlers are keyed by `<pluginId>:<toolName>` — the same namespacing
 * convention used by `buildAiToolFromSkillTool` for the qualified tool name.
 */

import { getPluginSettings } from './index'

// ===========================================================================
// Proxy-aware fetch helper
// ===========================================================================

/**
 * 从环境变量读取 HTTP 代理地址。
 * 支持的变量（优先级从高到低）：HTTPS_PROXY, HTTP_PROXY, https_proxy, http_proxy
 */
function getHttpProxy(): string | undefined {
  for (const env of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
    const val = process.env[env]
    if (val && val.startsWith('http')) return val
  }
  return undefined
}



/**
 * 发起 HTTP 请求，自动注入代理（如果配置了 HTTP_PROXY/HTTPS_PROXY）。
 * Bun 原生 fetch 支持 proxy 选项。
 */
async function proxyFetch(url: string, init?: RequestInit): Promise<Response> {
  const proxy = getHttpProxy()
  return fetch(url, {
    ...init,
    ...(proxy ? { proxy } as RequestInit : {}),
  })
}

/**
 * 带重试的 HTTP 请求。在 5xx 和网络错误时自动重试最多 `retries` 次，
 * 使用指数退避（1s, 2s, 4s ...）。4xx 错误不重试。
 */
async function retryFetch(
  url: string,
  init?: RequestInit,
  retries = 2,
): Promise<Response> {
  let lastErr: Error | null = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await proxyFetch(url, init)
      // 5xx 服务器错误时重试
      if (res.status >= 500 && attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
        continue
      }
      return res
    } catch (err) {
      lastErr = err as Error
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
        continue
      }
    }
  }
  throw lastErr ?? new Error(`Request to ${url} failed after ${retries + 1} attempts`)
}

// ===========================================================================
// Weather handlers — based on ClawHub steipete/weather
//
// Strategy: wttr.in (primary, no API key) → Open-Meteo (fallback, no API key).
// Both are free public APIs that need no credentials.
// ===========================================================================

/** wttr.in JSON API response — only the fields we read. */
interface WttrResponse {
  current_condition?: Array<{
    temp_C?: string
    temp_F?: string
    humidity?: string
    windspeedKmph?: string
    winddir16Point?: string
    FeelsLikeC?: string
    FeelsLikeF?: string
    weatherDesc?: Array<{ value?: string }>
  }>
  nearest_area?: Array<{
    areaName?: Array<{ value?: string }>
  }>
  weather?: Array<{
    date?: string
    maxtempC?: string
    mintempC?: string
    avgtempC?: string
    maxtempF?: string
    mintempF?: string
    avgtempF?: string
    hourly?: Array<{
      time?: string
      weatherDesc?: Array<{ value?: string }>
    }>
  }>
}

/** Open-Meteo geocoding API response — only the fields we read. */
interface OpenMeteoGeoResponse {
  results?: Array<{
    latitude: number
    longitude: number
    name: string
    country?: string
  }>
}

/** Open-Meteo forecast API response — only the fields we read. */
interface OpenMeteoForecastResponse {
  current_weather?: {
    temperature: number
    windspeed: number
    weathercode: number
    winddirection: number
  }
  daily?: {
    time: string[]
    temperature_2m_max: number[]
    temperature_2m_min: number[]
    weathercode: number[]
    windspeed_10m_max?: number[]
  }
}

/**
 * Get current weather for a location.
 *
 * Input: `{ location: string, unit?: 'celsius' | 'fahrenheit' }`
 *
 * Returns `{ ok: true, data: { location, temperature, condition, humidity, windSpeed, windDir, feelsLike, source } }`
 * or `{ ok: false, error: string }`.
 */
export async function handleWeatherGet(input: unknown): Promise<unknown> {
  const args = input as { location?: string; unit?: string }
  const location = args?.location
  if (!location || typeof location !== 'string' || location.trim() === '') {
    return { ok: false, error: 'location is required and must be a non-empty string' }
  }
  const useF = args.unit === 'fahrenheit'

  // 1. wttr.in (primary) — free, no API key, returns rich JSON.
  try {
    const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`
    const res = await proxyFetch(url, { headers: { Accept: 'application/json' } })
    if (res.ok) {
      const data = (await res.json()) as WttrResponse
      const current = data.current_condition?.[0]
      if (current) {
        return {
          ok: true,
          data: {
            location: data.nearest_area?.[0]?.areaName?.[0]?.value ?? location,
            temperature: useF ? `${current.temp_F ?? ''}°F` : `${current.temp_C ?? ''}°C`,
            condition: current.weatherDesc?.[0]?.value,
            humidity: current.humidity != null ? `${current.humidity}%` : undefined,
            windSpeed: current.windspeedKmph != null ? `${current.windspeedKmph}km/h` : undefined,
            windDir: current.winddir16Point,
            feelsLike: useF
              ? `${current.FeelsLikeF ?? ''}°F`
              : `${current.FeelsLikeC ?? ''}°C`,
            source: 'wttr.in',
          },
        }
      }
    }
  } catch {
    // Network error or bad JSON — fall through to Open-Meteo.
  }

  // 2. Open-Meteo fallback (geocode + current_weather).
  return fetchCurrentFromOpenMeteo(location, useF)
}

/**
 * Get a multi-day weather forecast for a location.
 *
 * Input: `{ location: string, unit?: 'celsius' | 'fahrenheit', days?: number }`
 *
 * Returns `{ ok: true, data: { location, forecast: [{ date, maxTemp, minTemp, avgTemp, condition }], source } }`
 * or `{ ok: false, error: string }`.
 */
export async function handleWeatherForecast(input: unknown): Promise<unknown> {
  const args = input as { location?: string; unit?: string; days?: unknown }
  const location = args?.location
  if (!location || typeof location !== 'string' || location.trim() === '') {
    return { ok: false, error: 'location is required and must be a non-empty string' }
  }
  const useF = args.unit === 'fahrenheit'
  const days = clampDays(args.days)

  // 1. wttr.in (primary) — parse `weather[]` for daily summaries.
  try {
    const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`
    const res = await proxyFetch(url, { headers: { Accept: 'application/json' } })
    if (res.ok) {
      const data = (await res.json()) as WttrResponse
      if (data.weather && data.weather.length > 0) {
        const forecast = data.weather.slice(0, days).map((day) => ({
          date: day.date,
          maxTemp: useF ? `${day.maxtempF ?? ''}°F` : `${day.maxtempC ?? ''}°C`,
          minTemp: useF ? `${day.mintempF ?? ''}°F` : `${day.mintempC ?? ''}°C`,
          avgTemp: useF ? `${day.avgtempF ?? ''}°F` : `${day.avgtempC ?? ''}°C`,
          condition: day.hourly?.[0]?.weatherDesc?.[0]?.value,
        }))
        return {
          ok: true,
          data: {
            location: data.nearest_area?.[0]?.areaName?.[0]?.value ?? location,
            forecast,
            source: 'wttr.in',
          },
        }
      }
    }
  } catch {
    // Network error or bad JSON — fall through to Open-Meteo.
  }

  // 2. Open-Meteo fallback (geocode + daily forecast).
  return fetchForecastFromOpenMeteo(location, useF, days)
}

/** Shared Open-Meteo current-weather fetch + normalisation. */
async function fetchCurrentFromOpenMeteo(
  location: string,
  useF: boolean,
): Promise<unknown> {
  try {
    const geo = await geocodeOpenMeteo(location)
    if (!geo) return { ok: false, error: `Location not found: ${location}` }

    const unitParam = useF ? 'fahrenheit' : 'celsius'
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}` +
      `&longitude=${geo.longitude}&current_weather=true&temperature_unit=${unitParam}`
    const res = await proxyFetch(url)
    if (!res.ok) {
      return { ok: false, error: `Open-Meteo request failed: ${res.status} ${res.statusText}` }
    }
    const weather = (await res.json()) as OpenMeteoForecastResponse
    if (!weather.current_weather) {
      return { ok: false, error: 'Open-Meteo returned no current weather data' }
    }
    const cw = weather.current_weather
    return {
      ok: true,
      data: {
        location: formatGeoName(geo),
        temperature: `${cw.temperature}${useF ? '°F' : '°C'}`,
        condition: weatherCodeToText(cw.weathercode),
        windSpeed: `${cw.windspeed}km/h`,
        source: 'Open-Meteo',
      },
    }
  } catch (err) {
    return {
      ok: false,
      error: `Open-Meteo request failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    }
  }
}

/** Shared Open-Meteo daily forecast fetch + normalisation. */
async function fetchForecastFromOpenMeteo(
  location: string,
  useF: boolean,
  days: number,
): Promise<unknown> {
  try {
    const geo = await geocodeOpenMeteo(location)
    if (!geo) return { ok: false, error: `Location not found: ${location}` }

    const unitParam = useF ? 'fahrenheit' : 'celsius'
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}` +
      `&longitude=${geo.longitude}` +
      `&daily=temperature_2m_max,temperature_2m_min,weathercode,windspeed_10m_max` +
      `&forecast_days=${days}&temperature_unit=${unitParam}`
    const res = await proxyFetch(url)
    if (!res.ok) {
      return { ok: false, error: `Open-Meteo forecast failed: ${res.status} ${res.statusText}` }
    }
    const forecastData = (await res.json()) as OpenMeteoForecastResponse
    if (!forecastData.daily) {
      return { ok: false, error: 'Open-Meteo returned no daily forecast data' }
    }
    const d = forecastData.daily
    const forecast = d.time.map((date, i) => ({
      date,
      maxTemp: `${d.temperature_2m_max[i] ?? ''}${useF ? '°F' : '°C'}`,
      minTemp: `${d.temperature_2m_min[i] ?? ''}${useF ? '°F' : '°C'}`,
      condition: weatherCodeToText(d.weathercode[i] ?? -1),
      maxWindSpeed:
        d.windspeed_10m_max?.[i] != null ? `${d.windspeed_10m_max[i]}km/h` : undefined,
    }))
    return {
      ok: true,
      data: {
        location: formatGeoName(geo),
        forecast,
        source: 'Open-Meteo',
      },
    }
  } catch (err) {
    return {
      ok: false,
      error: `Open-Meteo request failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    }
  }
}

/**
 * Geocode a place name (or pass through "lat,lon") via Open-Meteo.
 * Returns null if the place could not be resolved.
 */
async function geocodeOpenMeteo(
  location: string,
): Promise<{
  latitude: number
  longitude: number
  name: string
  country?: string
} | null> {
  // Allow "lat,lon" passthrough — no geocode round-trip needed.
  const coordMatch = location.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/)
  if (coordMatch) {
    return {
      latitude: parseFloat(coordMatch[1]),
      longitude: parseFloat(coordMatch[2]),
      name: location,
    }
  }
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`
  const res = await proxyFetch(url)
  if (!res.ok) return null
  const data = (await res.json()) as OpenMeteoGeoResponse
  return data.results?.[0] ?? null
}

function formatGeoName(geo: { name: string; country?: string }): string {
  return geo.country ? `${geo.name}, ${geo.country}` : geo.name
}

/** Clamp `days` to the 1–7 range supported by both APIs. Defaults to 7. */
function clampDays(days: unknown): number {
  if (typeof days !== 'number' || !Number.isFinite(days)) return 7
  return Math.max(1, Math.min(7, Math.floor(days)))
}

/** Open-Meteo WMO weather code → human-readable text. */
function weatherCodeToText(code: number): string {
  const map: Record<number, string> = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Foggy',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    56: 'Light freezing drizzle',
    57: 'Dense freezing drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    66: 'Light freezing rain',
    67: 'Heavy freezing rain',
    71: 'Slight snow',
    73: 'Moderate snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail',
  }
  return map[code] ?? 'Unknown'
}

// ===========================================================================
// YouTube handler — based on ClawHub michaelgathara/youtube-watcher
//
// Strategy: fetch the video page HTML, extract the captions JSON, fetch the
// first caption track, parse the XML transcript. No yt-dlp, no API key.
// The model does the actual summarisation (guided by the skill systemPrompt).
// ===========================================================================

/** YouTube captions JSON shape — only the fields we read. */
interface YoutubeCaptions {
  playerCaptionsTracklistRenderer?: {
    captionTracks?: Array<{
      baseUrl: string
      languageCode?: string
      name?: { simpleText?: string; runs?: Array<{ text?: string }> }
    }>
  }
}

/**
 * Fetch a YouTube video transcript so the model can summarise it.
 *
 * Input: `{ urlOrId: string, summaryLength?: 'brief'|'medium'|'detailed', includeTimestamps?: boolean }`
 *
 * Returns `{ ok: true, data: { videoId, transcript, transcriptLength, note } }`
 * or `{ ok: false, error: string }`.
 */
export async function handleYoutubeSummarize(input: unknown): Promise<unknown> {
  const args = input as {
    urlOrId?: string
    summaryLength?: string
    includeTimestamps?: boolean
    language?: string
  }
  const urlOrId = args?.urlOrId
  if (!urlOrId || typeof urlOrId !== 'string' || urlOrId.trim() === '') {
    return { ok: false, error: 'urlOrId is required and must be a non-empty string' }
  }
  const includeTimestamps = args.includeTimestamps !== false
  const summaryLength = args.summaryLength ?? 'medium'
  const preferredLang = args.language

  const videoId = extractVideoId(urlOrId)
  if (!videoId) {
    return { ok: false, error: `Invalid YouTube URL or ID: ${urlOrId}` }
  }

  try {
    const pageRes = await retryFetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    if (!pageRes.ok) {
      return {
        ok: false,
        error: `Failed to fetch video page: ${pageRes.status} ${pageRes.statusText}`,
      }
    }
    const html = await pageRes.text()

    const captions = extractCaptionsJson(html)
    const tracks = captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
    if (tracks.length === 0) {
      return { ok: false, error: 'No caption tracks available for this video' }
    }

    // Pick track: prefer user-specified language, otherwise first track
    let track = tracks[0]
    if (preferredLang) {
      const langLower = preferredLang.toLowerCase()
      const match = tracks.find(
        (t) =>
          (t.languageCode?.toLowerCase().startsWith(langLower)) ||
          (t.name?.simpleText?.toLowerCase().includes(langLower)),
      )
      if (match) track = match
    }

    const transcriptRes = await proxyFetch(track.baseUrl)
    if (!transcriptRes.ok) {
      return {
        ok: false,
        error: `Failed to fetch transcript: ${transcriptRes.status} ${transcriptRes.statusText}`,
      }
    }
    const transcriptXml = await transcriptRes.text()

    const transcript = parseTranscriptXml(transcriptXml, includeTimestamps)
    if (transcript.length === 0) {
      return { ok: false, error: 'Transcript was empty or could not be parsed' }
    }

    // Truncate extremely long transcripts to protect model context window
    const MAX_TRANSCRIPT_LENGTH = 25000
    const truncated = transcript.length > MAX_TRANSCRIPT_LENGTH
    const finalTranscript = truncated
      ? transcript.slice(0, MAX_TRANSCRIPT_LENGTH) + '\n\n[...transcript truncated due to length...]'
      : transcript

    return {
      ok: true,
      data: {
        videoId,
        transcript: finalTranscript,
        transcriptLength: finalTranscript.length,
        originalLength: transcript.length,
        truncated,
        selectedLanguage: track.languageCode ?? track.name?.simpleText ?? 'unknown',
        availableLanguages: tracks.map((t) => ({
          code: t.languageCode ?? 'unknown',
          name: t.name?.simpleText ?? 'unknown',
        })),
        note:
          `Transcript retrieved (${track.languageCode ?? 'unknown'}). The AI should summarise it based on the ` +
          `requested summaryLength (${summaryLength}: brief/medium/detailed) ` +
          `and include timestamps if requested.`,
      },
    }
  } catch (err) {
    return {
      ok: false,
      error: `Failed to fetch transcript: ${err instanceof Error ? err.message : 'Unknown error'}`,
    }
  }
}

/**
 * Extract the `captions` JSON object from a YouTube watch page.
 *
 * YouTube embeds `ytInitialPlayerResponse` as JSON inside the HTML. We locate
 * the `"captions":` key and walk forward counting brace depth (respecting
 * string literals and escapes) to find the matching close brace — a regex
 * can't handle the nested structure reliably.
 */
function extractCaptionsJson(html: string): YoutubeCaptions | null {
  const key = '"captions":'
  const keyIdx = html.indexOf(key)
  if (keyIdx === -1) return null

  let i = keyIdx + key.length
  // Skip whitespace before the opening brace.
  while (i < html.length && /\s/.test(html[i])) i++
  if (html[i] !== '{') return null

  const start = i
  let depth = 0
  let inString = false
  let escaped = false

  while (i < html.length) {
    const ch = html[i]
    if (escaped) {
      escaped = false
    } else if (ch === '\\') {
      escaped = true
    } else if (ch === '"') {
      inString = !inString
    } else if (!inString) {
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(start, i + 1)) as YoutubeCaptions
          } catch {
            return null
          }
        }
      }
    }
    i++
  }
  return null
}

/**
 * Parse YouTube's XML transcript format into a plain string.
 *
 * The XML looks like:
 *   <transcript>
 *     <text start="0.5" dur="2.1">Hello world</text>
 *     <text start="3.0" dur="1.5">This is a video</text>
 *   </transcript>
 *
 * HTML entities (`&amp;`, `&#39;`, `&lt;`, `&gt;`, `&quot;`) are decoded.
 * When `includeTimestamps` is true, each segment is prefixed with `[MM:SS]`.
 */
function parseTranscriptXml(xml: string, includeTimestamps: boolean): string {
  const segments = xml.match(/<text[^>]*>([\s\S]*?)<\/text>/g) ?? []
  if (segments.length === 0) return ''

  return segments
    .map((seg) => {
      const inner = seg.replace(/<text[^>]*>/, '').replace(/<\/text>/, '')
      const text = decodeHtmlEntities(inner).trim()
      if (text === '') return ''

      if (!includeTimestamps) return text

      const startMatch = seg.match(/start="([\d.]+)"/)
      const start = startMatch ? parseFloat(startMatch[1]) : 0
      return `[${formatTime(start)}] ${text}`
    })
    .filter((s) => s !== '')
    .join(' ')
}

/** Decode the subset of HTML entities YouTube emits in transcript XML. */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

/** Extract an 11-character YouTube video ID from a URL or raw ID. */
function extractVideoId(input: string): string | null {
  const trimmed = input.trim()
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed
  const match = trimmed.match(
    /(?:youtu\.be\/|watch\?v=|embed\/|shorts\/|live\/)([a-zA-Z0-9_-]{11})/,
  )
  return match ? match[1] : null
}

/** Format seconds as `MM:SS` (or `H:MM:SS` for videos over an hour). */
function formatTime(seconds: number): string {
  const totalSecs = Math.floor(seconds)
  const hours = Math.floor(totalSecs / 3600)
  const mins = Math.floor((totalSecs % 3600) / 60)
  const secs = totalSecs % 60
  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

// ===========================================================================
// HuggingFace handlers — Hub API + Serverless Inference API
//
// Hub API (huggingface.co/api/) is public, no token needed for search.
// Inference API (api-inference.huggingface.co) requires a token for most models.
// Token precedence: HUGGINGFACE_API_TOKEN env var > HF_TOKEN env var.
// ===========================================================================

const HF_HUB_API = 'https://huggingface.co/api'
const HF_INFERENCE_API = 'https://api-inference.huggingface.co/models'

/** Read the HuggingFace API token. Precedence: plugin settings > env vars. */
function getHfToken(): string | undefined {
  // 1. 从插件 settings 中读取（用户在管理面板配置）
  const settings = getPluginSettings('instatic.huggingface')
  const settingToken = settings.apiToken as string | undefined
  if (settingToken && settingToken.length > 0) return settingToken

  // 2. 从环境变量中读取
  return process.env.HUGGINGFACE_API_TOKEN ?? process.env.HF_TOKEN
}

/** Clamp a number to [min, max]. */
function clampInt(val: unknown, min: number, max: number, fallback: number): number {
  const n = typeof val === 'number' ? val : typeof val === 'string' ? parseInt(val, 10) : NaN
  if (isNaN(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/** Build query string from a record, skipping undefined/null/empty values. */
function buildQuery(params: Record<string, string | number | undefined>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

interface HfModelSummary {
  id: string
  downloads?: number
  likes?: number
  tags?: string[]
  pipeline_tag?: string
  library_name?: string
  last_modified?: string
}

interface HfDatasetSummary {
  id: string
  downloads?: number
  likes?: number
  tags?: string[]
  last_modified?: string
}

interface HfSpaceSummary {
  id: string
  author?: string
  sdk?: string
  likes?: number
  last_modified?: string
  status?: string
}

/** Search HuggingFace Hub for models. */
async function handleHfSearchModels(input: unknown): Promise<unknown> {
  const p = (input ?? {}) as Record<string, unknown>
  const limit = clampInt(p.limit, 1, 30, 10)
  const sort = typeof p.sort === 'string' ? p.sort : 'trending'
  const direction = sort === 'downloads' || sort === 'likes' || sort === 'trending' ? '-1' : '-1'
  const full = p.full === true

  // Build tag filters: tags=tag1&tags=tag2 for AND behavior
  const tags = Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === 'string') : []
  const tagFilters = tags.map((t) => `tags=${encodeURIComponent(t)}`).join('&')

  const language = typeof p.language === 'string' ? p.language.trim() : undefined

  const query = buildQuery({
    search: typeof p.query === 'string' ? p.query : undefined,
    filter: typeof p.task === 'string' ? p.task : undefined,
    author: typeof p.author === 'string' ? p.author : undefined,
    library: typeof p.library === 'string' ? p.library : undefined,
    language,
    sort,
    direction,
    limit,
    full: full ? 'full' : undefined,
  })

  const url = `${HF_HUB_API}/models${query}${tagFilters ? (query ? '&' : '?') + tagFilters : ''}`

  try {
    const res = await retryFetch(url, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      return { ok: false, error: `HuggingFace API returned ${res.status}: ${await res.text().catch(() => res.statusText)}` }
    }
    const models = (await res.json()) as HfModelSummary[]
    const results = models.map((m) => ({
      id: m.id,
      task: m.pipeline_tag ?? 'unknown',
      downloads: m.downloads ?? 0,
      likes: m.likes ?? 0,
      library: m.library_name ?? 'unknown',
      tags: (m.tags ?? []).slice(0, 8),
      url: `https://huggingface.co/${m.id}`,
    }))
    return { ok: true, data: { count: results.length, models: results } }
  } catch (err) {
    return { ok: false, error: `Failed to search models: ${(err as Error).message}` }
  }
}

/** Get detailed information about a specific HuggingFace model. */
async function handleHfGetModelInfo(input: unknown): Promise<unknown> {
  const p = (input ?? {}) as Record<string, unknown>
  const modelId = typeof p.model_id === 'string' ? p.model_id.trim() : ''
  const withFiles = p.with_files !== false
  if (!modelId) return { ok: false, error: 'model_id is required' }

  try {
    // Fetch model metadata
    const metaRes = await retryFetch(`${HF_HUB_API}/models/${encodeURIComponent(modelId)}`, {
      headers: { Accept: 'application/json' },
    })
    if (!metaRes.ok) {
      return { ok: false, error: `Model not found or API returned ${metaRes.status}` }
    }
    const meta = (await metaRes.json()) as Record<string, unknown>

    // Fetch a snippet of the README/model card
    let readme = ''
    try {
      const readmeRes = await proxyFetch(
        `https://huggingface.co/${encodeURIComponent(modelId)}/raw/main/README.md`,
      )
      if (readmeRes.ok) {
        const fullReadme = await readmeRes.text()
        readme = fullReadme.slice(0, 1500) + (fullReadme.length > 1500 ? '\n...(truncated)' : '')
      }
    } catch {
      // README is optional
    }

    // Fetch sibling files (config.json, weights, tokenizer, etc.)
    let siblings: Array<{ rfilename: string; size?: number }> = []
    if (withFiles) {
      try {
        const sibRes = await retryFetch(
          `${HF_HUB_API}/models/${encodeURIComponent(modelId)}/tree/main`,
          { headers: { Accept: 'application/json' } },
        )
        if (sibRes.ok) {
          const tree = (await sibRes.json()) as Array<Record<string, unknown>>
          siblings = tree
            .filter((item) => item.type === 'file')
            .map((item) => ({
              rfilename: (item.path as string) ?? '',
              size: (item.size as number) ?? 0,
            }))
        }
      } catch {
        // siblings are optional
      }
    }

    return {
      ok: true,
      data: {
        id: meta.id ?? modelId,
        author: meta.author ?? modelId.split('/')[0],
        pipeline_tag: meta.pipeline_tag ?? meta['pipeline-tag'] ?? 'unknown',
        library_name: meta.library_name ?? 'unknown',
        downloads: meta.downloads ?? 0,
        likes: meta.likes ?? 0,
        created: meta.created ?? 'unknown',
        last_modified: meta.lastModified ?? 'unknown',
        tags: (meta.tags as string[] | undefined)?.slice(0, 10) ?? [],
        config: meta.config ? { model_type: (meta.config as Record<string, unknown>).model_type ?? 'unknown' } : null,
        siblings: siblings.slice(0, 30),
        sibling_count: siblings.length,
        cardSnippet: readme,
        url: `https://huggingface.co/${modelId}`,
      },
    }
  } catch (err) {
    return { ok: false, error: `Failed to get model info: ${(err as Error).message}` }
  }
}

/** Search HuggingFace Hub for datasets. */
async function handleHfSearchDatasets(input: unknown): Promise<unknown> {
  const p = (input ?? {}) as Record<string, unknown>
  const limit = clampInt(p.limit, 1, 30, 10)
  const sort = typeof p.sort === 'string' ? p.sort : 'trending'

  const tags = Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === 'string') : []
  const tagFilters = tags.map((t) => `tags=${encodeURIComponent(t)}`).join('&')

  const language = typeof p.language === 'string' ? p.language.trim() : undefined
  const sizeCategory = typeof p.size_category === 'string' ? p.size_category.trim() : undefined

  const query = buildQuery({
    search: typeof p.query === 'string' ? p.query : undefined,
    filter: typeof p.task === 'string' ? p.task : undefined,
    author: typeof p.author === 'string' ? p.author : undefined,
    language,
    sort,
    direction: '-1',
    limit,
  })

  // size_category is a dataset-specific tag filter
  const sizeFilter = sizeCategory ? `size_categories=${encodeURIComponent(sizeCategory)}` : ''
  const separator = tagFilters || sizeFilter ? (query ? '&' : '?') : ''
  const extraFilters = [tagFilters, sizeFilter].filter(Boolean).join('&')
  const url = `${HF_HUB_API}/datasets${query}${separator}${extraFilters}`

  try {
    const res = await retryFetch(url, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      return { ok: false, error: `HuggingFace API returned ${res.status}` }
    }
    const datasets = (await res.json()) as HfDatasetSummary[]
    const results = datasets.map((d) => ({
      id: d.id,
      downloads: d.downloads ?? 0,
      likes: d.likes ?? 0,
      tags: (d.tags ?? []).slice(0, 8),
      last_modified: d.last_modified ?? 'unknown',
      url: `https://huggingface.co/datasets/${d.id}`,
    }))
    return { ok: true, data: { count: results.length, datasets: results } }
  } catch (err) {
    return { ok: false, error: `Failed to search datasets: ${(err as Error).message}` }
  }
}

/** Search HuggingFace Hub for Spaces (interactive ML demos). */
async function handleHfSearchSpaces(input: unknown): Promise<unknown> {
  const p = (input ?? {}) as Record<string, unknown>
  const limit = clampInt(p.limit, 1, 30, 10)
  const sort = typeof p.sort === 'string' ? p.sort : 'trending'

  const query = buildQuery({
    search: typeof p.query === 'string' ? p.query : undefined,
    author: typeof p.author === 'string' ? p.author : undefined,
    sort,
    direction: '-1',
    limit,
  })

  try {
    const res = await retryFetch(`${HF_HUB_API}/spaces${query}`, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      return { ok: false, error: `HuggingFace API returned ${res.status}` }
    }
    const spaces = (await res.json()) as HfSpaceSummary[]
    const results = spaces.map((s) => ({
      id: s.id,
      author: s.author ?? 'unknown',
      sdk: s.sdk ?? 'unknown',
      likes: s.likes ?? 0,
      last_modified: s.last_modified ?? 'unknown',
      url: `https://huggingface.co/spaces/${s.id}`,
    }))
    return { ok: true, data: { count: results.length, spaces: results } }
  } catch (err) {
    return { ok: false, error: `Failed to search spaces: ${(err as Error).message}` }
  }
}

/** Run inference on a HuggingFace model via the Serverless Inference API. */
async function handleHfRunInference(input: unknown): Promise<unknown> {
  const p = (input ?? {}) as Record<string, unknown>
  const modelId = typeof p.model_id === 'string' ? p.model_id.trim() : ''
  const inputs = typeof p.inputs === 'string' ? p.inputs : ''
  if (!modelId) return { ok: false, error: 'model_id is required' }
  if (!inputs) return { ok: false, error: 'inputs is required' }

  const token = getHfToken()
  if (!token) {
    return {
      ok: false,
      error:
        'No HuggingFace API token found. Please either set HUGGINGFACE_API_TOKEN environment variable, or configure the token in the HuggingFace plugin settings panel. Get a free token at https://huggingface.co/settings/tokens',
    }
  }

  const parameters = (p.parameters ?? {}) as Record<string, unknown>
  const body: Record<string, unknown> = { inputs }
  if (Object.keys(parameters).length > 0) {
    body.parameters = parameters
  }

  try {
    const res = await proxyFetch(`${HF_INFERENCE_API}/${encodeURIComponent(modelId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })

    if (res.status === 503) {
      const errorBody = await res.json().catch(() => ({}))
      const estimatedTime = (errorBody as Record<string, unknown>)?.estimated_time
      return {
        ok: false,
        error: `Model is loading on HuggingFace servers. Estimated time: ${estimatedTime ?? 'unknown'} seconds. Please retry shortly.`,
      }
    }

    if (!res.ok) {
      const errorText = await res.text().catch(() => res.statusText)
      return { ok: false, error: `Inference API returned ${res.status}: ${errorText}` }
    }

    const contentType = res.headers.get('content-type') ?? ''
    let result: unknown
    if (contentType.includes('application/json')) {
      result = await res.json()
    } else {
      result = await res.text()
    }

    return { ok: true, data: { model_id: modelId, result } }
  } catch (err) {
    return { ok: false, error: `Inference request failed: ${(err as Error).message}` }
  }
}

/** Get detailed information about a HuggingFace dataset. */
async function handleHfGetDatasetInfo(input: unknown): Promise<unknown> {
  const p = (input ?? {}) as Record<string, unknown>
  const datasetId = typeof p.dataset_id === 'string' ? p.dataset_id.trim() : ''
  const withFiles = p.with_files !== false
  if (!datasetId) return { ok: false, error: 'dataset_id is required' }

  try {
    // Fetch dataset metadata
    const metaRes = await retryFetch(`${HF_HUB_API}/datasets/${encodeURIComponent(datasetId)}`, {
      headers: { Accept: 'application/json' },
    })
    if (!metaRes.ok) {
      return { ok: false, error: `Dataset not found or API returned ${metaRes.status}` }
    }
    const meta = (await metaRes.json()) as Record<string, unknown>

    // Fetch file tree
    let files: unknown[] = []
    if (withFiles) {
      try {
        const treeRes = await retryFetch(
          `${HF_HUB_API}/datasets/${encodeURIComponent(datasetId)}/tree/main`,
          { headers: { Accept: 'application/json' } },
        )
        if (treeRes.ok) {
          files = (await treeRes.json()) as unknown[]
        }
      } catch {
        // File tree is optional
      }
    }

    // Fetch README
    let readme = ''
    try {
      const readmeRes = await proxyFetch(
        `https://huggingface.co/datasets/${encodeURIComponent(datasetId)}/raw/main/README.md`,
      )
      if (readmeRes.ok) {
        const fullReadme = await readmeRes.text()
        readme = fullReadme.slice(0, 2000) + (fullReadme.length > 2000 ? '\n...(truncated)' : '')
      }
    } catch {
      // README is optional
    }

    const fileList = (files as Array<Record<string, unknown>>).map((f) => ({
      path: f.path ?? 'unknown',
      type: f.type ?? 'file',
      size: f.size ?? 0,
      lfs: f.lfs != null,
    }))

    return {
      ok: true,
      data: {
        id: meta.id ?? datasetId,
        author: meta.author ?? datasetId.split('/')[0],
        description: (meta.description as string) ?? '',
        downloads: meta.downloads ?? 0,
        likes: meta.likes ?? 0,
        tags: (meta.tags as string[] | undefined)?.slice(0, 10) ?? [],
        created: meta.createdAt ?? 'unknown',
        last_modified: meta.lastModified ?? 'unknown',
        private: meta.private ?? false,
        files: fileList,
        file_count: fileList.length,
        readme,
        url: `https://huggingface.co/datasets/${datasetId}`,
      },
    }
  } catch (err) {
    return { ok: false, error: `Failed to get dataset info: ${(err as Error).message}` }
  }
}

/** List files in a HuggingFace repository. */
async function handleHfListRepoFiles(input: unknown): Promise<unknown> {
  const p = (input ?? {}) as Record<string, unknown>
  const repoId = typeof p.repo_id === 'string' ? p.repo_id.trim() : ''
  const repoType = typeof p.repo_type === 'string' ? p.repo_type : 'model'
  const path = typeof p.path === 'string' ? p.path.trim() : ''
  if (!repoId) return { ok: false, error: 'repo_id is required' }
  if (!['model', 'dataset', 'space'].includes(repoType)) {
    return { ok: false, error: 'repo_type must be one of: model, dataset, space' }
  }

  const typePrefix = repoType === 'model' ? '' : `${repoType}s/`
  const treePath = path ? `/tree/main/${encodeURIComponent(path)}` : '/tree/main'

  try {
    const res = await retryFetch(`${HF_HUB_API}/${typePrefix}${encodeURIComponent(repoId)}${treePath}`, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      return { ok: false, error: `API returned ${res.status}: ${await res.text().catch(() => res.statusText)}` }
    }
    const items = (await res.json()) as Array<Record<string, unknown>>
    const results = items.map((item) => ({
      path: item.path ?? 'unknown',
      type: item.type ?? 'file',
      size: item.size ?? 0,
      lfs: item.lfs != null,
      oid: item.oid ?? '',
    }))
    return {
      ok: true,
      data: {
        repo_id: repoId,
        repo_type: repoType,
        path: path || 'root',
        count: results.length,
        files: results,
      },
    }
  } catch (err) {
    return { ok: false, error: `Failed to list repo files: ${(err as Error).message}` }
  }
}

/** Create a new repository on HuggingFace Hub. */
async function handleHfCreateRepo(input: unknown): Promise<unknown> {
  const p = (input ?? {}) as Record<string, unknown>
  const name = typeof p.name === 'string' ? p.name.trim() : ''
  const repoType = typeof p.repo_type === 'string' ? p.repo_type : 'model'
  const isPrivate = p.private === true
  const sdk = typeof p.sdk === 'string' ? p.sdk : undefined

  if (!name) return { ok: false, error: 'name is required' }
  if (!['model', 'dataset', 'space'].includes(repoType)) {
    return { ok: false, error: 'repo_type must be one of: model, dataset, space' }
  }

  const token = getHfToken()
  if (!token) {
    return {
      ok: false,
      error:
        'No HuggingFace API token found. Please either set HUGGINGFACE_API_TOKEN environment variable, or configure the token in the HuggingFace plugin settings panel. Get a free token at https://huggingface.co/settings/tokens',
    }
  }

  const body: Record<string, unknown> = {
    name,
    type: repoType === 'model' ? 'model' : repoType,
    private: isPrivate,
  }
  if (repoType === 'space' && sdk) {
    body.sdk = sdk
  }
  const description = typeof p.description === 'string' ? p.description.trim() : undefined
  if (description) {
    body.description = description
  }
  const license = typeof p.license === 'string' ? p.license.trim() : undefined
  if (license) {
    body.license = license
  }

  try {
    const res = await proxyFetch(`${HF_HUB_API}/repos/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errorText = await res.text().catch(() => res.statusText)
      return { ok: false, error: `Create repo failed: ${res.status} ${errorText}` }
    }

    const data = (await res.json()) as Record<string, unknown>
    const namespace = name.includes('/') ? name.split('/')[0] : (data.author as string) ?? 'user'
    const repoName = name.includes('/') ? name.split('/')[1] : name
    const typePrefix = repoType === 'model' ? '' : `${repoType}s/`

    return {
      ok: true,
      data: {
        name,
        repo_type: repoType,
        private: isPrivate,
        url: `https://huggingface.co/${typePrefix}${namespace}/${repoName}`,
        ...data,
      },
    }
  } catch (err) {
    return { ok: false, error: `Failed to create repo: ${(err as Error).message}` }
  }
}

/** Upload a text file to a HuggingFace repository. */
async function handleHfUploadFile(input: unknown): Promise<unknown> {
  const p = (input ?? {}) as Record<string, unknown>
  const repoId = typeof p.repo_id === 'string' ? p.repo_id.trim() : ''
  const repoType = typeof p.repo_type === 'string' ? p.repo_type : 'model'
  const pathInRepo = typeof p.path_in_repo === 'string' ? p.path_in_repo.trim() : ''
  const content = typeof p.content === 'string' ? p.content : ''
  const message = typeof p.message === 'string' ? p.message.trim() : 'Upload file via Instatic'

  if (!repoId) return { ok: false, error: 'repo_id is required' }
  if (!pathInRepo) return { ok: false, error: 'path_in_repo is required' }
  if (!['model', 'dataset', 'space'].includes(repoType)) {
    return { ok: false, error: 'repo_type must be one of: model, dataset, space' }
  }

  const token = getHfToken()
  if (!token) {
    return {
      ok: false,
      error:
        'No HuggingFace API token found. Please either set HUGGINGFACE_API_TOKEN environment variable, or configure the token in the HuggingFace plugin settings panel. Get a free token at https://huggingface.co/settings/tokens',
    }
  }

  const typePrefix = repoType === 'model' ? '' : `${repoType}s/`

  try {
    // Build multipart form data
    const form = new FormData()
    const blob = new Blob([content], { type: 'text/plain' })
    form.append('file', blob, pathInRepo.split('/').pop() ?? 'file')

    const res = await proxyFetch(
      `${HF_HUB_API}/${typePrefix}${encodeURIComponent(repoId)}/upload/main/${encodeURIComponent(pathInRepo)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Commit-Message': message,
        },
        body: form,
      },
    )

    if (!res.ok) {
      const errorText = await res.text().catch(() => res.statusText)
      return { ok: false, error: `Upload failed: ${res.status} ${errorText}` }
    }

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return {
      ok: true,
      data: {
        repo_id: repoId,
        repo_type: repoType,
        path: pathInRepo,
        commit: data.commit ?? data,
        url: `https://huggingface.co/${typePrefix}${repoId}/blob/main/${pathInRepo}`,
      },
    }
  } catch (err) {
    return { ok: false, error: `Failed to upload file: ${(err as Error).message}` }
  }
}

/** Fetch the README.md of a HuggingFace repository. */
async function handleHfGetRepoReadme(input: unknown): Promise<unknown> {
  const p = (input ?? {}) as Record<string, unknown>
  const repoId = typeof p.repo_id === 'string' ? p.repo_id.trim() : ''
  const repoType = typeof p.repo_type === 'string' ? p.repo_type : 'model'
  if (!repoId) return { ok: false, error: 'repo_id is required' }

  const typePrefix = repoType === 'model' ? '' : `${repoType}s/`

  try {
    const res = await proxyFetch(
      `https://huggingface.co/${typePrefix}${encodeURIComponent(repoId)}/raw/main/README.md`,
    )
    if (!res.ok) {
      return { ok: false, error: `README not found or API returned ${res.status}` }
    }
    const readme = await res.text()
    return {
      ok: true,
      data: {
        repo_id: repoId,
        repo_type: repoType,
        content: readme,
        length: readme.length,
        url: `https://huggingface.co/${typePrefix}${repoId}#readme`,
      },
    }
  } catch (err) {
    return { ok: false, error: `Failed to fetch README: ${(err as Error).message}` }
  }
}

/** Get current authenticated user info. */
async function handleHfGetWhoami(): Promise<unknown> {
  const token = getHfToken()
  if (!token) {
    return {
      ok: false,
      error:
        'No HuggingFace API token found. Please either set HUGGINGFACE_API_TOKEN environment variable, or configure the token in the HuggingFace plugin settings panel. Get a free token at https://huggingface.co/settings/tokens',
    }
  }

  try {
    const res = await retryFetch(`${HF_HUB_API}/whoami-v2`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (!res.ok) {
      return { ok: false, error: `API returned ${res.status}: ${await res.text().catch(() => res.statusText)}` }
    }
    const data = (await res.json()) as Record<string, unknown>
    return {
      ok: true,
      data: {
        username: data.name ?? 'unknown',
        fullname: data.fullname ?? '',
        email: data.email ?? '',
        orgs: (data.orgs as Array<{ name: string }> | undefined)?.map((o) => o.name) ?? [],
        token_type: data.type ?? 'unknown',
        token_permission: data.auth?.accessToken?.role ?? 'unknown',
      },
    }
  } catch (err) {
    return { ok: false, error: `Failed to get user info: ${(err as Error).message}` }
  }
}

/** Download a single file from a HuggingFace repository. */
async function handleHfDownloadFile(input: unknown): Promise<unknown> {
  const p = (input ?? {}) as Record<string, unknown>
  const repoId = typeof p.repo_id === 'string' ? p.repo_id.trim() : ''
  const repoType = typeof p.repo_type === 'string' ? p.repo_type : 'model'
  const path = typeof p.path === 'string' ? p.path.trim() : ''
  const revision = typeof p.revision === 'string' ? p.revision.trim() : 'main'
  const returnContent = p.return_content === true

  if (!repoId) return { ok: false, error: 'repo_id is required' }
  if (!path) return { ok: false, error: 'path is required' }

  const typePrefix = repoType === 'model' ? '' : `${repoType}s/`
  const url = `https://huggingface.co/${typePrefix}${encodeURIComponent(repoId)}/resolve/${encodeURIComponent(revision)}/${encodeURIComponent(path)}`

  if (!returnContent) {
    return {
      ok: true,
      data: {
        repo_id: repoId,
        repo_type: repoType,
        path,
        revision,
        download_url: url,
        note: 'Use this URL to download the file. For large files or folders, use run_hf_command with hf download instead.',
      },
    }
  }

  try {
    const res = await retryFetch(url, { headers: { Accept: '*/*' } })
    if (!res.ok) {
      return { ok: false, error: `Download failed: ${res.status} ${await res.text().catch(() => res.statusText)}` }
    }
    const contentType = res.headers.get('content-type') ?? ''
    const isText = contentType.includes('text') || contentType.includes('json') || contentType.includes('xml')
    if (isText) {
      const text = await res.text()
      return {
        ok: true,
        data: {
          repo_id: repoId,
          repo_type: repoType,
          path,
          revision,
          content_type: contentType,
          content: text,
          size: text.length,
          download_url: url,
        },
      }
    }
    // Binary file: return metadata + download URL
    const blob = await res.blob()
    return {
      ok: true,
      data: {
        repo_id: repoId,
        repo_type: repoType,
        path,
        revision,
        content_type: contentType,
        size: blob.size,
        is_binary: true,
        download_url: url,
        note: 'File is binary. Use the download_url to save it locally.',
      },
    }
  } catch (err) {
    return { ok: false, error: `Failed to download file: ${(err as Error).message}` }
  }
}

/** Delete a file from a HuggingFace repository. */
async function handleHfDeleteFile(input: unknown): Promise<unknown> {
  const p = (input ?? {}) as Record<string, unknown>
  const repoId = typeof p.repo_id === 'string' ? p.repo_id.trim() : ''
  const repoType = typeof p.repo_type === 'string' ? p.repo_type : 'model'
  const pathInRepo = typeof p.path_in_repo === 'string' ? p.path_in_repo.trim() : ''
  const message = typeof p.message === 'string' ? p.message.trim() : 'Delete file via Instatic'

  if (!repoId) return { ok: false, error: 'repo_id is required' }
  if (!pathInRepo) return { ok: false, error: 'path_in_repo is required' }

  const token = getHfToken()
  if (!token) {
    return {
      ok: false,
      error:
        'No HuggingFace API token found. Please either set HUGGINGFACE_API_TOKEN environment variable, or configure the token in the HuggingFace plugin settings panel. Get a free token at https://huggingface.co/settings/tokens',
    }
  }

  const typePrefix = repoType === 'model' ? '' : `${repoType}s/`

  try {
    const res = await proxyFetch(
      `${HF_HUB_API}/${typePrefix}${encodeURIComponent(repoId)}/commit/main`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          summary: message,
          files_to_delete: [pathInRepo],
        }),
      },
    )

    if (!res.ok) {
      const errorText = await res.text().catch(() => res.statusText)
      return { ok: false, error: `Delete file failed: ${res.status} ${errorText}` }
    }

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return {
      ok: true,
      data: {
        repo_id: repoId,
        repo_type: repoType,
        path: pathInRepo,
        commit: data.commit ?? data,
        url: `https://huggingface.co/${typePrefix}${repoId}/blob/main/${pathInRepo}`,
      },
    }
  } catch (err) {
    return { ok: false, error: `Failed to delete file: ${(err as Error).message}` }
  }
}

/** Get trending models, datasets, or Spaces from HuggingFace Hub. */
async function handleHfGetTrending(input: unknown): Promise<unknown> {
  const p = (input ?? {}) as Record<string, unknown>
  const type = typeof p.type === 'string' ? p.type : 'model'
  const period = typeof p.period === 'string' ? p.period : 'day'
  const limit = clampInt(p.limit, 1, 30, 10)

  if (!['model', 'dataset', 'space'].includes(type)) {
    return { ok: false, error: 'type must be one of: model, dataset, space' }
  }

  const typePath = type === 'model' ? 'models' : `${type}s`
  const periodParam = period === 'week' ? 'trendingWeek' : 'trending'

  try {
    const res = await retryFetch(
      `${HF_HUB_API}/${typePath}?sort=${periodParam}&direction=-1&limit=${limit}`,
      { headers: { Accept: 'application/json' } },
    )
    if (!res.ok) {
      return { ok: false, error: `HuggingFace API returned ${res.status}` }
    }
    const items = (await res.json()) as Array<Record<string, unknown>>
    const results = items.map((item) => ({
      id: item.id ?? 'unknown',
      likes: item.likes ?? 0,
      downloads: item.downloads ?? 0,
      tags: ((item.tags as string[] | undefined) ?? []).slice(0, 8),
      url: `https://huggingface.co/${type === 'space' ? 'spaces/' : type === 'dataset' ? 'datasets/' : ''}${item.id ?? ''}`,
    }))
    return {
      ok: true,
      data: {
        type,
        period,
        count: results.length,
        items: results,
      },
    }
  } catch (err) {
    return { ok: false, error: `Failed to get trending: ${(err as Error).message}` }
  }
}

/** Search HuggingFace Collections (curated lists). */
async function handleHfListCollections(input: unknown): Promise<unknown> {
  const p = (input ?? {}) as Record<string, unknown>
  const query = typeof p.query === 'string' ? p.query.trim() : undefined
  const author = typeof p.author === 'string' ? p.author.trim() : undefined
  const limit = clampInt(p.limit, 1, 30, 10)

  const q = buildQuery({
    search: query,
    author,
    limit,
  })

  try {
    const res = await retryFetch(`${HF_HUB_API}/collections${q}`, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      return { ok: false, error: `HuggingFace API returned ${res.status}` }
    }
    const collections = (await res.json()) as Array<Record<string, unknown>>
    const results = collections.map((c) => ({
      id: c.id ?? 'unknown',
      title: c.title ?? 'Untitled',
      owner: c.owner ?? 'unknown',
      items: c.numItems ?? c.items_count ?? 0,
      likes: c.likes ?? 0,
      url: c.url ?? `https://huggingface.co/collections/${c.owner ?? ''}/${c.id ?? ''}`,
    }))
    return { ok: true, data: { count: results.length, collections: results } }
  } catch (err) {
    return { ok: false, error: `Failed to list collections: ${(err as Error).message}` }
  }
}

/** List branches, tags, or commits in a HuggingFace repository. */
async function handleHfListRepoRefs(input: unknown): Promise<unknown> {
  const p = (input ?? {}) as Record<string, unknown>
  const repoId = typeof p.repo_id === 'string' ? p.repo_id.trim() : ''
  const repoType = typeof p.repo_type === 'string' ? p.repo_type : 'model'
  const include = typeof p.include === 'string' ? p.include : 'branches'

  if (!repoId) return { ok: false, error: 'repo_id is required' }
  if (!['model', 'dataset', 'space'].includes(repoType)) {
    return { ok: false, error: 'repo_type must be one of: model, dataset, space' }
  }
  if (!['branches', 'tags', 'commits'].includes(include)) {
    return { ok: false, error: 'include must be one of: branches, tags, commits' }
  }

  const typePrefix = repoType === 'model' ? '' : `${repoType}s/`

  try {
    let endpoint = ''
    if (include === 'branches') {
      endpoint = `${HF_HUB_API}/${typePrefix}${encodeURIComponent(repoId)}/branches`
    } else if (include === 'tags') {
      endpoint = `${HF_HUB_API}/${typePrefix}${encodeURIComponent(repoId)}/tags`
    } else {
      // commits — use the refs endpoint with branch=main
      endpoint = `${HF_HUB_API}/${typePrefix}${encodeURIComponent(repoId)}/commits/main`
    }

    const res = await retryFetch(endpoint, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      return { ok: false, error: `API returned ${res.status}: ${await res.text().catch(() => res.statusText)}` }
    }
    const data = (await res.json()) as Array<Record<string, unknown>> | Record<string, unknown>

    let results: unknown[] = []
    if (Array.isArray(data)) {
      results = data.map((item) => ({
        name: item.name ?? item.id ?? 'unknown',
        target: item.target ?? item.commit_id ?? '',
        date: item.date ?? '',
      }))
    } else if (include === 'commits' && data.commits && Array.isArray(data.commits)) {
      results = (data.commits as Array<Record<string, unknown>>).map((c) => ({
        id: c.id ?? 'unknown',
        message: c.message ?? '',
        date: c.date ?? '',
        authors: c.authors ?? [],
      }))
    }

    return {
      ok: true,
      data: {
        repo_id: repoId,
        repo_type: repoType,
        include,
        count: results.length,
        refs: results,
      },
    }
  } catch (err) {
    return { ok: false, error: `Failed to list repo refs: ${(err as Error).message}` }
  }
}

/** Delete a HuggingFace repository. */
async function handleHfDeleteRepo(input: unknown): Promise<unknown> {
  const p = (input ?? {}) as Record<string, unknown>
  const repoId = typeof p.repo_id === 'string' ? p.repo_id.trim() : ''
  const repoType = typeof p.repo_type === 'string' ? p.repo_type : 'model'

  if (!repoId) return { ok: false, error: 'repo_id is required' }

  const token = getHfToken()
  if (!token) {
    return {
      ok: false,
      error:
        'No HuggingFace API token found. Please either set HUGGINGFACE_API_TOKEN environment variable, or configure the token in the HuggingFace plugin settings panel. Get a free token at https://huggingface.co/settings/tokens',
    }
  }

  try {
    const res = await proxyFetch(`${HF_HUB_API}/repos/delete`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        repo_id: repoId,
        type: repoType === 'model' ? 'model' : repoType,
      }),
    })

    if (!res.ok) {
      const errorText = await res.text().catch(() => res.statusText)
      return { ok: false, error: `Delete failed: ${res.status} ${errorText}` }
    }

    return {
      ok: true,
      data: {
        repo_id: repoId,
        repo_type: repoType,
        message: 'Repository deleted successfully.',
      },
    }
  } catch (err) {
    return { ok: false, error: `Failed to delete repo: ${(err as Error).message}` }
  }
}

/** Execute a HuggingFace hf CLI command. */
async function handleHfRunCommand(input: unknown): Promise<unknown> {
  const p = (input ?? {}) as Record<string, unknown>
  const command = typeof p.command === 'string' ? p.command.trim() : ''
  const args = Array.isArray(p.args) ? p.args.filter((a): a is string => typeof a === 'string') : []
  const flags = typeof p.flags === 'object' && p.flags != null ? p.flags as Record<string, unknown> : {}
  const jsonOutput = p.json_output !== false

  if (!command) return { ok: false, error: 'command is required' }

  // Check if hf CLI is available
  try {
    const check = Bun.spawnSync(['hf', '--version'], { stdout: 'ignore', stderr: 'ignore' })
    if (check.exitCode !== 0) {
      return {
        ok: false,
        error:
          'hf CLI is not installed. Install it via: pip install -U "huggingface_hub" or follow https://huggingface.co/docs/huggingface_hub/guides/cli#getting-started',
      }
    }
  } catch {
    return {
      ok: false,
      error:
        'hf CLI is not installed. Install it via: pip install -U "huggingface_hub" or follow https://huggingface.co/docs/huggingface_hub/guides/cli#getting-started',
    }
  }

  // Build command arguments
  const cmdArgs = command.split(/\s+/).concat(args)

  // Inject token if available
  const token = getHfToken()
  if (token && !args.some((a) => a.startsWith('--token='))) {
    cmdArgs.push(`--token=${token}`)
  }

  // Add --json for structured output
  if (jsonOutput && !args.some((a) => a === '--json' || a.startsWith('--format='))) {
    cmdArgs.push('--json')
  }

  // Add flags
  for (const [key, val] of Object.entries(flags)) {
    if (val === true) {
      cmdArgs.push(`--${key}`)
    } else if (val !== false && val != null) {
      cmdArgs.push(`--${key}=${String(val)}`)
    }
  }

  try {
    const result = Bun.spawnSync(['hf', ...cmdArgs], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...(token ? { HF_TOKEN: token } : {}) },
    })

    const stdout = new TextDecoder().decode(result.stdout)
    const stderr = new TextDecoder().decode(result.stderr)

    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: `hf CLI exited with code ${result.exitCode}. stderr: ${stderr || stdout || 'unknown error'}`,
      }
    }

    // Try to parse as JSON
    let parsed: unknown = null
    if (jsonOutput && stdout.trim()) {
      try {
        parsed = JSON.parse(stdout.trim())
      } catch {
        // Not valid JSON, keep raw output
      }
    }

    return {
      ok: true,
      data: {
        command: `hf ${command}`,
        exit_code: result.exitCode,
        output: parsed ?? stdout,
        stderr: stderr || undefined,
      },
    }
  } catch (err) {
    return { ok: false, error: `Failed to run hf command: ${(err as Error).message}` }
  }
}

// ===========================================================================
// Handler registry — keyed by `<pluginId>:<toolName>`
// ===========================================================================

type LocalToolHandler = (input: unknown) => Promise<unknown>

const HANDLERS: Record<string, LocalToolHandler> = {
  'instatic.weather:get_weather': handleWeatherGet,
  'instatic.weather:get_forecast': handleWeatherForecast,
  'instatic.youtube-summarizer:summarize_youtube': handleYoutubeSummarize,
  'instatic.huggingface:search_models': handleHfSearchModels,
  'instatic.huggingface:get_model_info': handleHfGetModelInfo,
  'instatic.huggingface:search_datasets': handleHfSearchDatasets,
  'instatic.huggingface:search_spaces': handleHfSearchSpaces,
  'instatic.huggingface:run_inference': handleHfRunInference,
  'instatic.huggingface:get_dataset_info': handleHfGetDatasetInfo,
  'instatic.huggingface:list_repo_files': handleHfListRepoFiles,
  'instatic.huggingface:create_repo': handleHfCreateRepo,
  'instatic.huggingface:upload_file': handleHfUploadFile,
  'instatic.huggingface:get_repo_readme': handleHfGetRepoReadme,
  'instatic.huggingface:get_whoami': handleHfGetWhoami,
  'instatic.huggingface:download_file': handleHfDownloadFile,
  'instatic.huggingface:delete_repo': handleHfDeleteRepo,
  'instatic.huggingface:run_hf_command': handleHfRunCommand,
  'instatic.huggingface:delete_file': handleHfDeleteFile,
  'instatic.huggingface:get_trending': handleHfGetTrending,
  'instatic.huggingface:list_collections': handleHfListCollections,
  'instatic.huggingface:list_repo_refs': handleHfListRepoRefs,
}

/**
 * Look up a local handler for a skill tool.
 *
 * Returns the handler function when one is registered for the
 * `(pluginId, toolName)` pair, or `null` to signal "no local handler —
 * fall through to the worker RPC path".
 *
 * Called from `buildAiToolFromSkillTool` in `./index.ts` on every tool
 * invocation. The lookup is a single `Record.get` — O(1), no allocation —
 * so the always-fallback case (skills without a local handler) is cheap.
 */
export function lookupLocalHandler(
  pluginId: string,
  toolName: string,
): LocalToolHandler | null {
  return HANDLERS[`${pluginId}:${toolName}`] ?? null
}
