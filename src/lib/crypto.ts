import nacl from 'tweetnacl'
import naclUtil from 'tweetnacl-util'

const { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } = naclUtil

export function generateEphemeralKeyPair() {
  const kp = nacl.box.keyPair()
  return { publicKeyB64: encodeBase64(kp.publicKey), secretKey: kp.secretKey }
}

export function computeSharedKey(theirPubB64: string, mySecret: Uint8Array): Uint8Array {
  return nacl.box.before(decodeBase64(theirPubB64), mySecret)
}

export function encrypt(text: string, key: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  // decodeUTF8: string -> Uint8Array (convert text to bytes for encryption)
  const msgBytes = decodeUTF8(text)
  const box = nacl.box.after(msgBytes, nonce, key)
  const full = new Uint8Array(nonce.length + box.length)
  full.set(nonce)
  full.set(box, nonce.length)
  return encodeBase64(full)
}

export function decrypt(b64: string, key: Uint8Array): string {
  const full = decodeBase64(b64)
  const nonce = full.slice(0, nacl.box.nonceLength)
  const box = full.slice(nacl.box.nonceLength)
  const plain = nacl.box.open.after(box, nonce, key)
  if (!plain) throw new Error('Decryption failed')
  // encodeUTF8: Uint8Array -> string (convert decrypted bytes back to text)
  return encodeUTF8(plain)
}
