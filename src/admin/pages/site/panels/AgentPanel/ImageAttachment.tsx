/**
 * ImageAttachment — file-picker button + removable thumbnail preview for
 * attaching an image to an AI message.
 *
 * When the user clicks the button a hidden <input type="file"> opens.
 * The selected image is read as a base-64 data URL (capped at 4 MB) and
 * forwarded to the parent via `onImageAttached`. A small thumbnail
 * preview appears above the textarea; the "x" button removes it.
 */

import { useRef, memo, useCallback } from 'react'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { Button } from '@ui/components/Button'
import styles from './AgentPanel.module.css'

interface ImageAttachmentProps {
  onImageAttached: (base64DataUrl: string) => void
  onImageRemoved: () => void
  disabled?: boolean
  attachedImage: string | null
}

const ImageAttachment = memo(function ImageAttachment({
  onImageAttached,
  onImageRemoved,
  disabled,
  attachedImage,
}: ImageAttachmentProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return

      // Validate it's an image
      if (!file.type.startsWith('image/')) return

      // Limit size to 4 MB
      if (file.size > 4 * 1024 * 1024) return

      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        onImageAttached(dataUrl)
      }
      reader.readAsDataURL(file)

      // Reset input so same file can be re-selected
      e.target.value = ''
    },
    [onImageAttached],
  )

  return (
    <>
      {attachedImage && (
        <div className={styles.imageAttachmentPreview}>
          <img
            src={attachedImage}
            alt="Attached image"
            className={styles.imageAttachmentImg}
          />
          <Button
            type="button"
            variant="ghost"
            size="xs"
            iconOnly
            className={styles.imageAttachmentRemove}
            onClick={onImageRemoved}
            aria-label="Remove attached image"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </Button>
        </div>
      )}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        iconOnly
        className={styles.imageAttachmentBtn}
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled}
        aria-label="Attach image"
      >
        <ImageSolidIcon size={14} aria-hidden="true" />
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        onChange={handleFileChange}
        className={styles.srOnly}
      />
    </>
  )
})

export { ImageAttachment }