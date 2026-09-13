import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type TextareaHTMLAttributes
} from 'react'
import type { Participant } from './CommentsPanel'
import { TextArea } from './ui'

/**
 * A textarea with the `@` picker from the document (10): typing `@` lists
 * participants, arrows move, Enter/Tab insert `@handle`. Comment bodies are
 * plain text, so the handle is the mention; it renders as a chip in cards.
 */
export const MentionTextArea = forwardRef<
  HTMLTextAreaElement,
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
    participants: Participant[]
    value: string
    onValueChange: (value: string) => void
  }
>(function MentionTextArea({ participants, value, onValueChange, onKeyDown, ...rest }, ref) {
  const inner = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(ref, () => inner.current as HTMLTextAreaElement)
  const [selected, setSelected] = useState(0)
  const [caret, setCaret] = useState(0)

  // The `@word` immediately before the caret, if any.
  const match = useMemo(() => {
    const before = value.slice(0, caret)
    const m = /(^|\s)@([a-z0-9_-]*)$/i.exec(before)
    if (!m) return null
    const query: string = typeof m[2] === 'string' ? m[2] : ''
    return { start: before.length - query.length - 1, query: query.toLowerCase() }
  }, [value, caret])

  const items = useMemo(() => {
    if (!match) return []
    return participants
      .filter(
        (p) =>
          p.handle.toLowerCase().includes(match.query) || p.name.toLowerCase().includes(match.query)
      )
      .slice(0, 8)
  }, [participants, match])

  const pick = (person: Participant): void => {
    if (!match) return
    const next = `${value.slice(0, match.start)}@${person.handle} ${value.slice(caret)}`
    onValueChange(next)
    const pos = match.start + person.handle.length + 2
    requestAnimationFrame(() => {
      inner.current?.setSelectionRange(pos, pos)
      setCaret(pos)
    })
  }

  const handleKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (items.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelected((selected + 1) % items.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelected((selected - 1 + items.length) % items.length)
        return
      }
      if ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey) || event.key === 'Tab') {
        event.preventDefault()
        pick(items[Math.min(selected, items.length - 1)])
        return
      }
    }
    onKeyDown?.(event)
  }

  return (
    <div className="mention-area">
      <TextArea
        ref={inner}
        {...rest}
        value={value}
        onChange={(event) => {
          onValueChange(event.target.value)
          setCaret(event.target.selectionStart ?? event.target.value.length)
          setSelected(0)
        }}
        onKeyUp={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onClick={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={handleKey}
      />
      {items.length ? (
        <div
          className="mention-picker mention-picker--inline"
          role="listbox"
          data-testid="mention-picker"
        >
          {items.map((person, index) => (
            <button
              key={person.id}
              type="button"
              role="option"
              aria-selected={index === selected}
              className={`mention-picker__item ${index === selected ? 'is-active' : ''}`}
              onMouseDown={(event) => {
                event.preventDefault()
                pick(person)
              }}
            >
              <span className="presence-dot is-online" style={{ background: person.color }} />
              <strong>{person.name}</strong>
              <span className="muted">@{person.handle}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
})
