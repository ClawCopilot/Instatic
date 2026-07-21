import { memo, useEffect, useRef } from 'react'
import { Button } from '@ui/components/Button'
import styles from './AgentPanel.module.css'

interface ScreenshotLightboxProps {
  /** base64 data URL of the screenshot */
  src: string | null
  /** Close callback */
  onClose: () => void
}

const ScreenshotLightbox = memo(function ScreenshotLightbox({ src, onClose }: ScreenshotLightboxProps) {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!src) return

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }

    // Prevent body scroll when lightbox is open
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.body.style.overflow = ''
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [src, onClose])

  if (!src) return null

  return (
    <div
      className={styles.lightboxOverlay}
      ref={overlayRef}
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose()
      }}
      role="dialog"
      aria-label="Screenshot preview"
      aria-modal="true"
    >
      <Button
        type="button"
        variant="ghost"
        size="xs"
        iconOnly
        className={styles.lightboxClose}
        onClick={onClose}
        aria-label="Close"
      >
        ×
      </Button>
      <img
        className={styles.lightboxImage}
        src={src}
        alt="Screenshot preview"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
})

export { ScreenshotLightbox }