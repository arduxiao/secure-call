// End-to-end happy-path test for the call flow.
// Drives two Chromium contexts: A (initiator) and B (receiver).
// Usage: node tests/e2e/call.mjs [audio|video]   (default: audio)
//
// Prereqs:
//   - Dev server running on http://localhost:3000 (`npm run dev`)
//   - Chromium installed (`npx playwright install chromium`)
import { chromium } from 'playwright'

const TEST_URL = process.env.TEST_URL || 'http://localhost:3000/'
const ORIGIN = new URL(TEST_URL).origin
const MODE = process.argv[2] === 'video' ? 'video' : 'audio'
const ACCEPT_BUTTON = MODE === 'video' ? '视频通话' : '仅音频'

// "in a call?" probe — runs inside the page.
// Audio: page contains 语音通话中 text.
// Video: page has two <video> elements both with a non-null srcObject.
const inCallProbe = (mode) => mode === 'video'
  ? () => {
      const vs = [...document.querySelectorAll('video')]
      return vs.length >= 2 && vs.every(v => v.srcObject instanceof MediaStream)
    }
  : () => document.body.innerText.includes('语音通话中')

const log = (tag, msg) => console.log(`[${tag}] ${msg}`)

async function main() {
  const launchArgs = [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ]
  const browser = await chromium.launch({ headless: true, args: launchArgs })

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  await ctxA.grantPermissions(['microphone', 'camera'], { origin: ORIGIN })
  await ctxB.grantPermissions(['microphone', 'camera'], { origin: ORIGIN })

  // Instrument RTCPeerConnection to log every state change.
  const instrument = `
    (() => {
      const _RTC = window.RTCPeerConnection
      window.RTCPeerConnection = function(...a) {
        const pc = new _RTC(...a)
        const tag = '[pc#' + Math.random().toString(36).slice(2,6) + ']'
        const log = (e) => console.log(tag, e,
          'conn=' + pc.connectionState,
          'ice=' + pc.iceConnectionState,
          'gather=' + pc.iceGatheringState,
          'sig=' + pc.signalingState)
        pc.addEventListener('connectionstatechange', () => log('conn'))
        pc.addEventListener('iceconnectionstatechange', () => log('ice'))
        pc.addEventListener('icegatheringstatechange', () => log('gather'))
        pc.addEventListener('signalingstatechange', () => log('sig'))
        return pc
      }
      window.RTCPeerConnection.prototype = _RTC.prototype
    })()
  `
  await ctxA.addInitScript({ content: instrument })
  await ctxB.addInitScript({ content: instrument })

  const pageA = await ctxA.newPage()
  const pageB = await ctxB.newPage()

  pageA.on('console', m => log('A:console', `${m.type()} ${m.text()}`))
  pageB.on('console', m => log('B:console', `${m.type()} ${m.text()}`))
  pageA.on('pageerror', e => log('A:error', e.message))
  pageB.on('pageerror', e => log('B:error', e.message))

  log('main', `loading ${TEST_URL} on both peers`)
  await Promise.all([pageA.goto(TEST_URL), pageB.goto(TEST_URL)])

  await pageA.getByRole('button', { name: '发起邀请' }).waitFor({ state: 'visible' })
  await pageA.waitForFunction(
    () => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('发起邀请'))
      return btn && !btn.disabled
    },
    { timeout: 10_000 },
  )
  log('A', 'click 发起邀请')
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
  log('A', `room code = ${roomCode}`)
  if (!roomCode) throw new Error('could not extract room code from initiator')

  log('B', 'click 我有房间码，加入通话')
  await pageB.getByRole('button', { name: '我有房间码，加入通话' }).click()
  await pageB.getByPlaceholder('输入 8 位房间码').fill(roomCode)
  log('B', 'click 查询')
  await pageB.getByRole('button', { name: '查询' }).click()

  await pageB.getByText('对方的暗语标志').waitFor({ state: 'visible', timeout: 8000 })
  log('B', `click ${ACCEPT_BUTTON}`)
  await pageB.getByRole('button', { name: ACCEPT_BUTTON }).click()

  // SAS verification step: both sides must confirm fingerprint match.
  log('main', 'waiting for SAS fingerprint screen on both peers…')
  await Promise.all([
    pageA.getByText('核对身份与密钥').waitFor({ state: 'visible', timeout: 10_000 }),
    pageB.getByText('核对身份与密钥').waitFor({ state: 'visible', timeout: 10_000 }),
  ])
  // Sanity: SAS must match across A and B (4 emoji span elements).
  // SAS length is intentionally not pinned here — we only assert (a) both sides
  // show at least 4 emoji and (b) the two sides agree. That keeps this test
  // robust to entropy bumps (v1=4 emoji, v2=6 emoji, …).
  const sasOf = (page) => page.evaluate(() => {
    // numeric-sorted by index, e.g. fingerprint-0..fingerprint-5
    return Array.from(document.querySelectorAll('[aria-label^="fingerprint-"]'))
      .sort((a, b) => Number(a.getAttribute('aria-label').replace(/^fingerprint-/, '')) -
                      Number(b.getAttribute('aria-label').replace(/^fingerprint-/, '')))
      .map(el => el.textContent.trim())
  })
  const [sasA, sasB] = await Promise.all([sasOf(pageA), sasOf(pageB)])
  log('main', `SAS A=${sasA.join('')}  B=${sasB.join('')}`)
  if (sasA.length < 4 || sasB.length < 4 || sasA.join('') !== sasB.join('')) {
    throw new Error(`SAS mismatch: A=${sasA.join('')} B=${sasB.join('')}`)
  }
  log('main', 'click ✓ 一致 on both peers')
  await pageA.getByRole('button', { name: /与对方一致/ }).click()
  await pageB.getByRole('button', { name: /与对方一致/ }).click()

  log('main', `waiting for both peers to enter the ${MODE} call view…`)
  const probeSrc = inCallProbe(MODE).toString()
  const waitInCall = (page) => page.waitForFunction(`(${probeSrc})()`, { timeout: 20_000 })
  const start = Date.now()

  // Fail fast if either peer falls back to the home screen.
  const failA = pageA.getByText('使用流程').waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'A returned to home')
  const failB = pageB.getByText('使用流程').waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'B returned to home')
  const winner = await Promise.race([
    Promise.all([waitInCall(pageA), waitInCall(pageB)]).then(() => 'CONNECTED'),
    failA,
    failB,
  ])

  if (winner !== 'CONNECTED') {
    log('FAIL', winner)
    await pageA.screenshot({ path: '/tmp/fail-A.png' })
    await pageB.screenshot({ path: '/tmp/fail-B.png' })
    log('main', 'screenshots: /tmp/fail-A.png /tmp/fail-B.png')
    process.exitCode = 1
  } else {
    log('PASS', `both peers connected in ${Date.now() - start}ms`)

    // Verify track health on both sides.
    const trackInfo = async (page, tag) => {
      const info = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('video,audio')).map(el => {
          const stream = el.srcObject
          if (!(stream instanceof MediaStream)) return null
          return {
            audioTracks: stream.getAudioTracks().map(t => ({ enabled: t.enabled, muted: t.muted, readyState: t.readyState })),
            videoTracks: stream.getVideoTracks().map(t => ({ enabled: t.enabled, muted: t.muted, readyState: t.readyState })),
          }
        }).filter(Boolean)
      })
      log(tag, `media: ${JSON.stringify(info)}`)
    }
    await trackInfo(pageA, 'A')
    await trackInfo(pageB, 'B')

    log('A', 'click 挂断')
    await pageA.getByTitle('挂断').click()
    await pageA.getByText('使用流程').waitFor({ state: 'visible', timeout: 5000 })
    await pageB.getByText('使用流程').waitFor({ state: 'visible', timeout: 5000 })
    log('PASS', 'both peers returned to home after hangup')
  }

  await browser.close()
}

main().catch(e => { console.error('FATAL', e); process.exitCode = 1 })
