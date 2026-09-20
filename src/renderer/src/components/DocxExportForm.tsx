import {
  BODY_FONTS,
  CAPTION_ALIGNS,
  FIGURE_BACKGROUNDS,
  FIGURE_SCALES,
  INFOGRAPHIC_THEMES,
  MERMAID_THEMES,
  MONO_FONTS,
  PAGE_ORIENTATIONS,
  PAGE_SIZES,
  TOC_DEPTHS,
  summarizeDocxConfig,
  type DocxExportConfig
} from '@shared/docx-config'
import { Field, Select, TextInput } from './ui'

export function DocxExportForm({
  config,
  onChange,
  readOnly = false
}: {
  config: DocxExportConfig
  onChange: (next: DocxExportConfig) => void
  readOnly?: boolean
}): React.JSX.Element {
  const patch = (next: DocxExportConfig): void => onChange(next)
  return (
    <div className="stack">
      <p className="export-summary" data-testid="docx-export-summary">
        {summarizeDocxConfig(config)}
      </p>
      <section className="export-section">
        <h3>Page</h3>
        <div className="form-grid form-grid--compact">
          <Field label="Size">
            <Select
              disabled={readOnly}
              value={config.page.size}
              onChange={(event) =>
                patch({
                  ...config,
                  page: { ...config.page, size: event.target.value as typeof config.page.size }
                })
              }
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Orientation">
            <Select
              disabled={readOnly}
              value={config.page.orientation}
              onChange={(event) =>
                patch({
                  ...config,
                  page: {
                    ...config.page,
                    orientation: event.target.value as typeof config.page.orientation
                  }
                })
              }
            >
              {PAGE_ORIENTATIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
            <Field key={side} label={`Margin ${side} (mm)`}>
              <TextInput
                type="number"
                min={5}
                max={50}
                disabled={readOnly}
                value={config.page.marginsMm[side]}
                onChange={(event) =>
                  patch({
                    ...config,
                    page: {
                      ...config.page,
                      marginsMm: { ...config.page.marginsMm, [side]: Number(event.target.value) }
                    }
                  })
                }
              />
            </Field>
          ))}
        </div>
      </section>
      <section className="export-section">
        <h3>Title & contents</h3>
        <div className="form-grid">
          <label className="field field--check">
            <input
              type="checkbox"
              disabled={readOnly}
              checked={config.titleBlock.enabled}
              onChange={(event) =>
                patch({
                  ...config,
                  titleBlock: { ...config.titleBlock, enabled: event.target.checked }
                })
              }
            />
            <span>Title block</span>
          </label>
          <label className="field field--check">
            <input
              type="checkbox"
              disabled={readOnly}
              checked={config.toc.enabled}
              onChange={(event) =>
                patch({ ...config, toc: { ...config.toc, enabled: event.target.checked } })
              }
            />
            <span>Table of contents</span>
          </label>
          <Field label="TOC depth">
            <Select
              disabled={readOnly || !config.toc.enabled}
              value={config.toc.depth}
              onChange={(event) =>
                patch({
                  ...config,
                  toc: { ...config.toc, depth: Number(event.target.value) as 1 | 2 | 3 | 4 }
                })
              }
            >
              {TOC_DEPTHS.map((depth) => (
                <option key={depth} value={depth}>
                  H{depth}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="TOC title">
            <TextInput
              disabled={readOnly || !config.toc.enabled}
              value={config.toc.title}
              onChange={(event) =>
                patch({ ...config, toc: { ...config.toc, title: event.target.value } })
              }
            />
          </Field>
          <label className="field field--check">
            <input
              type="checkbox"
              disabled={readOnly}
              checked={config.headings.chapterPageBreaks}
              onChange={(event) =>
                patch({ ...config, headings: { chapterPageBreaks: event.target.checked } })
              }
            />
            <span>Page break before each H1</span>
          </label>
          <label className="field field--check">
            <input
              type="checkbox"
              disabled={readOnly}
              checked={config.footer.pageNumbers}
              onChange={(event) =>
                patch({ ...config, footer: { pageNumbers: event.target.checked } })
              }
            />
            <span>Page numbers</span>
          </label>
        </div>
      </section>
      <section className="export-section">
        <h3>Typography</h3>
        <div className="form-grid form-grid--compact">
          <Field label="Body">
            <Select
              disabled={readOnly}
              value={config.typography.body}
              onChange={(event) =>
                patch({
                  ...config,
                  typography: {
                    ...config.typography,
                    body: event.target.value as typeof config.typography.body
                  }
                })
              }
            >
              {BODY_FONTS.map((font) => (
                <option key={font} value={font}>
                  {font}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Headings">
            <Select
              disabled={readOnly}
              value={config.typography.heading}
              onChange={(event) =>
                patch({
                  ...config,
                  typography: {
                    ...config.typography,
                    heading: event.target.value as typeof config.typography.heading
                  }
                })
              }
            >
              {BODY_FONTS.map((font) => (
                <option key={font} value={font}>
                  {font}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Mono">
            <Select
              disabled={readOnly}
              value={config.typography.mono}
              onChange={(event) =>
                patch({
                  ...config,
                  typography: {
                    ...config.typography,
                    mono: event.target.value as typeof config.typography.mono
                  }
                })
              }
            >
              {MONO_FONTS.map((font) => (
                <option key={font} value={font}>
                  {font}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </section>
      <section className="export-section">
        <h3>Figures</h3>
        <div className="form-grid form-grid--compact">
          <Field label="Scale">
            <Select
              disabled={readOnly}
              value={config.figures.scale}
              onChange={(event) =>
                patch({
                  ...config,
                  figures: { ...config.figures, scale: Number(event.target.value) as 1 | 2 | 3 | 4 }
                })
              }
            >
              {FIGURE_SCALES.map((scale) => (
                <option key={scale} value={scale}>
                  {scale}×
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Caption align">
            <Select
              disabled={readOnly}
              value={config.figures.captionAlign}
              onChange={(event) =>
                patch({
                  ...config,
                  figures: {
                    ...config.figures,
                    captionAlign: event.target.value as (typeof CAPTION_ALIGNS)[number]
                  }
                })
              }
            >
              {CAPTION_ALIGNS.map((align) => (
                <option key={align} value={align}>
                  {align}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Mermaid theme">
            <Select
              disabled={readOnly}
              value={config.figures.mermaidTheme}
              onChange={(event) =>
                patch({
                  ...config,
                  figures: {
                    ...config.figures,
                    mermaidTheme: event.target.value as (typeof MERMAID_THEMES)[number]
                  }
                })
              }
            >
              {MERMAID_THEMES.map((theme) => (
                <option key={theme} value={theme}>
                  {theme}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Infographic theme">
            <Select
              disabled={readOnly}
              value={config.figures.infographicTheme}
              onChange={(event) =>
                patch({
                  ...config,
                  figures: {
                    ...config.figures,
                    infographicTheme: event.target.value as (typeof INFOGRAPHIC_THEMES)[number]
                  }
                })
              }
            >
              {INFOGRAPHIC_THEMES.map((theme) => (
                <option key={theme} value={theme}>
                  {theme}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Background">
            <Select
              disabled={readOnly}
              value={config.figures.background}
              onChange={(event) =>
                patch({
                  ...config,
                  figures: {
                    ...config.figures,
                    background: event.target.value as (typeof FIGURE_BACKGROUNDS)[number]
                  }
                })
              }
            >
              {FIGURE_BACKGROUNDS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <label className="field field--check">
            <input
              type="checkbox"
              disabled={readOnly}
              checked={config.figures.numberCaptions}
              onChange={(event) =>
                patch({
                  ...config,
                  figures: { ...config.figures, numberCaptions: event.target.checked }
                })
              }
            />
            <span>Number captions</span>
          </label>
        </div>
      </section>
    </div>
  )
}
