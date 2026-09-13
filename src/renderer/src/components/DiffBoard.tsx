import type { DiffHunk } from '@core/history-diff'

export function DiffBoard({ hunks }: { hunks: DiffHunk[] }): React.JSX.Element {
  if (hunks.length === 0) {
    return <p className="empty">No text changes in this commit.</p>
  }
  return (
    <div className="diff-board" data-testid="diff-board">
      {hunks.map((hunk, i) => (
        <section
          key={`${hunk.blockId ?? i}-${hunk.kind}`}
          className={`diff-hunk diff-hunk--${hunk.kind}`}
        >
          <header>
            {hunk.kind} · {hunk.type}
            {hunk.blockId ? <span className="muted"> {hunk.blockId}</span> : null}
          </header>
          <pre>
            {hunk.parts.map((part, j) => (
              <span key={j} className={`diff-part diff-part--${part.type}`}>
                {part.text || (part.type === 'same' ? '' : '∅')}
              </span>
            ))}
          </pre>
        </section>
      ))}
    </div>
  )
}
