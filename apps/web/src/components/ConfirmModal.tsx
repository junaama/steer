export interface ConfirmModalProps {
  title: string
  message: string
  confirmLabel?: string
  onClose: () => void
  onConfirm: () => void
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = 'Delete',
  onClose,
  onConfirm,
}: ConfirmModalProps): JSX.Element {
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="modal sm" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <p>{message}</p>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            Keep
          </button>
          <button className="btn danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
