import { Extension, type Editor } from '@tiptap/core'
import Mention, { type MentionOptions } from '@tiptap/extension-mention'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion'
import type { RegistryPerson } from '@core/participants'
import { BLOCK_ID_ATTR, MENTION_NODE } from '@shared/constants'
import type { MentionAttrs, MentionState, MentionTarget } from '@shared/types'
import { commitMessageKey } from './loro-collab'

/** The picker's roster: everyone addressable in this document, live. */
export type Roster = () => RegistryPerson[]

export type SendRequest = {
  requestId: string
  blockId: string
  target: MentionTarget
  text: string
}

export type MentionRequestOptions = {
  roster: Roster
  /** Enter on a request paragraph. Return false to refuse (e.g. agent removed). */
  onSend: (request: SendRequest) => boolean
  /** Seconds of idleness after which an *agent* request is sent on its own; 0 = never. */
  autoSendSeconds: () => number
}

// ---- Node -------------------------------------------------------------------

/**
 * The `@` chip. Attrs name the target by id so a rename never breaks an old
 * mention (the label is only a fallback; the live one comes from the roster
 * through `mentionDecorations`). Request state rides on the node too, so it
 * syncs, persists and survives a reload.
 */
export const MentionNode = Mention.extend<MentionOptions>({
  name: MENTION_NODE,
  addAttributes() {
    return {
      kind: { default: 'person', parseHTML: (el) => el.getAttribute('data-kind') ?? 'person' },
      id: { default: '', parseHTML: (el) => el.getAttribute('data-id') ?? '' },
      handle: { default: '', parseHTML: (el) => el.getAttribute('data-handle') ?? '' },
      label: { default: '', parseHTML: (el) => el.getAttribute('data-label') ?? '' },
      requestId: { default: null, rendered: false },
      sentAt: { default: null, rendered: false },
      state: { default: null, rendered: false }
    }
  },
  parseHTML() {
    return [{ tag: `span[data-type="${MENTION_NODE}"]` }]
  },
  renderMarkdown: (node: { attrs?: Record<string, unknown> }) =>
    `@${String(node.attrs?.handle ?? '')}`
})

/** The chip node bound to a live roster for its picker. */
export function mentionNode(roster: Roster): ReturnType<typeof MentionNode.configure> {
  return MentionNode.configure({
    deleteTriggerWithBackspace: true,
    renderText: ({ node }) => `@${String(node.attrs.handle)}`,
    renderHTML: ({ node }) => [
      'span',
      {
        'data-type': MENTION_NODE,
        'data-kind': String(node.attrs.kind),
        'data-id': String(node.attrs.id),
        'data-handle': String(node.attrs.handle),
        'data-label': String(node.attrs.label),
        class: 'mention'
      },
      ['span', { class: 'mention__text' }, `@${String(node.attrs.label || node.attrs.handle)}`]
    ],
    suggestion: {
      char: '@',
      allowSpaces: false,
      // Not in code, not inside a link.
      allow: ({ state, range }) => {
        const $from = state.doc.resolve(range.from)
        if ($from.parent.type.name === 'codeBlock') return false
        const link = state.schema.marks.link
        return !link || !$from.marks().some((mark) => mark.type === link)
      },
      command: ({ editor, range, props }) => {
        const target = props as MentionTarget
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            { type: MENTION_NODE, attrs: target },
            { type: 'text', text: ' ' }
          ])
          .run()
      },
      items: ({ query }) => pickerItems(roster(), query),
      render: () => new MentionPicker()
    }
  })
}

/** Roster entries as picker items, People first then Agents, matching `query`. */
export function pickerItems(people: RegistryPerson[], query: string): RegistryPerson[] {
  const q = query.toLowerCase()
  const match = (p: RegistryPerson): boolean =>
    !q || p.handle.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
  const humans = people.filter((p) => p.role !== 'agent' && match(p))
  const agents = people.filter((p) => p.role === 'agent' && match(p))
  return [...humans, ...agents]
}

export function toTarget(person: RegistryPerson): MentionTarget {
  return {
    kind: person.role === 'agent' ? 'agent' : 'person',
    id: person.id,
    handle: person.handle,
    label: person.name
  }
}

/**
 * The picker: a plain DOM list under the caret, grouped People / Agents with
 * role badges and presence dots. Arrows move, Enter/Tab pick, Escape closes;
 * `@` followed by a space closes it too (the suggestion has no spaces), which
 * leaves a literal `@`.
 */
export class MentionPicker {
  private element = document.createElement('div')
  private items: RegistryPerson[] = []
  private selected = 0
  private command: ((target: MentionTarget) => void) | null = null
  private unmount: (() => void) | null = null

  constructor() {
    this.element.className = 'mention-picker'
    this.element.setAttribute('role', 'listbox')
    this.element.dataset.testid = 'mention-picker'
  }

  onStart(props: SuggestionProps<RegistryPerson, MentionTarget>): void {
    this.update(props)
    this.unmount = props.mount(this.element)
  }

  onUpdate(props: SuggestionProps<RegistryPerson, MentionTarget>): void {
    this.update(props)
  }

  onKeyDown({ event }: SuggestionKeyDownProps): boolean {
    if (event.key === 'ArrowDown') {
      this.select(this.selected + 1)
      return true
    }
    if (event.key === 'ArrowUp') {
      this.select(this.selected - 1)
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      return this.pick(this.selected)
    }
    if (event.key === 'Escape') {
      this.exit()
      return true
    }
    return false
  }

  onExit(): void {
    this.exit()
  }

  private exit(): void {
    this.unmount?.()
    this.unmount = null
    this.element.remove()
  }

  private update(props: SuggestionProps<RegistryPerson, MentionTarget>): void {
    this.items = props.items
    this.command = props.command
    this.selected = Math.min(this.selected, Math.max(0, this.items.length - 1))
    this.render()
  }

  private select(index: number): void {
    if (this.items.length === 0) return
    this.selected = (index + this.items.length) % this.items.length
    this.render()
  }

  private pick(index: number): boolean {
    const item = this.items[index]
    if (!item || !this.command) return false
    this.command(toTarget(item))
    return true
  }

  private render(): void {
    this.element.replaceChildren()
    if (this.items.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'mention-picker__empty'
      empty.textContent = 'No one matches'
      this.element.append(empty)
      return
    }
    let group: 'People' | 'Agents' | null = null
    this.items.forEach((item, index) => {
      const heading = item.role === 'agent' ? 'Agents' : 'People'
      if (heading !== group) {
        group = heading
        const label = document.createElement('div')
        label.className = 'mention-picker__group'
        label.textContent = heading
        this.element.append(label)
      }
      const row = document.createElement('button')
      row.type = 'button'
      row.className = `mention-picker__item ${index === this.selected ? 'is-active' : ''}`
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(index === this.selected))
      row.dataset.handle = item.handle
      const dot = document.createElement('span')
      dot.className = `presence-dot ${item.online ? 'is-online' : ''}`
      dot.style.background = item.color
      const name = document.createElement('strong')
      name.textContent = item.name
      const handle = document.createElement('span')
      handle.className = 'muted'
      handle.textContent = `@${item.handle}`
      row.append(dot, name, handle)
      if (item.role === 'agent') {
        const badge = document.createElement('span')
        badge.className = 'role-badge'
        badge.textContent = 'agent'
        row.append(badge)
      }
      row.addEventListener('mousedown', (event) => {
        event.preventDefault()
        this.pick(index)
      })
      this.element.append(row)
    })
  }
}

// ---- Live rendering ---------------------------------------------------------

const decorationsKey = new PluginKey<DecorationSet>('mentionDecorations')

/**
 * Chips take their colour and label from the roster, so a rename shows
 * everywhere at once and a removed participant greys out (label kept).
 * Request state is exposed for the CSS badge.
 */
export function mentionDecorations(roster: Roster): Plugin<DecorationSet> {
  const build = (doc: PmNode): DecorationSet => {
    const people = new Map(roster().map((p) => [p.id, p]))
    const decorations: Decoration[] = []
    doc.descendants((node, pos) => {
      if (node.type.name !== MENTION_NODE) return true
      const attrs = node.attrs as MentionAttrs
      const person = people.get(attrs.id)
      const attributes: Record<string, string> = {
        class: `mention ${person ? '' : 'is-gone'} ${attrs.state ? `is-${attrs.state}` : ''}`,
        style: `--thread-color: ${person?.color ?? '#8a7d6d'}`,
        'data-live-label': person?.name ?? attrs.label
      }
      if (attrs.state) attributes['data-state'] = attrs.state
      decorations.push(Decoration.node(pos, pos + node.nodeSize, attributes))
      return false
    })
    return DecorationSet.create(doc, decorations)
  }
  return new Plugin<DecorationSet>({
    key: decorationsKey,
    state: {
      init: (_config, state) => build(state.doc),
      apply: (tr, prev, _old, state) => {
        if (tr.getMeta(decorationsKey)) return build(state.doc)
        if (!tr.docChanged) return prev
        // Typing elsewhere just moves the chips along; only a change that
        // touches a chip (insert, delete, state stamp) needs a rebuild.
        return touchesMention(tr, state.doc) ? build(state.doc) : prev.map(tr.mapping, tr.doc)
      }
    },
    props: {
      decorations: (state) => decorationsKey.getState(state)
    }
  })
}

export const MentionDecorations = Extension.create<{ roster: Roster }>({
  name: 'mentionDecorations',
  addOptions() {
    return { roster: () => [] }
  },
  addProseMirrorPlugins() {
    return [mentionDecorations(this.options.roster)]
  }
})

/**
 * Write a request's state onto its chip through the editor, so the view
 * updates (the sync plugin ignores local Loro commits made behind its back).
 * Not an undo step: the undo manager is paused for the transaction. Its own
 * history entry, via the commit cutter's message meta.
 */
export function setChipState(
  editor: Editor,
  undoManager: { pause: () => void; resume: () => void },
  requestId: string,
  state: MentionState
): boolean {
  if (editor.isDestroyed) return false
  const { doc } = editor.state
  let found: { pos: number; node: PmNode } | null = null
  doc.descendants((node, pos) => {
    if (found) return false
    if (node.type.name === MENTION_NODE && node.attrs.requestId === requestId) {
      found = { pos, node }
      return false
    }
    return true
  })
  if (!found) return false
  const { pos, node } = found as { pos: number; node: PmNode }
  if (node.attrs.state === state) return true
  const tr = editor.state.tr
    .setNodeMarkup(pos, undefined, { ...node.attrs, state })
    .setMeta(commitMessageKey, `mention: ${state}`)
  undoManager.pause()
  try {
    editor.view.dispatch(tr)
  } finally {
    undoManager.resume()
  }
  return true
}

function touchesMention(tr: Transaction, doc: PmNode): boolean {
  let hit = false
  for (const map of tr.mapping.maps) {
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      if (hit) return
      doc.nodesBetween(
        Math.max(0, newStart - 1),
        Math.min(doc.content.size, newEnd + 1),
        (node) => {
          if (node.type.name === MENTION_NODE) hit = true
          return !hit
        }
      )
    })
    if (hit) break
  }
  return hit
}

/** Re-read the roster (a rename, someone joining or leaving). */
export function refreshMentions(editor: Editor): void {
  if (editor.isDestroyed) return
  editor.view.dispatch(editor.state.tr.setMeta(decorationsKey, true))
}

// ---- Requests ---------------------------------------------------------------

export type RequestParagraph = {
  pos: number
  node: PmNode
  chipPos: number
  chip: PmNode
  attrs: MentionAttrs
  blockId: string
  text: string
}

/**
 * A request is a paragraph that starts with a chip and says something after
 * it. `pos` is the paragraph's position.
 */
export function requestParagraphAt(state: EditorState, pos: number): RequestParagraph | null {
  const $pos = state.doc.resolve(pos)
  const node = $pos.parent
  if (node.type.name !== 'paragraph') return null
  const chip = node.firstChild
  if (!chip || chip.type.name !== MENTION_NODE) return null
  const blockId = node.attrs?.[BLOCK_ID_ATTR] as unknown
  if (typeof blockId !== 'string' || !blockId) return null
  const text = node.textBetween(chip.nodeSize, node.content.size, ' ').trim()
  if (!text) return null
  const paragraphPos = $pos.before()
  return {
    pos: paragraphPos,
    node,
    chipPos: paragraphPos + 1,
    chip,
    attrs: chip.attrs as MentionAttrs,
    blockId,
    text
  }
}

export function newRequestId(): string {
  return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Enter on a request paragraph sends it: the chip is stamped (`requestId`,
 * `sentAt`, first state) in the same transaction the request goes out in,
 * so Enter again — or a reload — never sends twice. Failed agent runs get
 * Retry by clicking the chip. With idle auto-send on, an untouched agent
 * request goes out on its own; person mentions never do.
 */
export const MentionRequests = Extension.create<MentionRequestOptions>({
  name: 'mentionRequests',
  addOptions() {
    return { roster: () => [], onSend: () => false, autoSendSeconds: () => 0 }
  },
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const { state, view } = this.editor
        const request = requestParagraphAt(state, state.selection.from)
        if (!request || request.attrs.sentAt) return false
        return send(view.state, view.dispatch, request, this.options) !== null
      }
    }
  },
  addProseMirrorPlugins() {
    const options = this.options
    return [
      new Plugin({
        props: {
          handleClickOn: (view, _pos, node, nodePos) => {
            if (node.type.name !== MENTION_NODE) return false
            const attrs = node.attrs as MentionAttrs
            if (attrs.state !== 'failed') return false
            const request = requestParagraphAt(view.state, nodePos + 1)
            if (!request) return false
            return send(view.state, view.dispatch, request, options) !== null
          }
        },
        view: () => {
          let timer: ReturnType<typeof setTimeout> | null = null
          return {
            update: (view, prev) => {
              if (view.state.doc === prev.doc) return
              if (timer) clearTimeout(timer)
              timer = null
              const seconds = options.autoSendSeconds()
              if (seconds <= 0) return
              const request = requestParagraphAt(view.state, view.state.selection.from)
              if (!request || request.attrs.kind !== 'agent' || request.attrs.sentAt) return
              const at = request.pos
              timer = setTimeout(() => {
                const again = requestParagraphAt(view.state, at + 1)
                if (!again || again.attrs.sentAt || again.attrs.kind !== 'agent') return
                send(view.state, view.dispatch, again, options)
              }, seconds * 1000)
            },
            destroy: () => {
              if (timer) clearTimeout(timer)
            }
          }
        }
      })
    ]
  }
})

function send(
  state: EditorState,
  dispatch: (tr: Transaction) => void,
  request: RequestParagraph,
  options: MentionRequestOptions
): string | null {
  const person = options.roster().find((p) => p.id === request.attrs.id)
  const target: MentionTarget = person
    ? toTarget(person)
    : {
        kind: request.attrs.kind,
        id: request.attrs.id,
        handle: request.attrs.handle,
        label: request.attrs.label
      }
  // A removed agent has no one to run it; a person who left still gets it on return.
  if (!person && target.kind === 'agent') return null
  const requestId = newRequestId()
  const accepted = options.onSend({
    requestId,
    blockId: request.blockId,
    target,
    text: request.node.textBetween(0, request.node.content.size, ' ', (leaf) =>
      leaf.type.name === MENTION_NODE ? `@${String(leaf.attrs.handle)}` : ''
    )
  })
  if (!accepted) return null
  const state0: MentionState = target.kind === 'agent' ? 'queued' : 'sent'
  const attrs: MentionAttrs = { ...request.attrs, requestId, sentAt: Date.now(), state: state0 }
  dispatch(state.tr.setNodeMarkup(request.chipPos, undefined, attrs))
  return requestId
}
