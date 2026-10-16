// AES-256-GCM envelope: 12-byte nonce, 16-byte authentication tag, ciphertext.
// Keep CANDIDATE_KEY in Actions secrets; never print plaintext or the key.
import { readFileSync, writeFileSync } from 'node:fs'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
const [mode, input, output] = process.argv.slice(2)
const key = Buffer.from(process.env.CANDIDATE_KEY || '', 'hex')
if (key.length !== 32 || !['encrypt', 'decrypt'].includes(mode) || !output) throw Error('Invalid encryption arguments')
const data = readFileSync(input)
if (mode === 'encrypt') {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(data), cipher.final()])
  writeFileSync(output, Buffer.concat([nonce, cipher.getAuthTag(), body]))
} else {
  const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
  cipher.setAuthTag(data.subarray(12, 28))
  writeFileSync(output, Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]))
}
