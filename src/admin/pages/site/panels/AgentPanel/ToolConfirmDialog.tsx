import { Dialog } from '@ui/components/Dialog'
import { Button } from '@ui/components/Button'
import styles from './ToolConfirmDialog.module.css'

interface ToolConfirmDialogProps {
  open: boolean
  toolName: string
  toolInput: unknown
  onConfirm: () => void
  onReject: () => void
}

export function ToolConfirmDialog({ open, toolName, onReject, onConfirm }: ToolConfirmDialogProps) {
  const displayName = toolName.replace(/_/g, ' ')

  return (
    <Dialog
      open={open}
      onClose={onReject}
      title="Confirm destructive operation"
      tone="danger"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onReject}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm}>Confirm</Button>
        </>
      }
    >
      <p>
        The AI wants to execute: <span className={styles.toolName}>{displayName}</span>
      </p>
      <p className={styles.warning}>
        This operation may modify or delete content. Are you sure you want to proceed?
      </p>
    </Dialog>
  )
}
