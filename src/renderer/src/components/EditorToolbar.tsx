import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { HEADING_LEVELS } from '../editor/constants'
import { figureHost } from '../editor/figure-host'
import { Button, Icon, type IconName } from './ui'

const HIGHLIGHTS = [
  { color: '#fef08a', label: 'Yellow' },
  { color: '#bbf7d0', label: 'Green' },
  { color: '#bfdbfe', label: 'Blue' },
  { color: '#fbcfe8', label: 'Pink' },
  { color: '#fecaca', label: 'Red' },
  { color: '#e9d5ff', label: 'Purple' }
]

type BlockValue =
  'paragraph' | 'heading1' | 'heading2' | 'heading3' | 'heading4' | 'blockquote' | 'codeBlock'

export function EditorToolbar({
  editor,
  searchOpen,
  onToggleSearch,
  attribution,
  onToggleAttribution,
  onComment
}: {
  editor: Editor
  searchOpen: boolean
  onToggleSearch: () => void
  attribution?: boolean
  onToggleAttribution?: () => void
  onComment?: () => void
}): React.JSX.Element {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      underline: current.isActive('underline'),
      strike: current.isActive('strike'),
      code: current.isActive('code'),
      highlight: current.isActive('highlight'),
      highlightColor: current.getAttributes('highlight').color as string | undefined,
      link: current.isActive('link'),
      href: (current.getAttributes('link').href as string | undefined) ?? '',
      superscript: current.isActive('superscript'),
      subscript: current.isActive('subscript'),
      blockquote: current.isActive('blockquote'),
      codeBlock: current.isActive('codeBlock'),
      bulletList: current.isActive('bulletList'),
      orderedList: current.isActive('orderedList'),
      taskList: current.isActive('taskList'),
      heading: current.getAttributes('heading').level as number | undefined,
      alignLeft: current.isActive({ textAlign: 'left' }),
      alignCenter: current.isActive({ textAlign: 'center' }),
      alignRight: current.isActive({ textAlign: 'right' }),
      alignJustify: current.isActive({ textAlign: 'justify' }),
      canUndo: current.can().undo(),
      canRedo: current.can().redo()
    })
  })

  const blockValue: BlockValue = state.codeBlock
    ? 'codeBlock'
    : state.blockquote
      ? 'blockquote'
      : state.heading
        ? (`heading${state.heading}` as BlockValue)
        : 'paragraph'

  const setBlock = (value: string): void => {
    const chain = editor.chain().focus()
    if (value === 'paragraph') {
      chain.setParagraph().run()
      return
    }
    if (value === 'blockquote') {
      chain.toggleBlockquote().run()
      return
    }
    if (value === 'codeBlock') {
      chain.toggleCodeBlock().run()
      return
    }
    const level = Number(value.replace('heading', '')) as (typeof HEADING_LEVELS)[number]
    chain.toggleHeading({ level }).run()
  }

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <ToolButton
        label="Undo"
        icon="undo"
        disabled={!state.canUndo}
        onClick={() => editor.chain().focus().undo().run()}
      />
      <ToolButton
        label="Redo"
        icon="redo"
        disabled={!state.canRedo}
        onClick={() => editor.chain().focus().redo().run()}
      />
      <span className="toolbar-sep" role="separator" />
      <label className="toolbar-select">
        <span className="sr-only">Block type</span>
        <select
          aria-label="Block type"
          value={blockValue}
          onChange={(event) => setBlock(event.target.value)}
        >
          <option value="paragraph">Paragraph</option>
          {HEADING_LEVELS.map((level) => (
            <option key={level} value={`heading${level}`}>
              Heading {level}
            </option>
          ))}
          <option value="blockquote">Quote</option>
          <option value="codeBlock">Code</option>
        </select>
      </label>
      <ToolButton
        label="Divider"
        icon="hr"
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
      />
      <span className="toolbar-sep" role="separator" />
      <ToolButton
        label="Bold"
        icon="bold"
        active={state.bold}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <ToolButton
        label="Italic"
        icon="italic"
        active={state.italic}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <ToolButton
        label="Underline"
        icon="underline"
        active={state.underline}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      />
      <ToolButton
        label="Strikethrough"
        icon="strike"
        active={state.strike}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      />
      <ToolButton
        label="Inline code"
        icon="code"
        active={state.code}
        onClick={() => editor.chain().focus().toggleCode().run()}
      />
      <HighlightMenu editor={editor} active={state.highlight} color={state.highlightColor} />
      <LinkMenu editor={editor} active={state.link} href={state.href} />
      <ToolButton
        label="Superscript"
        icon="superscript"
        active={state.superscript}
        onClick={() => editor.chain().focus().toggleSuperscript().run()}
      />
      <ToolButton
        label="Subscript"
        icon="subscript"
        active={state.subscript}
        onClick={() => editor.chain().focus().toggleSubscript().run()}
      />
      <span className="toolbar-sep" role="separator" />
      <ToolButton
        label="Bullet list"
        icon="list"
        active={state.bulletList}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      />
      <ToolButton
        label="Ordered list"
        icon="listOrdered"
        active={state.orderedList}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      />
      <ToolButton
        label="Task list"
        icon="listTodo"
        active={state.taskList}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
      />
      <span className="toolbar-sep" role="separator" />
      <ToolButton
        label="Align left"
        icon="alignLeft"
        active={state.alignLeft}
        onClick={() => editor.chain().focus().setTextAlign('left').run()}
      />
      <ToolButton
        label="Align center"
        icon="alignCenter"
        active={state.alignCenter}
        onClick={() => editor.chain().focus().setTextAlign('center').run()}
      />
      <ToolButton
        label="Align right"
        icon="alignRight"
        active={state.alignRight}
        onClick={() => editor.chain().focus().setTextAlign('right').run()}
      />
      <ToolButton
        label="Justify"
        icon="alignJustify"
        active={state.alignJustify}
        onClick={() => editor.chain().focus().setTextAlign('justify').run()}
      />
      <span className="toolbar-sep" role="separator" />
      <InsertMenu editor={editor} />
      <span className="toolbar-sep" role="separator" />
      <ToolButton
        label="Find and replace"
        icon="search"
        active={searchOpen}
        onClick={onToggleSearch}
      />
      {onToggleAttribution ? (
        <ToolButton
          label="Show last author"
          icon="users"
          active={attribution}
          onClick={onToggleAttribution}
        />
      ) : null}
      <ToolButton label="Mention" icon="at" disabled onClick={() => undefined} />
      <ToolButton
        label="Comment"
        icon="comment"
        disabled={!onComment}
        onClick={() => onComment?.()}
      />
    </div>
  )
}

function ToolButton({
  label,
  icon,
  active,
  disabled,
  onClick
}: {
  label: string
  icon: IconName
  active?: boolean
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={active ? 'is-on' : ''}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
    </Button>
  )
}

function InsertMenu({ editor }: { editor: Editor }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useDismiss(open, root, () => setOpen(false))

  return (
    <div className="toolbar-menu" ref={root}>
      <Button
        size="sm"
        variant="ghost"
        aria-label="Insert"
        aria-expanded={open}
        className={open ? 'is-on' : ''}
        onClick={() => setOpen((value) => !value)}
      >
        Insert
        <Icon name="chevron" />
      </Button>
      {open ? (
        <div className="toolbar-popover" role="menu">
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setOpen(false)
              figureHost.onPickImage()
            }}
          >
            <Icon name="image" /> Image
          </button>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setOpen(false)
              editor.chain().focus().setMermaidFigure().run()
            }}
          >
            <Icon name="mermaid" /> Mermaid diagram
          </button>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setOpen(false)
              editor.chain().focus().setInfographicFigure().run()
            }}
          >
            <Icon name="infographic" /> Infographic
          </button>
        </div>
      ) : null}
    </div>
  )
}

function HighlightMenu({
  editor,
  active,
  color
}: {
  editor: Editor
  active: boolean
  color?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useDismiss(open, root, () => setOpen(false))

  return (
    <div className="toolbar-menu" ref={root}>
      <Button
        size="sm"
        variant="ghost"
        aria-label="Highlight"
        title="Highlight"
        aria-pressed={active}
        aria-expanded={open}
        className={active || open ? 'is-on' : ''}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="highlight-swatch" style={{ background: color ?? '#fef08a' }}>
          <Icon name="highlight" />
        </span>
      </Button>
      {open ? (
        <div className="toolbar-popover" role="menu">
          <div className="swatch-row">
            {HIGHLIGHTS.map((item) => (
              <button
                key={item.color}
                type="button"
                className={`swatch${color === item.color ? ' is-on' : ''}`}
                style={{ background: item.color }}
                aria-label={item.label}
                onClick={() => {
                  editor.chain().focus().toggleHighlight({ color: item.color }).run()
                  setOpen(false)
                }}
              />
            ))}
            <button
              type="button"
              className="swatch swatch-clear"
              aria-label="Remove highlight"
              onClick={() => {
                editor.chain().focus().unsetHighlight().run()
                setOpen(false)
              }}
            >
              ×
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function LinkMenu({
  editor,
  active,
  href
}: {
  editor: Editor
  active: boolean
  href: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(href)
  const root = useRef<HTMLDivElement>(null)

  useDismiss(open, root, () => setOpen(false))

  const apply = (): void => {
    const url = value.trim()
    if (!url) {
      editor.chain().focus().unsetLink().run()
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
    }
    setOpen(false)
  }

  return (
    <div className="toolbar-menu" ref={root}>
      <Button
        size="sm"
        variant="ghost"
        aria-label="Link"
        title="Link"
        aria-pressed={active}
        aria-expanded={open}
        className={active || open ? 'is-on' : ''}
        onClick={() => {
          setValue(href || 'https://')
          setOpen((current) => !current)
        }}
      >
        <Icon name="link" />
      </Button>
      {open ? (
        <div className="toolbar-popover link-popover">
          <input
            autoFocus
            className="input"
            value={value}
            aria-label="Link URL"
            onChange={(event) => setValue(event.target.value)}
            placeholder="https://"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                apply()
              }
              if (event.key === 'Escape') {
                setOpen(false)
              }
            }}
          />
          <Button size="sm" onClick={apply}>
            Apply
          </Button>
          {active ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                editor.chain().focus().unsetLink().run()
                setOpen(false)
              }}
            >
              Remove
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function useDismiss(
  open: boolean,
  root: { current: HTMLElement | null },
  onClose: () => void
): void {
  useEffect(() => {
    if (!open) {
      return
    }
    const onPointer = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) {
        onClose()
      }
    }
    window.addEventListener('pointerdown', onPointer)
    return () => window.removeEventListener('pointerdown', onPointer)
  }, [open, onClose, root])
}
