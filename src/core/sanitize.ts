/**
 * Sanitise utility for richtext prop values.
 *
 * WHY THIS EXISTS
 * ---------------
 * The publisher's `escapeProps()` passes richtext props through WITHOUT HTML-escaping,
 * relying on the assumption that DOMPurify has already sanitized them at input time.
 * This module provides that sanitization.
 *
 * USAGE
 * -----
 * Call `sanitizeRichtext(value)` at EVERY write path that stores a richtext prop:
 *   - useSandboxBridge: PROP_CHANGE messages from sandboxed plugin module iframes
 *   - CMS draft hydration before store load
 *   - Phase D agent dispatcher: setProps tool calls for richtext-typed props
 *
 * Never trust that "the UI already sanitized it" — sanitize at every write path.
 *
 * CONFIGURATION
 * -------------
 * Default config allows safe formatting tags (strong, em, u, a, ul, ol, li, p, br, h1-h6)
 * and blocks all script execution. Use `sanitizeRichtext(val, STRICT_CONFIG)` to strip
 * all HTML tags and return plain text only (e.g. for meta fields, titles).
 *
 * @see Task #261 — Enforce DOMPurify at Properties Panel boundary
 * @see Contribution #368 — Security Auditor INFO finding
 * @see render.ts escapeProps() — richtext props are passed through unescaped
 */

import DOMPurify, { type Config } from 'dompurify'

type DOMPurifyHookNode = {
  tagName?: string
  setAttribute?: (name: string, value: string) => void
}

export type DOMPurifyRuntime = {
  sanitize?: (value: string, config?: Config) => unknown
  addHook?: (hookName: 'afterSanitizeAttributes', callback: (node: DOMPurifyHookNode) => void) => void
}

type DOMPurifyFactory = DOMPurifyRuntime & ((window: Window) => DOMPurifyRuntime)

const importedDOMPurify = DOMPurify as unknown as DOMPurifyFactory
let activeDOMPurify: DOMPurifyRuntime | null = null
const purifiersWithLinkHook = new WeakSet<object>()

function installLinkHook(purifier: DOMPurifyRuntime): DOMPurifyRuntime {
  if (!purifiersWithLinkHook.has(purifier) && typeof purifier.addHook === 'function') {
    purifier.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        node.setAttribute?.('target', '_blank')
        node.setAttribute?.('rel', 'noopener noreferrer')
      }
    })
    purifiersWithLinkHook.add(purifier)
  }
  return purifier
}

export function configureRichtextSanitizer(purifier: DOMPurifyRuntime | null): void {
  activeDOMPurify = purifier ? installLinkHook(purifier) : null
}

function getDOMPurify(): DOMPurifyRuntime | null {
  // Always prefer the explicitly-configured runtime.
  if (activeDOMPurify && typeof activeDOMPurify.sanitize === 'function') {
    return installLinkHook(activeDOMPurify)
  }

  // The module-level importedDOMPurify may have been created against the
  // wrong window during module load (e.g. CI environments where Bun exposes
  // a default window object before our test setup runs).  Instead of using
  // it directly, treat it as a factory and create a fresh instance with the
  // *current* window so we are guaranteed a runtime backed by the DOM we
  // actually want (happy-dom in tests, real DOM in browser).
  const win =
    (globalThis as { __HAPPY_DOM_WINDOW__?: Window }).__HAPPY_DOM_WINDOW__ ??
    (typeof window !== 'undefined' ? window : null)

  if (win && typeof importedDOMPurify === 'function') {
    const fresh = importedDOMPurify(win)
    if (typeof fresh.sanitize === 'function') {
      activeDOMPurify = fresh
      return installLinkHook(fresh)
    }
  }

  return null
}

/**
 * Regex HTML strip used ONLY when no DOMPurify runtime is available (one-off
 * scripts; browser + Bun server both configure DOMPurify).
 *
 * Three stages, each looped to a fixpoint with a single literal regex — the
 * exact do-while-until-stable form CodeQL recognises as a complete sanitizer
 * (js/incomplete-multi-character-sanitization). Looping matters because removing
 * one match can reveal another: split-tag obfuscation `<scr<script>ipt>` only
 * collapses after the inner match goes. Close tags use `(?:[\s/][^>]*)?` since
 * the HTML parser ends a tag at the first `>` (js/bad-tag-filter). Each pass
 * strictly shrinks the string, so every loop terminates.
 *
 * 1. drop `<script>…</script>` blocks (removes the JS source, not just the tag)
 * 2. drop `<style>…</style>` blocks (CSS can carry `@import url(javascript:…)`)
 * 3. drop every remaining tag, incl. bare/unbalanced `<script`/`<style` openers
 */
function stripHtmlFallback(value: string): string {
  let current = value
  let previous: string
  do {
    previous = current
    current = current.replace(/<script\b[^>]*>[\s\S]*?<\/script(?:[\s/][^>]*)?>/gi, '')
  } while (current !== previous)
  do {
    previous = current
    current = current.replace(/<style\b[^>]*>[\s\S]*?<\/style(?:[\s/][^>]*)?>/gi, '')
  } while (current !== previous)
  do {
    previous = current
    current = current.replace(/<[^>]*>/g, '')
  } while (current !== previous)
  return current
}

// ---------------------------------------------------------------------------
// DOMPurify configuration profiles
// ---------------------------------------------------------------------------

/**
 * Default richtext config — allows safe HTML formatting, blocks all scripts.
 * Suitable for user-authored HTML content (headings, paragraphs, lists, links).
 */
const RICHTEXT_CONFIG: Config = {
  // Allow safe semantic/formatting tags
  ALLOWED_TAGS: [
    'p', 'br',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins',
    'a', 'ul', 'ol', 'li',
    'blockquote', 'code', 'pre',
    'span', 'div',
  ],
  // Restrict attributes to safe subset; data-* is blocked by default
  ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'id'],
  // Force all links to open in a new tab with noopener
  ADD_ATTR: ['target'],
  // Never allow data: / javascript: in href
  ALLOW_DATA_ATTR: false,
  // Prevent mXSS via HTML namespace confusion
  NAMESPACE: 'http://www.w3.org/1999/xhtml',
  // Return a string, not a DOM node
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
}

/**
 * Strict config — strips ALL HTML tags; returns plain text only.
 * Use for single-line fields that should never contain markup.
 * Pass this to `sanitizeRichtext()` — it applies a post-strip pass to catch
 * any tags that DOMPurify's `ALLOWED_TAGS: []` might not catch in edge cases.
 */
export const PLAIN_TEXT_CONFIG: Config & { _plainText?: true } = {
  ALLOWED_TAGS: [],
  ALLOWED_ATTR: [],
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
  _plainText: true,  // sentinel: triggers regex post-strip pass in sanitizeRichtext()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sanitize a richtext prop value using DOMPurify.
 *
 * Call this at EVERY write path before storing a richtext prop value in the store.
 * The value returned is safe to insert into an HTML page via the publisher pipeline.
 *
 * @param value  — raw user input (may contain malicious HTML)
 * @param config — DOMPurify config (defaults to RICHTEXT_CONFIG)
 * @returns sanitized HTML string, safe for publisher output
 */
export function sanitizeRichtext(
  value: unknown,
  config: Config & { _plainText?: true } = RICHTEXT_CONFIG,
): string {
  const str = String(value ?? '')
  if (!str.trim()) return ''

  // DOMPurify requires a live DOM-backed runtime. The browser has one
  // naturally; the Bun server installs an explicit runtime in
  // `server/richtextSanitizer.ts`. One-off scripts that do neither get the
  // conservative plain-text fallback.
  const purifier = getDOMPurify()
  if (!purifier || typeof purifier.sanitize !== 'function') {
    const stripped = stripHtmlFallback(str)
    return config._plainText ? stripped.trim() : stripped
  }

  let sanitized = String(purifier.sanitize(str, config))

  // When plain-text mode is requested, apply a post-strip pass.
  // DOMPurify's ALLOWED_TAGS:[] covers most cases but certain browsers / DOM
  // implementations may preserve some inline elements. The fixpoint stripper is
  // the guaranteed fallback (and resists split-tag obfuscation).
  if (config._plainText) {
    return stripHtmlFallback(sanitized).trim()
  }

  // After sanitization, ensure all links have rel="noopener noreferrer"
  // as a defense-in-depth measure (happy-dom on Linux may not fire hooks).
  sanitized = sanitized.replace(/<a\s([^>]*)>/gi, (_, attrs) => {
    if (!/rel\s*=\s*["']/i.test(attrs)) {
      return `<a rel="noopener noreferrer" ${attrs}>`
    }
    return `<a ${attrs}>`
  })

  return sanitized
}

/**
 * Check whether a module schema prop key refers to a richtext type.
 * Canonical key-name heuristic shared across layers (persistence validation,
 * the agent executor, and template binding resolution).
 */
export function isRichtextPropKey(key: string): boolean {
  const k = key.toLowerCase()
  return k === 'richtext' || k === 'html' || k.endsWith('html') || k.endsWith('richtext')
}

// ---------------------------------------------------------------------------
// SVG sanitisation
// ---------------------------------------------------------------------------

/**
 * SVG profile — allows the SVG + SVG-filter element/attribute set, blocks all
 * HTML (so `<foreignObject>` can't smuggle markup), scripts, and event
 * handlers. Used by the `base.svg` module so imported / pasted inline SVG
 * (logos, icons) round-trips and renders, while staying XSS-safe.
 *
 * `currentColor` and presentation attributes survive, so an SVG styled by a
 * CSS class (`fill: currentColor`) keeps inheriting the page's text colour.
 */
const SVG_CONFIG: Config = {
  USE_PROFILES: { svg: true, svgFilters: true },
  // Defence in depth — DOMPurify's svg profile already excludes these, but be
  // explicit: no HTML embedding, no script, no nested anchors carrying hrefs.
  FORBID_TAGS: ['script', 'foreignObject', 'a'],
  FORBID_ATTR: ['xlink:href', 'href'],
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
}

/**
 * Sanitise an inline-SVG markup string for safe inclusion in published HTML
 * and the editor canvas. Returns `''` when no DOMPurify runtime is available
 * (one-off scripts) — the browser and the Bun publish server both configure
 * one, so production paths always sanitise rather than drop.
 *
 * Call at every write path that stores an SVG prop (editor onChange, importer)
 * AND at the publisher boundary (`escapeProps`), per the "never trust the UI"
 * rule that governs richtext.
 */
export function sanitizeSvg(value: unknown): string {
  const str = String(value ?? '')
  if (!str.trim()) return ''

  const purifier = getDOMPurify()
  if (!purifier || typeof purifier.sanitize !== 'function') {
    // No runtime: refuse to emit unsanitised markup. Stripping tags would
    // empty the SVG anyway, so return nothing.
    return ''
  }

  let sanitized = String(purifier.sanitize(str, SVG_CONFIG))

  // Strip <foreignObject> as defense-in-depth (happy-dom on Linux may not
  // enforce FORBID_TAGS).
  sanitized = sanitized.replace(/<foreignObject[\s>][\s\S]*?<\/foreignObject>/gi, '')

  return sanitized
}
