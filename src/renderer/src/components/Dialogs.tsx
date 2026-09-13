import { useState } from 'react'
import { hostLabel } from '../lib/host'
import { useAppState } from '../state/AppState'
import { useSessionActions } from '../state/useSessionActions'
import { saveProfile } from '../sync/identity'
import { Button, Field, Modal, TextInput } from './ui'
import { ProfileFields } from './ProfileFields'

export function ShareDialog(): React.JSX.Element | null {
  const { state, dispatch } = useAppState()
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

  return (
    <Modal
      title="Share this document"
      subtitle="Peer-to-peer over a temporary local tunnel. No CollabDoc server."
      onClose={() => dispatch({ type: 'set-share-open', open: false })}
    >
      <p className="lede">
        Anyone with the connection code can join this session from another CollabDoc window. The
        tunnel URL is a placeholder until Localtunnel is wired.
      </p>
      <div className="share-status">
        <span className={`pill ${share.active ? 'pill--live' : ''}`}>
          {share.active ? 'Tunnel live' : 'Tunnel off'}
        </span>
        <span className="muted">Host · {hostLabel()}</span>
      </div>
      {share.active && share.code ? (
        <div className="share-grid">
          <Field label="Connection code">
            <div className="inline-copy">
              <TextInput readOnly value={share.code} />
              <Button onClick={() => void copy(share.code ?? '')}>Copy</Button>
            </div>
          </Field>
          <Field label="Tunnel URL">
            <div className="inline-copy">
              <TextInput readOnly value={share.url ?? ''} />
              <Button onClick={() => void copy(share.url ?? '')}>Copy</Button>
            </div>
          </Field>
        </div>
      ) : (
        <p className="muted">
          Start a tunnel to generate a code others can use on the start screen.
        </p>
      )}
      <div className="modal__actions">
        <Button variant="primary" onClick={() => dispatch({ type: 'toggle-share' })}>
          {share.active ? 'Stop sharing' : 'Start tunnel'}
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
      subtitle="Paste the connection code from the person who started the tunnel."
      onClose={() => dispatch({ type: 'set-join-open', open: false })}
    >
      <Field label="Connection code" hint="Looks like CD-7K4M2Q">
        <TextInput
          autoFocus
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              join()
            }
          }}
          placeholder="CD-······"
        />
      </Field>
      <div className="modal__actions">
        <Button variant="primary" onClick={join}>
          Join
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

export function NoticeBar(): React.JSX.Element | null {
  const { state } = useAppState()
  const actions = useSessionActions()
  const missing = state.missingRecentId
    ? state.recents.find((item) => item.id === state.missingRecentId)
    : undefined
  if (!state.notice && !missing) {
    return null
  }
  return (
    <div className={`notice ${missing ? 'notice--actions' : ''}`} role="status">
      <span>{missing ? `“${missing.title}” was moved or deleted.` : state.notice}</span>
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
