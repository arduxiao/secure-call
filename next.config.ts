import type { NextConfig } from "next"

const isDev = process.env.NODE_ENV !== 'production'

// Content-Security-Policy — permissive starter, will tighten to nonces later.
//
// What each directive buys us:
//   default-src 'self'        — fallback: everything must come from same origin
//   connect-src 'self' wss: ws: — Socket.IO polling + websocket upgrade (incl. dev HMR socket)
//   img-src 'self' data:      — Tailwind / Next can inline tiny PNGs as data URIs
//   font-src 'self' data:     — emoji fall back to OS fonts; data: covers inlined webfonts
//   media-src 'self' blob:    — `<video>` / `<audio>` srcObject for MediaStream is a blob URL
//   worker-src 'self' blob:   — Next + Turbopack ship workers as blob URLs
//   style-src 'self' 'unsafe-inline'  — Tailwind injects style elements; nonces is the next step
//   script-src 'self' 'unsafe-inline' — Next inlines hydration payloads (id="__NEXT_DATA__")
//     dev adds 'unsafe-eval' because Turbopack/React-Refresh uses Function() under the hood
//   object-src 'none'         — no Flash / applets / PDF embed
//   base-uri 'self'           — neutralize <base href> injection
//   form-action 'self'        — forms can't submit cross-origin
//   frame-ancestors 'none'    — defense-in-depth alongside X-Frame-Options: DENY
const SCRIPT_SRC = isDev
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'"

const CSP = [
  "default-src 'self'",
  "connect-src 'self' wss: ws:",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  SCRIPT_SRC,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

// HTTP security headers applied to every response.
const SECURITY_HEADERS = [
  { key: 'Strict-Transport-Security',    value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Frame-Options',              value: 'DENY' },
  { key: 'X-Content-Type-Options',       value: 'nosniff' },
  { key: 'Referrer-Policy',              value: 'no-referrer' },
  { key: 'Permissions-Policy',           value: 'microphone=(self), camera=(self), geolocation=(), payment=(), usb=(), fullscreen=(self)' },
  { key: 'Cross-Origin-Opener-Policy',   value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  { key: 'Content-Security-Policy',      value: CSP },
]

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }]
  },
}

export default nextConfig
