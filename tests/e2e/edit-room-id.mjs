// E2E: initiator edits the random room code on the WaitingScreen.
// Verifies that after edit:
//   - the new code is shown
//   - the OLD code is no longer joinable (room-not-found)
//   - the NEW code IS joinable and the call completes
//
// Prereqs:
//   - Dev server on http://localhost:3000 (`npm run dev`)
//   - Chromium installed (`npx playwright install chromium`)
import { chromium } from 'playwright'

const TEST_URL = process.env.TEST_URL || 'http://localhost:3000/'
const ORIGIN = new URL(TEST_URL).origin
const NEW_CODE = 'EDIT2026'  // 8 chars, A-Z/0-9
const log = (tag, msg) => console.log(`[${tag}] ${msg}`)

async function readRoomCode(page) {
  return page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    for (const b of btns) {
      const t = b.textContent?.trim() ?? ''
      if (/^[A-Z0-9]{8}$/.test(t)) return t
    }
    return null
  })
}

async function run() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  })

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  await ctxA.grantPermissions(['microphone', 'camera'], { origin: ORIGIN })
  await ctxB.grantPermissions(['microphone', 'camera'], { origin: ORIGIN })

  const pageA = await ctxA.newPage()
  const pageB = await ctxB.newPage()
  pageA.on('console', m => { if (m.type() !== 'info') log('A', `${m.type()} ${m.text()}`) })
  pageB.on('console', m => { if (m.type() !== 'info') log('B', `${m.type()} ${m.text()}`) })

  log('main', `loading ${TEST_URL}`)
  await Promise.all([pageA.goto(TEST_URL), pageB.goto(TEST_URL)])
  await pageA.waitForFunction(
    () => [...document.querySelectorAll('button')].find(b => b.textContent?.includes('发起邀请') && !b.disabled),
    { timeout: 10_000 },
  )

  log('A', 'click 发起邀请')
  await pageA.getByRole('button', { name: '发起邀请' }).click()
  await pageA.getByText('等待对方加入').waitFor({ state: 'visible', timeout: 5000 })
  const oldCode = await readRoomCode(pageA)
  log('A', `original room code = ${oldCode}`)
  if (!oldCode) throw new Error('no original code')

  // Enter edit mode and set NEW_CODE
  log('A', 'click 编辑房间码')
  await pageA.getByRole('button', { name: '编辑房间码' }).click()
  await pageA.locator('input').first().waitFor({ state: 'visible', timeout: 3000 })
  await pageA.locator('input').first().fill(NEW_CODE)
  log('A', `click 保存 (new code = ${NEW_CODE})`)
  await pageA.getByRole('button', { name: '保存' }).click()

  // The button label should now be the new code.
  await pageA.waitForFunction(
    (code) => {
      const btns = [...document.querySelectorAll('button')]
      return btns.some(b => b.textContent?.trim() === code)
    },
    NEW_CODE,
    { timeout: 3000 },
  )
  log('A', 'WaitingScreen now shows new code')

  // B: lookup the OLD code → should be not-found.
  await pageB.getByRole('button', { name: '我有房间码，加入通话' }).click()
  await pageB.getByPlaceholder('输入 8 位房间码').fill(oldCode)
  await pageB.getByRole('button', { name: '查询' }).click()
  await pageB.getByText('房间不存在或已过期', { exact: false }).waitFor({ state: 'visible', timeout: 8000 })
  log('B-PASS', 'old code is rejected as not-found')

  // B: lookup the NEW code → should resolve to the symbol screen.
  await pageB.getByPlaceholder('输入 8 位房间码').fill('')
  await pageB.getByPlaceholder('输入 8 位房间码').fill(NEW_CODE)
  await pageB.getByRole('button', { name: '查询' }).click()
  await pageB.getByText('对方的暗语标志').waitFor({ state: 'visible', timeout: 8000 })
  log('B', 'new code resolves to the symbol view')

  // Complete the call — proves the rebuilt room actually carries the same crypto identity.
  await pageB.getByRole('button', { name: '仅音频' }).click()
  await Promise.all([
    pageA.getByText('核对身份与密钥').waitFor({ state: 'visible', timeout: 10_000 }),
    pageB.getByText('核对身份与密钥').waitFor({ state: 'visible', timeout: 10_000 }),
  ])
  await pageA.getByRole('button', { name: /指纹一致/ }).click()
  await pageB.getByRole('button', { name: /指纹一致/ }).click()
  const inCall = () => document.body.innerText.includes('语音通话中')
  await Promise.all([
    pageA.waitForFunction(inCall, { timeout: 20_000 }),
    pageB.waitForFunction(inCall, { timeout: 20_000 }),
  ])
  log('PASS', 'edited room code accepted; full audio call established')

  await pageA.getByTitle('挂断').click()
  await pageA.getByText('使用流程').waitFor({ state: 'visible', timeout: 5000 })
  await pageB.getByText('使用流程').waitFor({ state: 'visible', timeout: 5000 })
  log('PASS', 'both peers home after hangup')

  await browser.close()
}

const HARD_TIMEOUT_MS = 60_000
const guard = setTimeout(() => { console.error(`FATAL hard timeout ${HARD_TIMEOUT_MS}ms`); process.exit(2) }, HARD_TIMEOUT_MS)
run().catch(e => { console.error('FATAL', e); process.exitCode = 1 }).finally(() => clearTimeout(guard))
