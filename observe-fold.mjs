// Read-only observation of the installed and actually loaded Quarto bundle.
import { readFileSync, appendFileSync, watch, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
const [bundle, output] = process.argv.slice(2)
const marker = '/* tlda Classroom setup chunk folding */'
const record = value => appendFileSync(output, JSON.stringify({ observedAt: new Date().toISOString(), ...value }) + '\n')
const digest = text => createHash('sha256').update(text).digest('hex')
function disk(reason) {
  try {
    const text = readFileSync(bundle, 'utf8')
    record({ kind: 'disk', reason, bundle, sha256: digest(text), marker: text.includes(marker), modifiedAt: statSync(bundle).mtime.toISOString() })
  } catch (error) { record({ kind: 'disk-error', error: String(error) }) }
}
disk('before-launch')
watch(bundle, () => disk('file-change'))
let nextId = 0
const pending = new Map()
const sessions = new Set()
let ws
function send(method, params = {}, sessionId) {
  return new Promise(resolve => {
    const id = ++nextId
    const timeout = setTimeout(() => { pending.delete(id); resolve({ error: 'timeout' }) }, 3000)
    pending.set(id, value => { clearTimeout(timeout); resolve(value) })
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}
async function attach() {
  const targets = await send('Target.getTargets')
  for (const target of targets.result?.targetInfos || []) {
    if (sessions.has(target.targetId) || !['page', 'iframe', 'webview', 'other'].includes(target.type)) continue
    sessions.add(target.targetId)
    const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    const session = attached.result?.sessionId
    record({ kind: 'attach', target: target.url, type: target.type, session })
    if (session) await send('Debugger.enable', {}, session)
  }
}
async function connect() {
  const response = await fetch('http://127.0.0.1:9222/json/version')
  const version = await response.json()
  const WS = globalThis.WebSocket || (await import('ws')).WebSocket
  ws = new WS(version.webSocketDebuggerUrl)
  await new Promise(resolve => { ws.onopen = resolve })
  ws.onmessage = async event => {
    const value = JSON.parse(event.data)
    if (value.id && pending.has(value.id)) { const resolve = pending.get(value.id); pending.delete(value.id); resolve(value); return }
    if (value.method !== 'Debugger.scriptParsed') return
    const url = decodeURIComponent(value.params.url || '')
    if (!/index\.js(?:[?#]|$)/.test(url)) return
    const source = await send('Debugger.getScriptSource', { scriptId: value.params.scriptId }, value.sessionId)
    const text = source.result?.scriptSource
    record({ kind: 'loaded-script', url, cdpHash: value.params.hash, sha256: typeof text === 'string' ? digest(text) : null, marker: typeof text === 'string' ? text.includes(marker) : null, error: source.error, note: 'scriptParsed can replay scripts loaded before Debugger.enable; this timestamp is observation time' })
  }
  record({ kind: 'cdp-connected' })
  await attach()
  setInterval(() => attach().catch(error => record({ kind: 'attach-error', error: String(error) })), 250)
}
// Retry attachment while the ordinary IDE launch is starting; never gate its UI.
let connecting = false
const retry = setInterval(() => {
  if (connecting) return
  connecting = true
  connect().then(() => clearInterval(retry)).catch(() => { connecting = false })
}, 500)
