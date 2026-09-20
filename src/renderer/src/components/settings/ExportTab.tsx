import { useState } from 'react'
import { normalizeDocxConfig, type DocxExportConfig } from '@shared/docx-config'
import { useAppState } from '../../state/AppState'
import { DocxExportForm } from '../DocxExportForm'

export function ExportTab(): React.JSX.Element {
  const { state, dispatch } = useAppState()
  // The form shows what was typed; the stored defaults are always the normalised value,
  // and the field snaps to it once it loses focus (typing "15" must not clamp at "1").
  const [draft, setDraft] = useState<DocxExportConfig>(state.docxDefaults)
  const update = (config: DocxExportConfig): void => {
    setDraft(config)
    dispatch({ type: 'set-docx-defaults', config: normalizeDocxConfig(config) })
  }
  return (
    <div
      className="stack"
      data-testid="settings-export"
      onBlur={() => setDraft(normalizeDocxConfig(draft))}
    >
      <p className="lede">
        Used as defaults for new documents and for Save As when a document has no stored export
        settings. A document’s own settings are never overwritten from here.
      </p>
      <DocxExportForm config={draft} onChange={update} />
    </div>
  )
}
