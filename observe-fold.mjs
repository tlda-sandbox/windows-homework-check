// Read-only observation of the installed and actually loaded Quarto bundle.
import { readFileSync, appendFileSync, writeFileSync, watch, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
const [bundle, output] = process.argv.slice(2)
const marker = '/* tlda Classroom setup chunk folding */'
const record = value => appendFileSync(output, JSON.stringify({ observedAt: new Date().toISOString(), ...value }) + '\n')
const digest = text => createHash('sha256').update(text).digest('hex')
const probes = process.env.FOLD_ENTRY_PROBES === 'true' ? JSON.parse(readFileSync('fold-probe-locations.json', 'utf8')) : null
const phase = () => { try { return readFileSync('evidence/probe-phase.txt', 'utf8').trim() } catch { return 'unknown' } }
let preparedProbes
let calibrationIds = []
let routeIds = []
let routeBusy = false
let routeArmed = false
let routeRemoved = false
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
async function installProbe(probe) {
  const condition = probe.entry.condition || `(console.log(${JSON.stringify(probe.entry.token)}),false)`
  const response = await send('Debugger.setBreakpoint', { location: probe.executable, condition }, probe.session)
  const actual = response.result?.actualLocation
  record({ kind: 'probe-location', token: probe.entry.token, requested: probe.requested, executable: probe.executable, actual, error: response.error })
  if (!actual || actual.lineNumber !== probe.executable.lineNumber || actual.columnNumber !== probe.executable.columnNumber) throw Error('Probe failed to resolve: ' + probe.entry.token)
  return { breakpointId: response.result.breakpointId, session: probe.session, token: probe.entry.token, actual }
}
async function removeProbes(installed) {
  for (const probe of installed) {
    const response = await send('Debugger.removeBreakpoint', { breakpointId: probe.breakpointId }, probe.session)
    if (response.error) throw Error('Probe removal failed: ' + probe.token)
  }
}
async function syncProbePhase() {
  if (!preparedProbes || routeBusy) return
  if (phase() === 'refold' && !routeArmed) {
    routeBusy = true
    try {
      await removeProbes(calibrationIds)
      calibrationIds = []
      for (const probe of preparedProbes.filter(p => p.entry.arm === 'refold')) routeIds.push(await installProbe(probe))
      routeArmed = true
      writeFileSync('evidence/route-probes-ready.json', JSON.stringify({ sha256: probes.sha256, locations: routeIds.map(({ token, actual }) => ({ token, actual })) }))
    } catch (error) {
      writeFileSync('evidence/probes-error.json', JSON.stringify({ reason: String(error) }))
    } finally { routeBusy = false }
  } else if (phase() === 'after-refold' && routeArmed && !routeRemoved) {
    routeBusy = true
    try {
      await removeProbes(routeIds)
      routeRemoved = true
      record({ kind: 'route-probes-removed', count: routeIds.length })
      writeFileSync('evidence/route-probes-removed.json', JSON.stringify({ count: routeIds.length }))
    } catch (error) { writeFileSync('evidence/probes-error.json', JSON.stringify({ reason: String(error) })) }
    finally { routeBusy = false }
  }
}
async function attach() {
  const targets = await send('Target.getTargets')
  for (const target of targets.result?.targetInfos || []) {
    if (sessions.has(target.targetId) || !['page', 'iframe', 'webview', 'other'].includes(target.type)) continue
    sessions.add(target.targetId)
    const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    const session = attached.result?.sessionId
    record({ kind: 'attach', target: target.url, type: target.type, session })
    if (session) {
      await send('Runtime.enable', {}, session)
      await send('Debugger.enable', {}, session)
    }
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
    if (probes && value.method === 'Runtime.consoleAPICalled') {
      const token = value.params.args?.[0]?.value
      if (probes.entries.some(entry => entry.token === token)) {
        const observedPhase = phase()
        const outcomes = token === 'TLDA_FOLD_MAP_KEYS' ? value.params.args.slice(1, 3).map(argument => argument.value) : undefined
        if (outcomes && (outcomes.length !== 2 || outcomes.some(v => typeof v !== 'boolean'))) {
          writeFileSync('evidence/probes-error.json', JSON.stringify({ reason: 'Map probe emitted non-boolean output' }))
          return
        }
        record({ kind: 'probe-token', token, phase: observedPhase, timestamp: value.params.timestamp, outcomes })
        appendFileSync('evidence/probe-hits.jsonl', JSON.stringify({ token, phase: observedPhase, timestamp: value.params.timestamp, outcomes }) + '\n')
      }
      return
    }
    if (value.method !== 'Debugger.scriptParsed') return
    const url = decodeURIComponent(value.params.url || '')
    if (!/index\.js(?:[?#]|$)/.test(url)) return
    const source = await send('Debugger.getScriptSource', { scriptId: value.params.scriptId }, value.sessionId)
    const text = source.result?.scriptSource
    record({ kind: 'loaded-script', url, cdpHash: value.params.hash, sha256: typeof text === 'string' ? digest(text) : null, marker: typeof text === 'string' ? text.includes(marker) : null, error: source.error, note: 'scriptParsed can replay scripts loaded before Debugger.enable; this timestamp is observation time' })
    if (typeof text === 'string' && process.env.FOLD_EXPECTED_SHA256 && digest(text) === process.env.FOLD_EXPECTED_SHA256 && text.includes(marker)) {
      writeFileSync('evidence/loaded-bundle-ready.json', JSON.stringify({ sha256: digest(text), marker: true }))
    }
    if (probes && !preparedProbes && typeof text === 'string' && digest(text) === probes.sha256) {
      const prepared = []
      const sourceLines = text.split('\n')
      for (const entry of probes.entries) {
        const location = { scriptId: value.params.scriptId, lineNumber: entry.line, columnNumber: entry.column }
        if (!sourceLines[entry.line]?.slice(entry.column).startsWith(entry.prefix)) {
          writeFileSync('evidence/probes-error.json', JSON.stringify({ token: entry.token, reason: 'source entry prefix mismatch' }))
          return
        }
        const offset = entry.target ? entry.prefix.indexOf(entry.target) : 0
        if (offset < 0) throw Error('Probe target missing from verified prefix: ' + entry.token)
        const start = { ...location, columnNumber: entry.column + offset }
        const end = { ...start, columnNumber: start.columnNumber + (entry.target || entry.prefix).length }
        const possible = await send('Debugger.getPossibleBreakpoints', { start, end, restrictToFunction: true }, value.sessionId)
        const executable = possible.result?.locations?.[0]
        if (!executable || executable.lineNumber !== start.lineNumber || executable.columnNumber < start.columnNumber || executable.columnNumber >= end.columnNumber) {
          writeFileSync('evidence/probes-error.json', JSON.stringify({ token: entry.token, reason: 'no executable location in entry expression', error: possible.error }))
          return
        }
        prepared.push({ entry, requested: location, executable, session: value.sessionId })
      }
      try {
        for (const probe of prepared.filter(p => p.entry.arm !== 'refold')) calibrationIds.push(await installProbe(probe))
        preparedProbes = prepared
        writeFileSync('evidence/probes-ready.json', JSON.stringify({ sha256: probes.sha256, prepared: prepared.map(({ entry, executable }) => ({ token: entry.token, executable })), calibration: calibrationIds.map(({ token, actual }) => ({ token, actual })) }))
      } catch (error) { writeFileSync('evidence/probes-error.json', JSON.stringify({ reason: String(error) })) }
    }
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
if (probes) setInterval(() => syncProbePhase().catch(error => record({ kind: 'probe-error', error: String(error) })), 100)
