import { useState } from 'react'
import { hostLabel } from '../lib/host'
import { useAppState } from '../state/AppState'
import { useSessionActions } from '../state/useSessionActions'
import { saveProfile } from '../sync/identity'
import { Button, Field, Modal, TextInput } from './ui'
import { ProfileFields } from './ProfileFields'

export function ShareDialog(): React.JSX.Element | null {
  const { state, dispatch } = useAppState()
  const actions = useSessionActions()
  const share = state.session?.share
  if (!state.shareOpen || !state.session || !share) {
    return null
  }

  const copy = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      dispatch({ type: 'notice', message: 'Copied' })
    } catch {
      dispatch({ type: 'notice', message: 'Could not copy' })
    }
  }

  const live = share.active && Boolean(share.code) && !share.announcing

  return (
    <Modal
      title="Share this document"
      subtitle="Peer-to-peer over Hyperswarm. No CollabDoc server."
      onClose={() => dispatch({ type: 'set-share-open', open: false })}
    >
      <p className="lede">
        Discovery uses a public DHT; the topic hash is visible to DHT nodes, your document is not.
        Connections are direct and encrypted.
      </p>
      <div className="share-status">
        <span className={`pill ${live ? 'pill--live' : ''}`}>
          {share.announcing ? 'Announcing…' : live ? 'Live' : 'Off'}
        </span>
        <span className="muted">Host · {hostLabel()}</span>
      </div>
      {share.lockedUntil > 0 ? (
        <p className="muted">Too many failed codes. Not accepting new guests for a minute.</p>
      ) : null}
      {live ? (
        <div className="share-grid">
          <Field label="Connection code">
            <div className="inline-copy">
              <TextInput readOnly value={share.code ?? ''} className="share-code" />
              <Button onClick={() => void copy(share.code ?? '')}>Copy</Button>
            </div>
          </Field>
          <Field label="Link">
            <div className="inline-copy">
              <TextInput readOnly value={share.url ?? ''} />
              <Button onClick={() => void copy(share.url ?? '')}>Copy link</Button>
            </div>
          </Field>
          {share.guests.length ? (
            <ul className="guest-list">
              {share.guests.map((guest) => (
                <li key={guest.id}>
                  <span>
                    <strong>{guest.name}</strong>
                    <span className="muted">
                      @{guest.handle} · {guest.connection}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void actions.removeShareGuest(guest.id)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No guests yet.</p>
          )}
        </div>
      ) : (
        <p className="muted">
          Start sharing to mint a code. Untitled documents are saved as a draft first.
        </p>
      )}
      <div className="modal__actions">
        <Button
          variant="primary"
          onClick={() => void (share.active ? actions.stopShare() : actions.startShare())}
        >
          {share.active ? 'Stop sharing' : 'Start sharing'}
        </Button>
        <Button onClick={() => dispatch({ type: 'set-share-open', open: false })}>Done</Button>
      </div>
    </Modal>
  )
}

export function JoinDialog(): React.JSX.Element | null {
  const { state, dispatch } = useAppState()
  const actions = useSessionActions()
  const [code, setCode] = useState('')
  if (!state.joinOpen) {
    return null
  }
  const joining = Boolean(
    state.session?.share.role === 'guest' &&
    state.session.share.status &&
    !state.session.share.hostEnded
  )
  const status = state.session?.share.status ?? ''

  const join = (): void => {
    const next = code.trim()
    if (next.length < 4) {
      dispatch({ type: 'notice', message: 'Enter a connection code from the host.' })
      return
    }
    void actions.joinSession(next)
  }

  return (
    <Modal
      title="Join a session"
      subtitle="Paste the code or collabdoc:// link from the host."
      onClose={() => dispatch({ type: 'set-join-open', open: false })}
    >
      <Field label="Connection code" hint="Looks like K7QX-3M9P-2RHD">
        <TextInput
          autoFocus
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              join()
            }
          }}
          placeholder="K7QX-3M9P-2RHD"
        />
      </Field>
      {status ? <p className="muted">{status}</p> : null}
      {status.includes('network restrictions') ? (
        <p className="muted">
          Could not reach the host directly (network restrictions). Symmetric NATs and some
          corporate networks block hole-punching.
        </p>
      ) : null}
      <div className="modal__actions">
        <Button variant="primary" onClick={join} disabled={joining}>
          {joining ? 'Still trying' : 'Join'}
        </Button>
        <Button onClick={() => dispatch({ type: 'set-join-open', open: false })}>Cancel</Button>
      </div>
    </Modal>
  )
}

export function ProfileSetupDialog(): React.JSX.Element | null {
  const { state, dispatch } = useAppState()
  if (!state.profileSetupOpen) return null

  const finish = (skipped: boolean): void => {
    const profile = {
      ...state.profile,
      name: skipped ? 'You' : state.profile.name.trim() || 'You',
      handle: skipped ? 'you' : state.profile.handle,
      setupComplete: true
    }
    dispatch({ type: 'set-profile', profile })
    void saveProfile(profile)
  }

  return (
    <Modal
      title="What should people call you?"
      subtitle="Shown next to your cursor. Skip to stay “You”."
      onClose={() => finish(true)}
    >
      <div data-testid="profile-setup">
        <ProfileFields
          name={state.profile.name === 'You' ? '' : state.profile.name}
          handle={state.profile.handle}
          color={state.profile.color}
          onChange={(patch) =>
            dispatch({ type: 'set-profile', profile: { ...state.profile, ...patch } })
          }
        />
      </div>
      <div className="modal__actions">
        <Button variant="primary" onClick={() => finish(false)} data-testid="profile-continue">
          Continue
        </Button>
        <Button onClick={() => finish(true)} data-testid="profile-skip">
          Skip
        </Button>
      </div>
    </Modal>
  )
}

export function UnsavedDialog(): React.JSX.Element | null {
  const { state, dispatch } = useAppState()
  const { confirmUnsaved } = useSessionActions()
  if (!state.unsavedIntent) {
    return null
  }
  const draft = Boolean(state.session?.isDraft)

  return (
    <Modal
      title={draft ? 'Discard this draft?' : 'Unsaved changes'}
      subtitle={
        draft
          ? `“${state.session?.title ?? 'Untitled'}” has not been saved to a file. Don't save deletes the draft.`
          : `${state.session?.title ?? 'This document'} has edits that are not on disk yet.`
      }
      onClose={() => dispatch({ type: 'clear-unsaved' })}
    >
      <div className="modal__actions">
        <Button variant="primary" onClick={() => void confirmUnsaved('save')}>
          {draft ? 'Save as…' : 'Save'}
        </Button>
        <Button variant="danger" onClick={() => void confirmUnsaved('discard')}>
          Don&apos;t save
        </Button>
        <Button onClick={() => dispatch({ type: 'clear-unsaved' })}>Cancel</Button>
      </div>
    </Modal>
  )
}

export function BrowserSaveAsDialog(): React.JSX.Element | null {
  const { state, dispatch } = useAppState()
  const actions = useSessionActions()
  if (!state.saveAsOpen || !state.session) return null
  return (
    <Modal
      title="Save As"
      subtitle="Choose an export format. The open document stays a CollabDoc draft."
      onClose={() => dispatch({ type: 'set-save-as-open', open: false })}
    >
      <div className="modal__actions" data-testid="save-as-dialog">
        <Button
          onClick={() => {
            dispatch({ type: 'set-save-as-open', open: false })
            actions.exportMarkdown()
          }}
        >
          Markdown
        </Button>
        <Button
          data-testid="save-as-docx"
          onClick={() => {
            dispatch({ type: 'set-save-as-open', open: false })
            actions.exportDocx()
          }}
        >
          Word (.docx)
        </Button>
        <Button onClick={() => dispatch({ type: 'set-save-as-open', open: false })}>Cancel</Button>
      </div>
    </Modal>
  )
}

export function NoticeBar(): React.JSX.Element | null {
  const { state, dispatch } = useAppState()
  const actions = useSessionActions()
  const missing = state.missingRecentId
    ? state.recents.find((item) => item.id === state.missingRecentId)
    : undefined
  const warnings = state.noticeWarnings
  if (!state.notice && !missing) {
    return null
  }
  return (
    <div
      className={`notice ${missing || state.noticeCancel || warnings ? 'notice--actions' : ''}`}
      role="status"
    >
      <span>{missing ? `“${missing.title}” was moved or deleted.` : state.notice}</span>
      {state.noticeCancel ? (
        <span className="notice__actions">
          <Button
            size="sm"
            data-testid="docx-export-cancel-progress"
            onClick={() => state.noticeCancel?.()}
          >
            Cancel
          </Button>
        </span>
      ) : null}
      {warnings?.length ? (
        <ul className="warning-list">
          {warnings.map((warning, index) => (
            <li key={`${warning.code}-${index}`}>
              <button
                type="button"
                className="warning-list__btn"
                onClick={() => {
                  if (warning.blockId) {
                    window.dispatchEvent(
                      new CustomEvent('collabdoc:focus-block', { detail: warning.blockId })
                    )
                  }
                  dispatch({ type: 'notice', message: null })
                }}
              >
                {warning.message}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {missing ? (
        <span className="notice__actions">
          <Button size="sm" onClick={() => void actions.locateRecent(missing.id)}>
            Locate…
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void actions.removeRecent(missing.id)}>
            Remove from recents
          </Button>
        </span>
      ) : null}
    </div>
  )
}
