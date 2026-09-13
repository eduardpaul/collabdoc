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

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return <input {...props} className={`input ${props.className ?? ''}`.trim()} />
}

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
