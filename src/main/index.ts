import { execFile } from 'child_process'
import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  openDocument,
  readBytes,
  readDocument,
  saveBytes,
  saveDocument,
  type BytesSavePayload,
  type DocumentSavePayload
} from './documents'
import { applyWslChromiumFlags, isWsl } from './wsl'

let mainWindow: BrowserWindow | null = null

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

    ipcMain.handle('documents:open', async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) {
        return { ok: false, error: 'No window' }
      }
      return openDocument(win)
    })
    ipcMain.handle('documents:read', async (_event, filePath: string) => {
      if (typeof filePath !== 'string' || filePath.length === 0) {
        return { ok: false, error: 'Invalid path' }
      }
      return readDocument(filePath)
    })
    ipcMain.handle('documents:save', async (event, payload: DocumentSavePayload) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) {
        return { ok: false, error: 'No window' }
      }
      return saveDocument(win, payload)
    })
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

  // Quit when all windows are closed, except on macOS.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
