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
| `npm test`          | Vitest (unit + main-process tests)    |
| `npm run test:e2e`  | Playwright, browser build             |

### Agents on your own CLI

Personas run on a CLI agent you already have installed and signed in — Claude Code, grok, Antigravity (`agy`), Gemini CLI or Codex — through the document's own MCP server; no API key is entered in CollabDoc. Open **Settings → Backends**, click **Detect**, then invite an agent in a document and ask it to draft or review. Every edit is attributed to the persona, not to the CLI.

Codex requires CLI 0.159.2 or newer (`npm install -g @openai/codex`, then `codex login`). Runs use the existing sign-in with an ephemeral session, a read-only filesystem sandbox, and only the MCP servers selected in CollabDoc. Codex's user config is ignored for persona runs.

Your interactive CLI session can join too: keep the **Document MCP server** running (same tab), paste the **setup command** into your CLI, and approve the client the first time it calls in. For Codex, launch your interactive session in the same terminal after pasting setup; the bearer token is read from `COLLABDOC_MCP_TOKEN` and must be set again in a new terminal. Knowledge sources (Microsoft Learn, a read-only folder, any MCP server) live under **Settings → Sources** and are attached per agent.

Opt-in checks against the real binaries:

```bash
# unit-level, each CLI drives a document as a persona
COLLABDOC_REAL_CLI=claude-code,codex,grok,antigravity npx vitest run real-cli
# the whole flow in the built app
npx electron-vite build && COLLABDOC_ELECTRON_E2E=1 npx playwright test e2e/electron-agent.spec.ts
```

To exercise the Electron UI with Codex explicitly:

```bash
COLLABDOC_ELECTRON_E2E=1 COLLABDOC_ELECTRON_BACKEND=codex npx playwright test e2e/electron-agent.spec.ts
```

`COLLABDOC_USER_DATA=<dir>` points the app at a separate profile (tests and side-by-side setups).

## Build

Build installers on the matching OS:

| Command               | Run on      | Output                                   |
| --------------------- | ----------- | ---------------------------------------- |
| `npm run build:linux` | WSL / Linux | AppImage + deb in `dist/`                |
| `npm run build:win`   | Windows     | NSIS installer + portable exe in `dist/` |
| `npm run build:mac`   | macOS       | dmg                                      |

Windows installers from WSL need Wine (`sudo apt install wine`). `npm run build:win` disables V8 bytecode in that case — bytecode compiled on Linux will not load in Windows Electron. Prefer native Windows for the fastest NSIS build.

Unsigned local Windows builds may print a signing warning. That is expected until a cert is configured:

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY="false"
npm run build:win
```

## Rust build (preview)

The Electron app is being migrated to one native Rust binary: the document core on Loro's Rust crate and a GPUI editor, no webview. Plan and status: [specs/23-rust-gpui-migration.md](specs/23-rust-gpui-migration.md). Files are shared: the Rust editor opens and saves the same `.collabdoc` files.

```bash
# Linux build dependencies (Ubuntu/Debian; WSL included)
sudo apt install libxkbcommon-dev libxkbcommon-x11-dev libwayland-dev libx11-xcb-dev \
  libfontconfig-dev libfreetype-dev libvulkan-dev mesa-vulkan-drivers

cargo run -p collabdoc-gpui -- notes.collabdoc   # open or create a document
cargo test                                        # core, cross-language and headless UI tests
cargo build --release -p collabdoc-gpui           # target/release/collabdoc
```

In the editor, **Ctrl+Shift+N** opens a second participant window synced through Loro. Each window has its own undo history. Other shortcuts: Ctrl+B/I/U, Ctrl+Shift+X (strike), Ctrl+E (code), Ctrl+Alt+0–3 (paragraph, headings), Ctrl+Alt+C (code block), Ctrl+S.

`scripts/gpui-smoke.sh` drives the real binary on a virtual display (Xvfb + xdotool) and saves screenshots. `COLLABDOC_TS_COMPAT=1 cargo test -p collabdoc-core --test ts_compat` also checks that the TypeScript core reads what the Rust editor writes (needs Bun and `loro-crdt` installed).

### Flutter front end (experiment)

Branch `flutter` also has a Flutter UI over the same Rust core, for comparison: [specs/24-flutter-ui-experiment.md](specs/24-flutter-ui-experiment.md).

```bash
sudo apt install ninja-build libgtk-3-dev          # plus Flutter 3.47+ on PATH
cd flutter_app
flutter run -d linux -a notes.collabdoc            # CMake builds crates/collabdoc-ffi with cargo
cargo build -p collabdoc-ffi && COLLABDOC_FFI_LIB=$PWD/../target/debug/libcollabdoc_ffi.so flutter test
```

`scripts/flutter-smoke.sh` drives the built app on a virtual display and saves screenshots; `scripts/flutter-figures.sh` does the same for figures, images, hard breaks and mentions, and `scripts/flutter-history.sh` for the History tab, checkpoints and restore; `scripts/flutter-crash.sh` kills it in the middle of typing and checks nothing is lost. `scripts/flutter-onefile.sh` builds the release app as one executable (`dist/collabdoc-linux-x86_64`, about 11 MB) with `crates/collabdoc-launcher`.

On Windows (Flutter 3.47+, Rust with the MSVC toolchain, Visual Studio 2022 C++ tools, Developer Mode on), from a terminal in the repo:

```bat
scripts\flutter-windows.cmd doctor            :: checks the tools
scripts\flutter-windows.cmd run notes.collabdoc
scripts\flutter-windows.cmd test              :: Rust tests, then the Flutter tests
scripts\flutter-windows.cmd build             :: flutter_app\build\windows\x64\runner\Release\
scripts\flutter-windows.cmd onefile           :: dist\collabdoc-windows-x86_64.exe
```

The Windows build compiles `collabdoc_ffi.dll` with cargo and puts it next to `collabdoc.exe`. Copy and paste there are plain text for now (rich HTML clipboard is Linux-only), and the renderer setting is Linux-only. The Rust bridge cross-compiles for Windows here, but the Flutter build has not been run on a Windows machine yet.

## Layout

```
src/
  main/          Electron main process
  preload/       Context-bridge IPC
  renderer/      React UI (Vite)
crates/
  collabdoc-core/  Rust document core (Loro), toolkit-independent editing
  collabdoc-gpui/  Rust desktop editor (GPUI), the `collabdoc` binary
  collabdoc-ffi/   C ABI over the core for the Flutter front end
  collabdoc-launcher/  Packs the Flutter build into one self-unpacking executable
flutter_app/     Flutter desktop editor over collabdoc-ffi (experiment)
scripts/         Dev launcher (WSL / Windows), GPUI and Flutter smoke tests
electron.vite.config.ts
electron-builder.yml
```

## Debug in VS Code / Cursor

Use **Debug All** in the Run panel (`.vscode/launch.json`). WSL debug sessions set `NO_SANDBOX=1`.
