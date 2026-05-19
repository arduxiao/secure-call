// Shared signaling protocol types. Imported by both the Socket.IO server handlers
// and the React client so the wire shape stays in sync.

export type CallMode = 'audio' | 'video'

// ── client → server ──────────────────────────────────────────────────────────
export interface CreateRoomMsg {
  roomId: string
  symbols: string         // A's pre-arranged identity emoji string
  pubKeyA: string         // base64 X25519 public key
}
export interface LookupRoomMsg { roomId: string }
export interface JoinRoomMsg {
  roomId: string
  pubKeyB: string
  callMode: CallMode
  symbolsB: string        // B's pre-arranged identity emoji string (bidirectional 暗语)
}
export interface RelayMsg {
  roomId: string
  // exactly one of these is set per message family below
  sdp?: string
  candidate?: string
  fromA?: boolean
}
export interface RoomIdMsg { roomId: string }

// ── server → client ──────────────────────────────────────────────────────────
export interface RoomInfoMsg { symbols: string; pubKeyA: string }
export interface RoomCreatedMsg { roomId: string }
export interface PeerJoinedMsg { pubKeyB: string; callMode: CallMode; symbolsB: string }
export interface OfferMsg { sdp: string }
export interface AnswerMsg { sdp: string }
export interface IceCandidateMsg { candidate: string }
export interface ErrorMsg { message: string }
export interface RateLimitedMsg { event: string }

// Map of every event the server can emit → its payload type.
// Useful when narrowing inside the client's on() callbacks.
export interface ServerEvents {
  'room-created':         RoomCreatedMsg
  'room-info':            RoomInfoMsg
  'room-not-found':       void
  'peer-joined':          PeerJoinedMsg
  'offer':                OfferMsg
  'answer':               AnswerMsg
  'ice-candidate':        IceCandidateMsg
  'peer-hung-up':         void
  'peer-verify-confirmed': void
  'error':                ErrorMsg
  'rate-limited':         RateLimitedMsg
}
