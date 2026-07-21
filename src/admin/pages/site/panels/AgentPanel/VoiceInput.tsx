/**
 * VoiceInput — speech-to-text toggle button for the chat composer.
 *
 * Wraps the Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`).
 * The button is conditionally rendered: it only mounts when the browser
 * supports speech recognition and is not explicitly disabled by the parent.
 * While listening, the button receives a pulsing danger-tone active state
 * and can be clicked again to stop.
 */

import { useState, useRef, useCallback, memo } from 'react'
import { Button } from '@ui/components/Button'
import styles from './AgentPanel.module.css'

interface VoiceInputProps {
  onTranscript: (text: string) => void
  disabled?: boolean
}

// Check if browser supports speech recognition
const SpeechRecognition =
  typeof window !== 'undefined'
    ? ((window as any).SpeechRecognition ||
        (window as any).webkitSpeechRecognition)
    : undefined

export const VoiceInputSupported = !!SpeechRecognition

const VoiceInput = memo(function VoiceInput({
  onTranscript,
  disabled,
}: VoiceInputProps) {
  const [isListening, setIsListening] = useState(false)
  const recognitionRef = useRef<any>(null)

  const toggleListening = useCallback(() => {
    if (isListening) {
      recognitionRef.current?.stop()
      setIsListening(false)
      return
    }

    if (!SpeechRecognition) return

    const recognition = new SpeechRecognition()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = 'zh-CN' // Default to Chinese; browser auto-detects

    recognition.onresult = (event: any) => {
      const transcript = Array.from(event.results)
        .map((r: any) => r[0].transcript)
        .join('')
      onTranscript(transcript)
    }

    recognition.onend = () => {
      setIsListening(false)
    }

    recognition.onerror = () => {
      setIsListening(false)
    }

    recognitionRef.current = recognition
    recognition.start()
    setIsListening(true)
  }, [isListening, onTranscript])

  if (!VoiceInputSupported || disabled) return null

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      iconOnly
      className={styles.voiceBtn}
      data-active={isListening ? '' : undefined}
      onClick={toggleListening}
      aria-label={isListening ? 'Stop listening' : 'Start voice input'}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M8 1a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM5 8V4a3 3 0 0 1 6 0v4a3 3 0 0 1-6 0z" />
        <path d="M2 8a6 6 0 0 0 12 0h-1a5 5 0 0 1-10 0H2zm4 6v1a2 2 0 0 0 4 0v-1H6z" />
      </svg>
    </Button>
  )
})

export { VoiceInput }