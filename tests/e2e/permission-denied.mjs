// E2E test for the pre-flight permission-denied UX.
// Scenario 1: initiator can't get mic → stays on home with error toast, NO room created.
// Scenario 2: receiver can't get mic → stays on join view with error toast; initiator's WaitingScreen unaffected.
//
// Prereqs:
//   - Dev server running on http://localhost:3000 (`npm run dev`)
//   - Chromium installed (`npx playwright install chromium`)
import { chromium } from 'playwright'

const TEST_URL = process.env.TEST_URL || 'http://localhost:3000/'
const ORIGIN = new URL(TEST_URL).origin
const log = (tag, msg) => console.log(`[${tag}] ${msg}`)

// Stub injected into the page BEFORE its scripts run. Replaces getUserMedia so the app
// behaves as if the user denied the permission prompt. defineProperty so the override
// sticks even if the MediaDevices prototype descriptor isn't writable.
const denyMicStub = `
  (() => {
    const reject = () => Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }))
    try {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: reject, configurable: true })
    } catch (_) {
      navigator.mediaDevices.getUserMedia = reject
    }
  })()
`

async function waitButtonEnabled(page, text) {
  await page.waitForFunction(
    (t) => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent?.includes(t))
      return !!b && !b.disabled
    },
    text,
    { timeout: 10_000 },
  )
}

async function run() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  })

  // ============ Scenario 1: initiator denied at 发起邀请 ============
  log('S1', 'initiator denied mic')
  {
    const ctx = await browser.newContext()
    await ctx.grantPermissions(['microphone'], { origin: ORIGIN })  // browser-level grant…
    const page = await ctx.newPage()
    page.on('console', m => { if (m.type() !== 'info') log('S1:console', `${m.type()} ${m.text()}`) })
    page.on('pageerror', e => log('S1:error', e.message))

    await page.addInitScript({ content: denyMicStub })  // …but the app's call gets denied
    await page.goto(TEST_URL)
    await waitButtonEnabled(page, '发起邀请')
    log('S1', 'click 发起邀请')
    await page.getByRole('button', { name: '发起邀请' }).click()

    let verdict
    try {
      await page.getByText('麦克风权限被拒绝', { exact: false }).waitFor({ state: 'visible', timeout: 5000 })
      const stillHome = await page.getByText('使用流程').isVisible()
      const inWaiting = await page.getByText('等待对方加入').isVisible().catch(() => false)
      verdict = stillHome && !inWaiting ? 'PASS' : `FAIL stillHome=${stillHome} inWaiting=${inWaiting}`
    } catch (e) {
      verdict = `FAIL ${e.message.split('\n')[0]}`
    }
    log(`S1-${verdict.startsWith('PASS') ? 'PASS' : 'FAIL'}`, verdict)
    await ctx.close()
    if (!verdict.startsWith('PASS')) process.exitCode = 1
  }

  // ============ Scenario 2: receiver denied at 仅音频, initiator unaffected ============
  log('S2', 'receiver denied at 仅音频, initiator should stay on WaitingScreen')
  {
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    await ctxA.grantPermissions(['microphone'], { origin: ORIGIN })
    await ctxB.grantPermissions(['microphone'], { origin: ORIGIN })

    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    pageA.on('console', m => { if (m.type() !== 'info') log('S2:A', `${m.type()} ${m.text()}`) })
    pageB.on('console', m => { if (m.type() !== 'info') log('S2:B', `${m.type()} ${m.text()}`) })

    // Only B's getUserMedia is denied.
    await pageB.addInitScript({ content: denyMicStub })

    await Promise.all([pageA.goto(TEST_URL), pageB.goto(TEST_URL)])
    await waitButtonEnabled(pageA, '发起邀请')

    log('S2:A', 'click 发起邀请')
    await pageA.getByRole('button', { name: '发起邀请' }).click()
    await pageA.getByText('等待对方加入').waitFor({ state: 'visible', timeout: 5000 })

    const roomCode = await pageA.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      for (const b of btns) {
        const t = b.textContent?.trim() ?? ''
        if (/^[A-Z0-9]{8}$/.test(t)) return t
      }
      return null
    })
    log('S2:A', `room ${roomCode}`)
    if (!roomCode) {
      log('S2-FAIL', 'no room code extracted')
      process.exitCode = 1
      await ctxA.close(); await ctxB.close()
      return
    }

    await pageB.getByRole('button', { name: '我有房间码，加入通话' }).click()
    await pageB.getByPlaceholder('输入 8 位房间码').fill(roomCode)
    await pageB.getByRole('button', { name: '查询' }).click()
    await pageB.getByText('对方的暗语标志').waitFor({ state: 'visible', timeout: 8000 })

    log('S2:B', 'click 仅音频 (will be denied)')
    await pageB.getByRole('button', { name: '仅音频' }).click()

    let verdict
    try {
      await pageB.getByText('麦克风权限被拒绝', { exact: false }).waitFor({ state: 'visible', timeout: 5000 })
      const bOnJoin = await pageB.getByPlaceholder('输入 8 位房间码').isVisible()
      const bOnHome = await pageB.getByText('使用流程').isVisible().catch(() => false)

      // A must still be on WaitingScreen after a grace period — proof that B's denial did not
      // emit a hangup that punted A back to home.
      await new Promise(r => setTimeout(r, 2000))
      const aStillWaiting = await pageA.getByText('等待对方加入').isVisible()
      const aOnHome = await pageA.getByText('使用流程').isVisible().catch(() => false)

      const ok = bOnJoin && !bOnHome && aStillWaiting && !aOnHome
      verdict = ok ? 'PASS' : `FAIL bOnJoin=${bOnJoin} bOnHome=${bOnHome} aStillWaiting=${aStillWaiting} aOnHome=${aOnHome}`
    } catch (e) {
      verdict = `FAIL ${e.message.split('\n')[0]}`
    }
    log(`S2-${verdict.startsWith('PASS') ? 'PASS' : 'FAIL'}`, verdict)
    await ctxA.close()
    await ctxB.close()
    if (!verdict.startsWith('PASS')) process.exitCode = 1
  }

  await browser.close()
}

// Hard global timeout so a misbehaving test never hangs the CI.
const HARD_TIMEOUT_MS = 60_000
const guard = setTimeout(() => {
  console.error(`FATAL hard timeout ${HARD_TIMEOUT_MS}ms`)
  process.exit(2)
}, HARD_TIMEOUT_MS)

run()
  .catch(e => { console.error('FATAL', e); process.exitCode = 1 })
  .finally(() => clearTimeout(guard))
