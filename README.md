# CollabDoc

Local-first collaborative document editor. Electron 44.3.0 (Chromium 152, Node 24.20) + React 19 + TypeScript, built with [electron-vite](https://electron-vite.org/).

The same `npm run dev` command works in **WSL2 (WSLg)** and **native Windows**. Install dependencies separately on each OS — `node_modules` is not portable.

## Prerequisites

- Node.js **22.12+** (Node 24 recommended; Electron 44 embeds Node 24.20)
- npm 10+

### WSL (Linux GUI via WSLg)

- Windows 11 or Windows 10 (build 19044+)
- WSL2, not WSL1: `wsl.exe -l -v`
- WSLg enabled (default). `echo $DISPLAY` should print `:0`
- Keep this repo on the **Linux filesystem** (`~/repos/collabdoc`), not `/mnt/c/...`

If GUI apps do not appear, from PowerShell:

```powershell
wsl --update
wsl --shutdown
```

Then reopen the distro.

### Windows

- Node.js installed for Windows (not the WSL binary)
- Run commands from PowerShell, cmd, or Windows Terminal **outside** WSL

## Install

In the environment you will run the app from (WSL **or** Windows):

```bash
npm install
```

Do this again if you switch OS. Electron ships a platform-specific binary; copying `node_modules` between WSL and Windows will fail.

```bash
# after switching OS
rm -rf node_modules
npm install
```

On Windows PowerShell:

```powershell
Remove-Item -Recurse -Force node_modules
npm install
```

## Development

```bash
npm run dev
```

In WSL this automatically:

- passes Chromium `--no-sandbox` (required; the setuid sandbox does not work in WSL)
- uses WSLg (`DISPLAY=:0`) so the window opens on the Windows desktop
- warns if the Electron binary was installed for the other OS

The starter window shows **CollabDoc · WSL** or **CollabDoc · Windows** so you can confirm which host you are on.

### GPU glitches in WSL

WSLg may log `Exiting GPU process due to errors during initialization`. That is Chromium falling back to software rendering; the window should still appear. If it is a black screen instead:

```bash
COLLABDOC_DISABLE_GPU=1 npm run dev
```

### Scripts

| Command             | What it does                          |
| ------------------- | ------------------------------------- |
| `npm run dev`       | Dev server + Electron with HMR        |
| `npm start`         | Preview the production renderer build |
| `npm run typecheck` | Main/preload + renderer TypeScript    |
| `npm run lint`      | ESLint                                |
| `npm run format`    | Prettier                              |

## Build

Build installers on the matching OS:

| Command               | Run on      | Output                                   |
| --------------------- | ----------- | ---------------------------------------- |
| `npm run build:linux` | WSL / Linux | AppImage + deb in `dist/`                |
| `npm run build:win`   | Windows     | NSIS installer + portable exe in `dist/` |
| `npm run build:mac`   | macOS       | dmg                                      |

Windows installers from WSL need Wine and extra electron-builder binaries; prefer `npm run build:win` on Windows.

Unsigned local Windows builds may print a signing warning. That is expected until a cert is configured:

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY="false"
npm run build:win
```

## Layout

```
src/
  main/          Electron main process
  preload/       Context-bridge IPC
  renderer/      React UI (Vite)
scripts/         Dev launcher (WSL / Windows)
electron.vite.config.ts
electron-builder.yml
```

## Debug in VS Code / Cursor

Use **Debug All** in the Run panel (`.vscode/launch.json`). WSL debug sessions set `NO_SANDBOX=1`.
