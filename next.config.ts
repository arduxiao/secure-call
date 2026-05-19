import type { NextConfig } from "next"

// HTTP security headers applied to every response.
// - HSTS: lock the site to HTTPS once seen, including subdomains.
// - X-Frame-Options DENY: refuse to be framed → prevents clickjacking that would
//   trick the user into clicking 接听 (which grants mic permission for a hidden caller).
// - Referrer-Policy no-referrer: don't leak the room URL to any outbound link.
// - Permissions-Policy: only self may use mic/camera; deny everything else by default.
// - X-Content-Type-Options nosniff: don't let the browser guess content types.
const SECURITY_HEADERS = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Frame-Options',           value: 'DENY' },
  { key: 'X-Content-Type-Options',    value: 'nosniff' },
  { key: 'Referrer-Policy',           value: 'no-referrer' },
  { key: 'Permissions-Policy',        value: 'microphone=(self), camera=(self), geolocation=(), payment=(), usb=(), fullscreen=(self)' },
  { key: 'Cross-Origin-Opener-Policy',   value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
]

const nextConfig: NextConfig = {
  turbopack: {},
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }]
  },
}

export default nextConfig
