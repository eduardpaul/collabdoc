import Versions from './components/Versions'
import electronLogo from './assets/electron.svg'

function hostLabel(): string {
  if (window.api.isWsl) {
    return 'WSL'
  }
  if (window.api.platform === 'win32') {
    return 'Windows'
  }
  if (window.api.platform === 'darwin') {
    return 'macOS'
  }
  return 'Linux'
}

function App(): React.JSX.Element {
  const ipcHandle = async (): Promise<void> => {
    const res = await window.electron.ipcRenderer.invoke('ping')
    console.log(`IPC reply: ${res}`)
  }

  return (
    <>
      <img alt="logo" className="logo" src={electronLogo} />
      <div className="creator">CollabDoc · {hostLabel()}</div>
      <div className="text">
        Electron + <span className="react">React</span>
        &nbsp;+ <span className="ts">TypeScript</span>
      </div>
      <p className="tip">
        Please try pressing <code>F12</code> to open the devTool
      </p>
      <div className="actions">
        <div className="action">
          <a href="https://electron-vite.org/" target="_blank" rel="noreferrer">
            Documentation
          </a>
        </div>
        <div className="action">
          <a target="_blank" rel="noreferrer" onClick={ipcHandle}>
            Send IPC
          </a>
        </div>
      </div>
      <Versions></Versions>
    </>
  )
}

export default App
