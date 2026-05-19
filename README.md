# secure-call

端到端加密的 1-对-1 音视频通话。零存储信令（房间码 15 分钟 TTL）、
SAS 数学指纹双向人工对码、暗语标志辅助身份识别。

## 架构

```
┌─────┐  ECDH pubKey + symbol  ┌────────────┐  ECDH pubKey + symbol  ┌─────┐
│  A  │ ─────────────────────▶ │  Signaling │ ◀───────────────────── │  B  │
│     │                        │  (Next.js  │                        │     │
│     │ ◀──── encrypted SDP/ICE relay ────▶│                        │     │
│     │                        └────────────┘                        │     │
│     │ ◀══════════ DTLS-SRTP P2P media (after ICE) ═══════════════▶ │     │
└─────┘                                                              └─────┘
```

- 信令服务器内存里只存到 `(roomId, pubKey, symbol, expiresAt)`；不落盘
- SDP / ICE 用双方 ECDH 共享密钥端到端加密后再走信令
- 媒体走 WebRTC 原生 DTLS-SRTP，端到端，与信令服务器无关
- 人工核对 SAS（6 emoji，30 bits）是抗信令服务器中间人的最终防线

详见 `docs/audit-2026-05-19.html` 与 `docs/audit-2026-05-19-round2.html`。

## 开发

```bash
npm install
npm run dev      # http://localhost:3000
```

> **重大重构后请重启 dev server。** Next.js + Turbopack 的 HMR 在多轮
> page.tsx / hooks 改写后可能累积陈旧的 effect 副本（多个监听器同时
> 挂在 socket 上），导致测试在 verifying → connecting 这一段超时。
> 表现是「双方都点了「指纹一致」却卡死」。Ctrl-C dev server，
> `npm run dev` 重启即可，CI 用全新进程不受影响。

## E2E 测试

需要 Chromium：`npx playwright install chromium`，然后：

```bash
npm run dev &           # 先起 dev server
npm run test:e2e        # 跑全部
# 或单测：
npm run test:e2e:audio  # 仅音频通话流程
npm run test:e2e:video  # 视频通话流程
npm run test:e2e:perm   # 麦克风权限被拒
npm run test:e2e:edit   # 发起方修改房间码
npm run test:e2e:sas    # SAS 指纹双方核对（一致 / 拒绝）
npm run test:e2e:adv    # 对抗性测试（伪造 answer、限频、坏 symbol）
```

CI 在每个 push / PR 上自动跑全部六项，详见
`.github/workflows/e2e.yml`。

## 部署（Render）

`render.yaml` 已配好。必填的环境变量：

| 变量              | 用途                                                            |
|-------------------|-----------------------------------------------------------------|
| `NODE_ENV`        | `production`                                                    |
| `PORT`            | `3000`（Render 会覆盖）                                         |
| `ALLOWED_ORIGIN`  | Socket.IO CORS 白名单。可填逗号分隔多个 origin                  |
| `MAX_ROOMS`       | 可选，默认 5000。CI 里设 20 以触发 capacity 边界用例            |

`ALLOWED_ORIGIN` 与 `RENDER_EXTERNAL_URL` 任一存在即可——双保险防止
线上启动时 allow-list 为空被锁死。

## 安全模型与已知边界

- ✅ **抗被动监听**：信令 SDP / ICE 全程 ECDH 加密；媒体走 DTLS-SRTP
- ✅ **抗主动 MITM**：SAS 双方人工对码（30 bits ≈ 10⁹ 抗预计算碰撞）
- ⚠️ **暗语标志不是密码学证据**：经服务器明文中转，恶意服务器可保留
  原值同时仍 MITM。UI 已显式标注；最终判断以 SAS 为准
- ⚠️ **没有 TURN**：对称 NAT 下两端连不通。仅靠 Google + Cloudflare
  STUN
- ⚠️ **状态级对手**：30 bits 的 SAS 在 GPU 集群上仍可破，希望抗住
  60+ bits 的对手需要更长指纹或字表方案
