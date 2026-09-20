#!/usr/bin/env node

import { createRequire } from 'node:module'
import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { chromium } from '@playwright/test'

const require = createRequire(import.meta.url)

function parseArguments(argv) {
  const result = { input: null, outputDir: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--input') result.input = argv[++index]
    else if (arg === '--output-dir') result.outputDir = argv[++index]
    else if (arg === '--help' || arg === '-h') result.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!result.help && (!result.input || !result.outputDir)) {
    throw new Error('--input and --output-dir are required.')
  }
  return result
}

function docxPreviewScript() {
  return require.resolve('docx-preview')
}

function jsZipBrowserScript() {
  return path.resolve(path.dirname(require.resolve('jszip')), '..', 'dist', 'jszip.min.js')
}

export async function renderDocxPreview({ input, outputDir }) {
  const inputPath = path.resolve(input)
  const destination = path.resolve(outputDir)
  const bytes = await readFile(inputPath)
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })

  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.setContent(`<!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            html, body { margin: 0; min-height: 100%; background: #e5e7eb; }
            body { padding: 24px; box-sizing: border-box; }
            .docx-wrapper { background: transparent !important; padding: 0 !important; }
            section.docx { margin: 0 auto 24px !important; box-shadow: 0 2px 10px rgba(15, 23, 42, .20); }
          </style>
        </head>
        <body><main id="document"></main></body>
      </html>`)
    await page.addScriptTag({ path: jsZipBrowserScript() })
    await page.addScriptTag({ path: docxPreviewScript() })
    const base64 = bytes.toString('base64')
    await page.evaluate(async (encoded) => {
      const binary = atob(encoded)
      const data = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) data[index] = binary.charCodeAt(index)
      await window.docx.renderAsync(data, document.getElementById('document'), null, {
        breakPages: true,
        experimental: true,
        ignoreHeight: false,
        ignoreLastRenderedPageBreak: false,
        ignoreWidth: false,
        renderFootnotes: true,
        renderHeaders: true,
        renderFooters: true,
        useBase64URL: true
      })
    }, base64)

    const sections = await page.locator('section.docx').all()
    if (sections.length === 0) throw new Error('docx-preview did not render any document sections.')
    const files = []
    let pageNumber = 0
    for (const section of sections) {
      const box = await section.boundingBox()
      if (!box) continue
      const pageHeight = box.width * (297 / 210)
      const slices = Math.max(1, Math.ceil(box.height / pageHeight))
      for (let slice = 0; slice < slices; slice += 1) {
        pageNumber += 1
        const height = Math.min(pageHeight, box.height - slice * pageHeight)
        const file = path.join(destination, `page-${pageNumber}.png`)
        await page.screenshot({
          path: file,
          type: 'png',
          clip: {
            x: box.x,
            y: box.y + slice * pageHeight,
            width: box.width,
            height
          }
        })
        files.push(file)
      }
    }
    const summary = await page.evaluate(() => ({
      headingStyles: document.querySelectorAll('[class*="heading"]').length,
      images: document.images.length,
      listStyles: document.querySelectorAll('[class*="list"]').length,
      tables: document.querySelectorAll('table').length,
      textLength: document.getElementById('document')?.innerText.length ?? 0
    }))
    return { files, summary }
  } finally {
    await browser.close()
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(
      'Usage: node scripts/docx-preview.mjs --input file.docx --output-dir directory\n'
    )
    return
  }
  const result = await renderDocxPreview(args)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
if (isEntry) {
  await main()
}
