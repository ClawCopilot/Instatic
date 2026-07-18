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
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
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
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
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
    const res = await fetch(url)
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
    const res = await fetch(url)
    if (!res.ok) {
      return { ok: false, error: `Open-Meteo request failed: ${res.status} ${res.statusText}` }
    }
    const data = (await res.json()) as OpenMeteoForecastResponse
    if (!data.daily) {
      return { ok: false, error: 'Open-Meteo returned no daily forecast data' }
    }
    const d = data.daily
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
  const res = await fetch(url)
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
  }
  const urlOrId = args?.urlOrId
  if (!urlOrId || typeof urlOrId !== 'string' || urlOrId.trim() === '') {
    return { ok: false, error: 'urlOrId is required and must be a non-empty string' }
  }
  const includeTimestamps = args.includeTimestamps !== false
  // summaryLength is passed through to the model via the note below — the
  // handler only fetches the transcript, the model does the actual summary.
  const summaryLength = args.summaryLength ?? 'medium'

  const videoId = extractVideoId(urlOrId)
  if (!videoId) {
    return { ok: false, error: `Invalid YouTube URL or ID: ${urlOrId}` }
  }

  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
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

    // Pick the first track (usually the primary language of the video).
    const track = tracks[0]
    const transcriptRes = await fetch(track.baseUrl)
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

    return {
      ok: true,
      data: {
        videoId,
        transcript,
        transcriptLength: transcript.length,
        note:
          `Transcript retrieved. The AI should summarise it based on the ` +
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
// Handler registry — keyed by `<pluginId>:<toolName>`
// ===========================================================================

type LocalToolHandler = (input: unknown) => Promise<unknown>

const HANDLERS: Record<string, LocalToolHandler> = {
  'instatic.weather:get_weather': handleWeatherGet,
  'instatic.weather:get_forecast': handleWeatherForecast,
  'instatic.youtube-summarizer:summarize_youtube': handleYoutubeSummarize,
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
