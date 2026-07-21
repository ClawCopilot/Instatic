import { memo, useMemo } from 'react'
import { shallow } from 'zustand/shallow'
import { useAgentStore } from '@admin/ai/useAgentStore'
import styles from './AgentPanel.module.css'

interface Suggestion {
  label: string
  value: string
  type: 'color' | 'element' | 'font' | 'page'
}

const ELEMENT_SUGGESTIONS: Suggestion[] = [
  { label: 'Hero section', value: 'hero section', type: 'element' },
  { label: 'Navigation bar', value: 'navigation bar', type: 'element' },
  { label: 'Feature cards', value: 'feature cards', type: 'element' },
  { label: 'Footer', value: 'footer', type: 'element' },
  { label: 'Testimonials', value: 'testimonials section', type: 'element' },
  { label: 'Pricing table', value: 'pricing table', type: 'element' },
  { label: 'Contact form', value: 'contact form', type: 'element' },
  { label: 'Blog grid', value: 'blog grid', type: 'element' },
  { label: 'CTA banner', value: 'call-to-action banner', type: 'element' },
  { label: 'FAQ accordion', value: 'FAQ accordion', type: 'element' },
]

interface AutocompleteProps {
  text: string
  visible: boolean
  onSelect: (value: string) => void
  onClose: () => void
}

/** Safely read site-specific color tokens from the host store (site editor only). */
function useColorSuggestions(): Suggestion[] {
  const tokens = useAgentStore(
    (s) => {
      const store = s as unknown as {
        site?: {
          settings?: {
            framework?: {
              colors?: { tokens?: Array<{ slug: string; lightValue: string }> }
            }
          }
        }
      }
      return store.site?.settings?.framework?.colors?.tokens ?? []
    },
    shallow,
  )
  return useMemo(
    () =>
      tokens.map((t) => ({
        label: `Color ${t.slug} — ${t.lightValue}`,
        value: `var(--${t.slug})`,
        type: 'color' as const,
      })),
    [tokens],
  )
}

/** Safely read site-specific font tokens from the host store (site editor only). */
function useFontSuggestions(): Suggestion[] {
  const families = useAgentStore(
    (s) => {
      const store = s as unknown as {
        site?: {
          settings?: {
            fonts?: { families?: Array<{ cssVar: string; family?: string }> }
          }
        }
      }
      return store.site?.settings?.fonts?.families ?? []
    },
    shallow,
  )
  return useMemo(
    () =>
      families.map((f) => ({
        label: `Font ${f.cssVar} — ${f.family ?? 'custom'}`,
        value: `var(${f.cssVar})`,
        type: 'font' as const,
      })),
    [families],
  )
}

/** Safely read page names from the host store (site editor only). */
function usePageSuggestions(): Suggestion[] {
  const pages = useAgentStore(
    (s) => {
      const store = s as unknown as {
        site?: { pages?: Array<{ id: string; slug?: string; title?: string }> }
      }
      return store.site?.pages ?? []
    },
    shallow,
  )
  return useMemo(
    () =>
      pages.map((p) => ({
        label: `Page: ${p.title ?? p.slug ?? p.id}`,
        value: p.id,
        type: 'page' as const,
      })),
    [pages],
  )
}

const AutocompleteSuggestions = memo(function AutocompleteSuggestions({
  text,
  visible,
  onSelect,
  onClose,
}: AutocompleteProps) {
  const colorSuggestions = useColorSuggestions()
  const fontSuggestions = useFontSuggestions()
  const pageSuggestions = usePageSuggestions()

  const suggestions = useMemo(() => {
    if (!visible || text.length < 2) return []
    const lower = text.toLowerCase()

    // Element suggestions
    if (lower.includes('add') || lower.includes('insert') || lower.includes('create')) {
      return ELEMENT_SUGGESTIONS
    }

    // Color suggestions
    if (lower.includes('color') || lower.includes('#')) {
      return colorSuggestions.slice(0, 8)
    }

    // Font suggestions
    if (lower.includes('font')) {
      return fontSuggestions.slice(0, 8)
    }

    // Page suggestions
    if (lower.includes('page')) {
      return pageSuggestions.slice(0, 8)
    }

    return []
  }, [text, visible, colorSuggestions, fontSuggestions, pageSuggestions])

  if (suggestions.length === 0) return null

  return (
    <div className={styles.autocompletePanel} role="listbox">
      {suggestions.map((s) => (
        <div
          key={`${s.type}-${s.label}`}
          className={styles.autocompleteItem}
          role="option"
          onClick={() => {
            onSelect(s.value)
            onClose()
          }}
        >
          <span className={styles.autocompleteLabel}>{s.label}</span>
        </div>
      ))}
    </div>
  )
})

export default AutocompleteSuggestions
