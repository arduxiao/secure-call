// E2E: SAS (Short Authentication String) fingerprint verification.
// Scenario 1: both peers confirm match → call connects.
// Scenario 2: receiver rejects mismatch → both peers return home with the "mismatch" error.
// Prereqs: `npm run dev`, `npx playwright install chromium`.
import { chromium } from 'playwright'

const TEST_URL = process.env.TEST_URL || 'http://localhost:3000/'
const ORIGIN = new URL(TEST_URL).origin
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

async function sasOf(page) {
  return page.evaluate(() => {
    // Numeric sort so fingerprint-10 doesn't land between fingerprint-1 and fingerprint-2.
    return Array.from(document.querySelectorAll('[aria-label^="fingerprint-"]'))
      .sort((a, b) => Number(a.getAttribute('aria-label').replace(/^fingerprint-/, '')) -
                      Number(b.getAttribute('aria-label').replace(/^fingerprint-/, '')))
      .map(el => el.textContent.trim())
  })
}

async function bootstrapCall(browser) {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  await ctxA.grantPermissions(['microphone'], { origin: ORIGIN })
  await ctxB.grantPermissions(['microphone'], { origin: ORIGIN })

  const pageA = await ctxA.newPage()
  const pageB = await ctxB.newPage()
  pageA.on('console', m => { if (m.type() !== 'info') log('A', `${m.type()} ${m.text()}`) })
  pageB.on('console', m => { if (m.type() !== 'info') log('B', `${m.type()} ${m.text()}`) })

  await Promise.all([pageA.goto(TEST_URL), pageB.goto(TEST_URL)])
  await pageA.waitForFunction(
    () => [...document.querySelectorAll('button')].find(b => b.textContent?.includes('发起邀请') && !b.disabled),
    { timeout: 10_000 },
  )
  await pageA.getByRole('button', { name: '发起邀请' }).click()
  await pageA.getByText('等待对方加入').waitFor({ state: 'visible', timeout: 5000 })
  const code = await readRoomCode(pageA)
  if (!code) throw new Error('no room code')

  await pageB.getByRole('button', { name: '我有房间码，加入通话' }).click()
  await pageB.getByPlaceholder('输入 8 位房间码').fill(code)
  await pageB.getByRole('button', { name: '查询' }).click()
  await pageB.getByText('对方的暗语标志').waitFor({ state: 'visible', timeout: 8000 })
  await pageB.getByRole('button', { name: '仅音频' }).click()

  await Promise.all([
    pageA.getByText('核对身份与密钥').waitFor({ state: 'visible', timeout: 10_000 }),
    pageB.getByText('核对身份与密钥').waitFor({ state: 'visible', timeout: 10_000 }),
  ])
  return { ctxA, ctxB, pageA, pageB }
}

async function scenarioMatch(browser) {
  log('S1', 'both peers confirm SAS → call connects')
  const { ctxA, ctxB, pageA, pageB } = await bootstrapCall(browser)
  const [sasA, sasB] = await Promise.all([sasOf(pageA), sasOf(pageB)])
  log('S1', `SAS A=${sasA.join('')}  B=${sasB.join('')}`)
  if (sasA.length < 4 || sasB.length < 4 || sasA.join('') !== sasB.join('')) {
    throw new Error(`SAS mismatch: A=${sasA.join('')} B=${sasB.join('')}`)
  }
  await pageA.getByRole('button', { name: /指纹一致/ }).click()
  await pageB.getByRole('button', { name: /指纹一致/ }).click()

  const inCall = () => document.body.innerText.includes('语音通话中')
  await Promise.all([
    pageA.waitForFunction(inCall, { timeout: 20_000 }),
    pageB.waitForFunction(inCall, { timeout: 20_000 }),
  ])
  log('S1-PASS', 'both peers in call after SAS match')
  await pageA.getByTitle('挂断').click()
  await pageA.getByText('使用流程').waitFor({ state: 'visible', timeout: 5000 })
  await pageB.getByText('使用流程').waitFor({ state: 'visible', timeout: 5000 })
  await ctxA.close()
  await ctxB.close()
}

async function scenarioReject(browser) {
  log('S2', 'B rejects mismatch → both peers home with mismatch error')
  const { ctxA, ctxB, pageA, pageB } = await bootstrapCall(browser)
  log('S2:B', 'click ✕ 不一致，挂断')
  await pageB.getByRole('button', { name: /不一致/ }).click()
  await pageB.getByText('使用流程').waitFor({ state: 'visible', timeout: 5000 })
  // B should see its own mismatch reason on home.
  await pageB.getByText('密钥指纹不一致', { exact: false }).waitFor({ state: 'visible', timeout: 5000 })
  // A is forwarded a peer-hung-up and returns to home; with verifying view treated as "mid-connect"
  // the page surfaces 「对方已取消或离开」 on A's side.
  await pageA.getByText('使用流程').waitFor({ state: 'visible', timeout: 5000 })
  await pageA.getByText('对方已取消或离开', { exact: false }).waitFor({ state: 'visible', timeout: 5000 })
  log('S2-PASS', 'both peers home after reject')
  await ctxA.close()
  await ctxB.close()
}

async function run() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  })
  await scenarioMatch(browser)
  await scenarioReject(browser)
  await browser.close()
}

const HARD_TIMEOUT_MS = 90_000
const guard = setTimeout(() => { console.error(`FATAL hard timeout ${HARD_TIMEOUT_MS}ms`); process.exit(2) }, HARD_TIMEOUT_MS)
run().catch(e => { console.error('FATAL', e); process.exitCode = 1 }).finally(() => clearTimeout(guard))
