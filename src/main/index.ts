import { execFile } from 'child_process'
import { app, Menu, shell, BrowserWindow, ipcMain, type MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { readBytes, saveBytes, type BytesSavePayload } from './documents'
import { applyWslChromiumFlags, isWsl } from './wsl'
import { DocumentRegistry } from '@core/registry'
import { broadcastListing, broadcastState, registerDocumentIpc, sendCommand } from './documents/ipc'
import { DocumentStore } from './persist/store'
import { readProfile, writeProfile } from './profile'

let mainWindow: BrowserWindow | null = null

/** Every open document lives here; renderers, agents and peers attach to it. */
const documents = new DocumentRegistry({
  warn: (message, detail) => console.warn(`[collabdoc] ${message}`, detail ?? '')
})

let persist: DocumentStore | null = null
let quitting = false

function openExternalUrl(url: string): void {
  // Validate URL protocol to prevent arbitrary scheme execution
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      console.warn(`[collabdoc] Blocked opening untrusted protocol: ${parsed.protocol}`)
      return
    }
  } catch {
    return
  }

  if (isWsl()) {
    execFile('explorer.exe', [url])
    return
  }
  void shell.openExternal(url)
}

applyWslChromiumFlags()

function createWindow(): BrowserWindow {
  // Create the browser window with optimized visual, security, and process flags.
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    // Match dark theme background to prevent visual white flashes on launch and resize
    backgroundColor: '#0f0f10',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
      spellcheck: false,
      additionalArguments: [`--is-wsl=${isWsl() ? 'true' : 'false'}`]
    }
  })

  // Prevent flash of unpainted content
  win.once('ready-to-show', () => {
    win.show()
  })

  // Security & Performance: Prevent untrusted in-app navigations
  win.webContents.on('will-navigate', (event, navigationUrl) => {
    const isDevUrl =
      is.dev &&
      process.env['ELECTRON_RENDERER_URL'] &&
      navigationUrl.startsWith(process.env['ELECTRON_RENDERER_URL'])
    const isLocalFile = navigationUrl.startsWith('file:')

    if (!isDevUrl && !isLocalFile) {
      event.preventDefault()
      openExternalUrl(navigationUrl)
    }
  })

  // Deny unexpected window opening and delegate to external browser
  win.webContents.setWindowOpenHandler((details) => {
    openExternalUrl(details.url)
    return { action: 'deny' }
  })

  win.on('close', () => {
    void persist?.flushAll().catch((error) => {
      console.warn('[collabdoc] flush on close failed', error)
    })
  })

  win.on('closed', () => {
    mainWindow = null
  })

  // HMR for renderer based on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

// Ensure single instance lock: prevent duplicate processes, resource waste, and CRDT store corruption
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // Focus existing window when a second instance is launched
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      mainWindow.focus()
    }
  })

  // This method will be called when Electron has finished initialization.
  app.whenReady().then(() => {
    // Set app user model id for windows
    electronApp.setAppUserModelId('com.collabdoc.app')

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    persist = new DocumentStore({
      registry: documents,
      userData: app.getPath('userData'),
      documentsDir: join(app.getPath('documents'), 'CollabDoc'),
      sendState: broadcastState,
      sendListing: broadcastListing
    })
    void persist.init()
    registerDocumentIpc(documents, persist)
    installAppMenu()

    ipcMain.handle('documents:saveBytes', async (event, payload: BytesSavePayload) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) {
        return { ok: false, error: 'No window' }
      }
      return saveBytes(win, payload)
    })
    ipcMain.handle('documents:readBytes', async (_event, filePath: string) => {
      if (typeof filePath !== 'string' || filePath.length === 0) {
        return { ok: false, error: 'Invalid path' }
      }
      return readBytes(filePath)
    })
    ipcMain.handle('profile:get', async () => {
      const profile = await readProfile(app.getPath('userData'))
      return { ok: true, profile }
    })
    ipcMain.handle('profile:save', async (_event, payload: unknown) => {
      const profile = await writeProfile(
        app.getPath('userData'),
        payload as Parameters<typeof writeProfile>[1]
      )
      return { ok: true, profile }
    })
    ipcMain.handle('shell:openExternal', async (_event, url: string) => {
      if (typeof url !== 'string') {
        return { ok: false }
      }
      openExternalUrl(url)
      return { ok: true }
    })

    mainWindow = createWindow()

    app.on('activate', function () {
      // On macOS re-create a window when dock icon is clicked and no windows exist
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow()
      }
    })
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void (persist?.flushAll() ?? Promise.resolve())
      .catch((error) => console.warn('[collabdoc] flush before quit failed', error))
      .finally(() => {
        persist?.dispose()
        documents.closeAll()
        app.exit()
      })
  })

  // Quit when all windows are closed, except on macOS.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}

function installAppMenu(): void {
  const send = (command: string): void => {
    if (mainWindow) sendCommand(mainWindow, command)
  }
  const file: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      { label: 'New', accelerator: 'CmdOrCtrl+N', click: () => send('new') },
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
      { type: 'separator' },
      { label: 'Import Markdown…', click: () => send('import-markdown') },
      { label: 'Export Markdown…', click: () => send('export-markdown') },
      { type: 'separator' },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
      { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('save-as') }
    ]
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      file,
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' }
    ])
  )
}
