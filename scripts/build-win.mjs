#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const extra = process.argv.slice(2)
const onWindows = process.platform === 'win32'

function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      cwd: root,
      env: {
        ...process.env,
        ...extraEnv,
        CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? 'false'
      },
      shell: onWindows,
      windowsHide: false
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal)
        return
      }
      if (code) {
        reject(new Error(`${command} ${args.join(' ')} exited ${code}`))
        return
      }
      resolve()
    })
  })
}

if (!onWindows) {
  console.warn(
    '\n[collabdoc] Building a Windows package from Linux. V8 bytecode is disabled — it is not portable across OS.\n'
  )
}

const npm = onWindows ? 'npm.cmd' : 'npm'
const builder = join(root, 'node_modules', '.bin', onWindows ? 'electron-builder.cmd' : 'electron-builder')

await run(npm, ['run', 'build'], { COLLABDOC_PACK_OS: 'win32' })
await run(builder, ['--win', '--x64', '--publish', 'never', ...extra])
