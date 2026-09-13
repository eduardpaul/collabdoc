import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react'

export type IconName =
  | 'file'
  | 'folder'
  | 'plus'
  | 'share'
  | 'settings'
  | 'spark'
  | 'users'
  | 'close'
  | 'bot'
  | 'pen'
  | 'plug'
  | 'check'
  | 'dot'
  | 'chevron'
  | 'home'
  | 'link'
  | 'undo'
  | 'redo'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'code'
  | 'highlight'
  | 'list'
  | 'listOrdered'
  | 'listTodo'
  | 'quote'
  | 'codeBlock'
  | 'alignLeft'
  | 'alignCenter'
  | 'alignRight'
  | 'alignJustify'
  | 'search'
  | 'comment'
  | 'at'
  | 'hr'
  | 'superscript'
  | 'subscript'
  | 'image'
  | 'mermaid'
  | 'infographic'
  | 'history'

const paths: Record<IconName, ReactNode> = {
  file: (
    <>
      <path d="M8 4.5h4.5L16 8v11.5H8z" />
      <path d="M12.5 4.5V8H16" />
    </>
  ),
  folder: (
    <>
      <path d="M4 7.5h5l1.5 2H20v9H4z" />
    </>
  ),
  plus: (
    <>
      <path d="M12 6v12" />
      <path d="M6 12h12" />
    </>
  ),
  share: (
    <>
      <circle cx="18" cy="6" r="2.2" />
      <circle cx="6" cy="12" r="2.2" />
      <circle cx="18" cy="18" r="2.2" />
      <path d="M8 12.8 16 17.2" />
      <path d="M8 11.2 16 6.8" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 4.5v2.2M12 17.3V19.5M4.5 12h2.2M17.3 12H19.5M6.4 6.4l1.6 1.6M16 16l1.6 1.6M17.6 6.4 16 8M8 16l-1.6 1.6" />
    </>
  ),
  spark: (
    <>
      <path d="M12 4.5 13.2 9 17.5 10.2 13.2 11.5 12 16 10.8 11.5 6.5 10.2 10.8 9z" />
      <path d="M17.5 14.5 18 16.2 19.7 16.7 18 17.2 17.5 19 17 17.2 15.3 16.7 17 16.2z" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="9" r="2.4" />
      <path d="M4.8 17c.4-2.4 2.1-3.6 4.2-3.6s3.8 1.2 4.2 3.6" />
      <circle cx="16" cy="9.2" r="2" />
      <path d="M15.2 13.6c1.7.2 3.1 1.3 3.5 3.4" />
    </>
  ),
  close: (
    <>
      <path d="M7 7l10 10" />
      <path d="M17 7 7 17" />
    </>
  ),
  bot: (
    <>
      <rect x="5" y="8" width="14" height="10" rx="3" />
      <path d="M12 8V5.5" />
      <circle cx="12" cy="5.2" r="0.8" />
      <circle cx="9.2" cy="12.5" r="0.8" />
      <circle cx="14.8" cy="12.5" r="0.8" />
    </>
  ),
  pen: (
    <>
      <path d="M14.5 5.5 18.5 9.5 9 19H5v-4z" />
      <path d="M13 7l4 4" />
    </>
  ),
  plug: (
    <>
      <path d="M9 7v4" />
      <path d="M15 7v4" />
      <path d="M8 11h8v3a4 4 0 0 1-8 0z" />
      <path d="M12 18v2.5" />
    </>
  ),
  check: <path d="M6.5 12.5 10 16l7.5-8" />,
  dot: <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  home: (
    <>
      <path d="M4.5 11.5 12 5l7.5 6.5" />
      <path d="M7 10.5V19h10v-8.5" />
    </>
  ),
  link: (
    <>
      <path d="M9.5 14.5 8 16a3.2 3.2 0 0 1-4.5-4.5L5 10" />
      <path d="M14.5 9.5 16 8a3.2 3.2 0 0 1 4.5 4.5L19 14" />
      <path d="M9 15l6-6" />
    </>
  ),
  undo: <path d="M8 8H4v4M4.5 12A8 8 0 1 0 6 6.5" />,
  redo: <path d="M16 8h4v4M19.5 12A8 8 0 1 1 18 6.5" />,
  bold: (
    <>
      <path d="M7 5h6.5a3.5 3.5 0 0 1 0 7H7z" />
      <path d="M7 12h7.5a3.5 3.5 0 0 1 0 7H7z" />
    </>
  ),
  italic: (
    <>
      <path d="M10 5h8" />
      <path d="M6 19h8" />
      <path d="M14 5 10 19" />
    </>
  ),
  underline: (
    <>
      <path d="M7 5v7.5a5 5 0 0 0 10 0V5" />
      <path d="M5 19h14" />
    </>
  ),
  strike: (
    <>
      <path d="M5 12h14" />
      <path d="M16.5 7.5C15.6 6.2 14 5.5 12 5.5 9.5 5.5 7.5 6.8 7.5 8.6c0 3.2 9 1.6 9 5.6 0 2-2.1 3.3-4.5 3.3-2.2 0-4-.9-4.8-2.3" />
    </>
  ),
  code: (
    <>
      <path d="M9 8 5 12l4 4" />
      <path d="M15 8l4 4-4 4" />
    </>
  ),
  highlight: (
    <>
      <path d="M4 20h16" />
      <path d="M7.5 16 16 7.5 19.5 11 11 19.5H7.5z" />
    </>
  ),
  list: (
    <>
      <path d="M9 7h11" />
      <path d="M9 12h11" />
      <path d="M9 17h11" />
      <path d="M5 7h.01" />
      <path d="M5 12h.01" />
      <path d="M5 17h.01" />
    </>
  ),
  listOrdered: (
    <>
      <path d="M10 7h10" />
      <path d="M10 12h10" />
      <path d="M10 17h10" />
      <path d="M4 6h2v4H4" />
      <path d="M4 14h3l-3 4h3" />
    </>
  ),
  listTodo: (
    <>
      <rect x="4" y="5.5" width="4" height="4" rx="0.8" />
      <path d="M11 7.5h9" />
      <rect x="4" y="14.5" width="4" height="4" rx="0.8" />
      <path d="M11 16.5h9" />
    </>
  ),
  quote: (
    <>
      <path d="M7 17h4l2-6V7H7v4h4z" />
      <path d="M15 17h4l2-6V7h-6v4h4z" />
    </>
  ),
  codeBlock: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M9 10 7 12l2 2" />
      <path d="M15 10l2 2-2 2" />
    </>
  ),
  alignLeft: (
    <>
      <path d="M4 6h16" />
      <path d="M4 10h10" />
      <path d="M4 14h16" />
      <path d="M4 18h10" />
    </>
  ),
  alignCenter: (
    <>
      <path d="M4 6h16" />
      <path d="M7 10h10" />
      <path d="M4 14h16" />
      <path d="M7 18h10" />
    </>
  ),
  alignRight: (
    <>
      <path d="M4 6h16" />
      <path d="M10 10h10" />
      <path d="M4 14h16" />
      <path d="M10 18h10" />
    </>
  ),
  alignJustify: (
    <>
      <path d="M4 6h16" />
      <path d="M4 10h16" />
      <path d="M4 14h16" />
      <path d="M4 18h16" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="5.5" />
      <path d="M15.5 15.5 20 20" />
    </>
  ),
  comment: (
    <>
      <path d="M5 6.5h14v9H9.5L5 19z" />
    </>
  ),
  at: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="3" />
      <path d="M15 12v1.6a2 2 0 0 0 3.5 1.2" />
    </>
  ),
  hr: <path d="M4 12h16" />,
  superscript: (
    <>
      <path d="M5 17 11 7" />
      <path d="M5 7l6 10" />
      <path d="M15 7h4l-4 4h4" />
    </>
  ),
  subscript: (
    <>
      <path d="M5 17 11 7" />
      <path d="M5 7l6 10" />
      <path d="M15 14h4l-4 4h4" />
    </>
  ),
  image: (
    <>
      <rect x="4" y="6" width="16" height="12" rx="2" />
      <circle cx="9" cy="10" r="1.4" />
      <path d="M7 16 11 12l3 3 3-4 4 5" />
    </>
  ),
  mermaid: (
    <>
      <path d="M5 16c2-6 4-8 7-8s5 2 7 8" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="16" cy="8" r="1.4" />
    </>
  ),
  infographic: (
    <>
      <path d="M6 17V10" />
      <path d="M12 17V7" />
      <path d="M18 17v-5" />
    </>
  ),
  history: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v5l3 2" />
    </>
  )
}

export function Icon({ name, size = 16 }: { name: IconName; size?: number }): React.JSX.Element {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent'
  size?: 'sm' | 'md'
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  type = 'button',
  children,
  ...props
}: ButtonProps): React.JSX.Element {
  return (
    <button
      type={type}
      className={`btn btn--${variant} btn--${size} ${className}`.trim()}
      {...props}
    >
      {children}
    </button>
  )
}

type FieldProps = {
  label: string
  hint?: string
  children: ReactNode
}

export function Field({ label, hint, children }: FieldProps): React.JSX.Element {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  )
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput(props, ref) {
    return <input ref={ref} {...props} className={`input ${props.className ?? ''}`.trim()} />
  }
)

export const TextArea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function TextArea(props, ref) {
  return (
    <textarea
      ref={ref}
      {...props}
      className={`input input--area ${props.className ?? ''}`.trim()}
    />
  )
})

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return <select {...props} className={`input ${props.className ?? ''}`.trim()} />
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide
}: {
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}): React.JSX.Element {
  return (
    <div className="modal-root" role="presentation" onMouseDown={onClose}>
      <div
        className={`modal ${wide ? 'modal--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <Button variant="ghost" size="sm" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </Button>
        </header>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  )
}

export function StatusDot({
  tone
}: {
  tone: 'idle' | 'live' | 'warn' | 'off' | 'work'
}): React.JSX.Element {
  return <span className={`status-dot status-dot--${tone}`} />
}
