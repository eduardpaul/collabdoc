import { useState } from 'react'
import { hostLabel } from '../lib/host'
import { useAppState } from '../state/AppState'
import { useSessionActions } from '../state/useSessionActions'
import { Button, Field, Modal, TextInput } from './ui'

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
    dispatch({ type: 'join-session', code: next })
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

export function UnsavedDialog(): React.JSX.Element | null {
  const { state, dispatch } = useAppState()
  const { confirmUnsaved } = useSessionActions()
  if (!state.unsavedIntent) {
    return null
  }

  return (
    <Modal
      title="Unsaved changes"
      subtitle={`${state.session?.title ?? 'This document'} has edits that are not on disk yet.`}
      onClose={() => dispatch({ type: 'clear-unsaved' })}
    >
      <div className="modal__actions">
        <Button variant="primary" onClick={() => void confirmUnsaved('save')}>
          Save
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
  if (!state.notice) {
    return null
  }
  return (
    <div className="notice" role="status">
      {state.notice}
    </div>
  )
}
