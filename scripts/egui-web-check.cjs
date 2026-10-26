// Drives the egui editor's WebAssembly build in headless Chromium (spec 25):
// the page loads and draws, then typing, Enter, selection, Ctrl+B, an IME
// composition and a paste reach the core. The document is read back through
// the page's WebHandle (`window.collabdoc.markdown()`). Screenshots go to
// the output folder.
//
//   node scripts/egui-web-check.cjs <url> <out-dir>
const { chromium } = require('playwright')

const [url, out] = process.argv.slice(2)

function check(ok, what, detail = '') {
  if (!ok) {
    console.error(`FAIL ${what}${detail ? `: ${detail}` : ''}`)
    process.exitCode = 1
  } else {
    console.log(`ok   ${what}`)
  }
  return ok
}

;(async () => {
  const browser = await chromium.launch({
    // WebGL without a GPU.
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  })
  const page = await browser.newPage({ viewport: { width: 900, height: 640 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

  const started = Date.now()
  await page.goto(url)
  await page.waitForFunction(() => window.collabdoc !== undefined, null, { timeout: 30000 })
  const loadMs = Date.now() - started
  const markdown = () => page.evaluate(() => window.collabdoc.markdown())
  const settle = () => page.waitForTimeout(250)
  await settle()
  check((await markdown()).startsWith('# The editor in egui'), `loads and draws (${loadMs} ms)`)
  await page.screenshot({ path: `${out}/1-loaded.png` })

  // Click at the end of the first paragraph's line, then type.
  await page.mouse.click(860, 92)
  await settle()
  await page.keyboard.press('End')
  await page.keyboard.type(' Typed in the browser.', { delay: 15 })
  await page.keyboard.press('Enter')
  await page.keyboard.type('Second paragraph', { delay: 15 })
  await settle()
  let md = await markdown()
  check(md.includes('draws them. Typed in the browser.'), 'typing reaches the core', md.split('\n')[2])
  check(md.includes('\n\nSecond paragraph\n'), 'Enter splits the block')

  // Shift+Home selects the line; Ctrl+B bolds it.
  await page.keyboard.press('Shift+Home')
  await page.keyboard.press('Control+b')
  await settle()
  md = await markdown()
  check(md.includes('**Second paragraph**'), 'Shift+Home and Ctrl+B')
  const [anchor, head] = await page.evaluate(() => window.collabdoc.selection())
  check(anchor !== head, 'the selection is the core\'s', `${anchor}..${head}`)

  // An IME composition, as an input method sends it: only the commit lands.
  await page.keyboard.press('End')
  await page.keyboard.type(' ')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: 'ご', selectionStart: 1, selectionEnd: 1 })
  await settle()
  check(!(await markdown()).includes('ご'), 'a composition is not in the document yet')
  await cdp.send('Input.insertText', { text: '語' })
  await settle()
  md = await markdown()
  check(md.includes('**Second paragraph** 語') || md.includes('**Second paragraph 語**'), 'the IME commit lands', md.split('\n')[4])
  check(
    await page.evaluate(() => window.collabdoc.preedit() === ''),
    'the composition preview is gone after the commit'
  )

  // Paste: Markdown from the clipboard becomes blocks.
  await page.keyboard.press('Enter')
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.setData('text/plain', '- pasted one\n- pasted two')
    const target = document.activeElement || document
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
  })
  await settle()
  md = await markdown()
  check(md.includes('- pasted one\n- pasted two'), 'pasted Markdown becomes a list')

  await page.screenshot({ path: `${out}/2-edited.png` })
  const panicked = await page.evaluate(() => window.collabdoc.has_panicked())
  check(!panicked, 'no panic', panicked ? await page.evaluate(() => window.collabdoc.panic_message()) : '')
  check(errors.length === 0, 'no console errors', errors.join(' | '))
  console.log(`screenshots in ${out}`)
  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
