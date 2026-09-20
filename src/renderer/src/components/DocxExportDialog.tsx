import { useState } from 'react'
import { normalizeDocxConfig, type DocxExportConfig } from '@shared/docx-config'
import { useAppState } from '../state/AppState'
import { getClient } from '../sync/clients'
import { configForDocument } from '../lib/docx-export'
import { DocxExportForm } from './DocxExportForm'
import { Button, Modal } from './ui'

export function DocxExportDialog({
  onExport
}: {
  onExport: (config: DocxExportConfig) => void
}): React.JSX.Element | null {
  const { state, dispatch } = useAppState()
  const session = state.session
  const client = session ? getClient(session.id) : undefined
  const readOnly = Boolean(session?.share.readOnly)
  const [draft, setDraft] = useState<DocxExportConfig>(() =>
    client ? configForDocument(client, state.docxDefaults) : state.docxDefaults
  )

  if (!state.docxExportOpen || !session || !client) return null

  const saveSettings = (): void => {
    if (readOnly) return
    client.setDocxConfig(normalizeDocxConfig(draft))
    dispatch({ type: 'notice', message: 'Export settings saved' })
  }

  return (
    <Modal
      wide
      title="Export to Word"
      subtitle={
        readOnly ? 'You can export, but only writers can change these settings.' : undefined
      }
      onClose={() => dispatch({ type: 'set-docx-export-open', open: false })}
    >
      <div data-testid="docx-export-dialog">
        <DocxExportForm config={draft} onChange={setDraft} readOnly={readOnly} />
        <div className="modal__actions">
          <Button
            data-testid="docx-export-cancel"
            onClick={() => dispatch({ type: 'set-docx-export-open', open: false })}
          >
            Cancel
          </Button>
          <Button
            data-testid="docx-export-save-settings"
            disabled={readOnly}
            onClick={saveSettings}
          >
            Save settings
          </Button>
          <Button
            variant="primary"
            data-testid="docx-export-submit"
            onClick={() => {
              const config = normalizeDocxConfig(draft)
              if (!readOnly) client.setDocxConfig(config)
              dispatch({ type: 'set-docx-export-open', open: false })
              onExport(config)
            }}
          >
            Export
          </Button>
        </div>
      </div>
    </Modal>
  )
}
