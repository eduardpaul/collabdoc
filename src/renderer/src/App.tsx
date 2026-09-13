import { useEffect, useRef } from 'react'
import {
  JoinDialog,
  NoticeBar,
  ProfileSetupDialog,
  ShareDialog,
  UnsavedDialog
} from './components/Dialogs'
import { SettingsModal } from './components/SettingsModal'
import { StartScreen } from './screens/StartScreen'
import { Workspace } from './screens/Workspace'
import { AppStateProvider, useAppState } from './state/AppState'
import { useSessionActions } from './state/useSessionActions'
import { currentDocId } from './sync/clients'
import { loadProfile } from './sync/identity'

function AppShell(): React.JSX.Element {
  const { state, dispatch } = useAppState()
  const actions = useSessionActions()
  const resumeRef = useRef(actions.resumeDocument)
  const hydrateRef = useRef(actions.hydratePersist)
  useEffect(() => {
    resumeRef.current = actions.resumeDocument
    hydrateRef.current = actions.hydratePersist
  })

  // A reload (HMR, Ctrl+R) keeps the document alive in the host; re-attach.
  useEffect(() => {
    void hydrateRef.current().then(() => {
      const docId = currentDocId()
      if (docId) {
        void resumeRef.current(docId)
      }
    })
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (state.settingsOpen) {
          dispatch({ type: 'close-settings' })
          return
        }
        if (state.shareOpen) {
          dispatch({ type: 'set-share-open', open: false })
          return
        }
        if (state.joinOpen) {
          dispatch({ type: 'set-join-open', open: false })
          return
        }
        if (state.unsavedIntent) {
          dispatch({ type: 'clear-unsaved' })
          return
        }
        if (state.profileSetupOpen) {
          return
        }
        return
      }

      const mod = event.metaKey || event.ctrlKey
      if (!mod) {
        return
      }
      const key = event.key.toLowerCase()
      if (key === 's') {
        event.preventDefault()
        if (state.session) {
          void (event.shiftKey ? actions.saveDocumentAs() : actions.saveDocument())
        }
        return
      }
      if (key === 'o') {
        event.preventDefault()
        void actions.openDocument()
        return
      }
      if (key === 'n') {
        event.preventDefault()
        actions.newDocument()
        return
      }
      if (event.key === ',') {
        event.preventDefault()
        dispatch({ type: 'open-settings' })
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    actions,
    dispatch,
    state.joinOpen,
    state.session,
    state.settingsOpen,
    state.shareOpen,
    state.unsavedIntent,
    state.profileSetupOpen
  ])

  useEffect(() => {
    void loadProfile().then((profile) => {
      dispatch({ type: 'set-profile', profile })
    })
  }, [dispatch])

  useEffect(() => {
    const stop = window.api?.app?.onCommand?.((command) => {
      if (command === 'new') actions.newDocument()
      if (command === 'open') void actions.openDocument()
      if (command === 'save') void actions.saveDocument()
      if (command === 'save-as') void actions.saveDocumentAs()
      if (command === 'import-markdown') actions.importMarkdown()
      if (command === 'export-markdown') actions.exportMarkdown()
    })
    return () => stop?.()
  }, [actions])

  return (
    <div className="app">
      {state.screen === 'start' ? <StartScreen /> : <Workspace />}
      <SettingsModal />
      <ShareDialog />
      <JoinDialog />
      <UnsavedDialog />
      <ProfileSetupDialog />
      <NoticeBar />
    </div>
  )
}

function App(): React.JSX.Element {
  return (
    <AppStateProvider>
      <AppShell />
    </AppStateProvider>
  )
}

export default App
