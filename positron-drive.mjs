#!/usr/bin/env node
// positron-drive.mjs <port> <action> [args...]
//   targets                  — list CDP targets
//   eval <expr>              — evaluate JS in the workbench, print the value
//   console                  — print the positronConsole panel text
//   open <rowLabel>          — double-click an explorer row with that exact label
//   click <cssSelector>      — click the first element matching the selector
//   clicktext <label>        — click an element whose exact text is the label
//   pick <needle>            — click a monaco-list row containing the needle, then Enter
//   r <code>                 — focus the R console input, type the code, submit, print the tail
//   type <text> / enter      — raw input into the focused element
//   keys ctrl+shift+p        — a key combo (Windows modifiers)
// Attaches with Target.attachToTarget {flatten:true}; never guesses a WS url from /json/list.
// Ported for Windows from the Mac driver measured 2026-10-09 (power-polish-ds).
import http from 'node:http'

const [port, action, ...args] = process.argv.slice(2)
if (!port || !action) { console.error('usage: positron-drive.mjs <port> <action> [args]'); process.exit(2) }

const get = p => new Promise((res, rej) =>
  http.get(p, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(b)) }).on('error', rej))

const version = JSON.parse(await get(`http://127.0.0.1:${port}/json/version`))
const WS = globalThis.WebSocket || (await import('ws')).WebSocket
const ws = new WS(version.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = m => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) }
}
await new Promise(r => { ws.onopen = r })
const send = (method, params = {}, sessionId) => new Promise(r => {
  const i = ++id; pending.set(i, r)
  ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }))
})

const tg = await send('Target.getTargets')
const page = tg.result.targetInfos.find(x => x.type === 'page')
if (!page) { console.error('no page target'); process.exit(3) }
console.error(`# target: ${page.title}`)
const sid = (await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).result.sessionId

const ev = async expr => {
  const d = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid)
  if (d.result?.exceptionDetails) return `ERR: ${d.result.exceptionDetails.text}`
  return d.result?.result?.value
}
const clickAt = async (x, y, count = 1) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: count }, sid)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: count }, sid)
}
const pressEnter = async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' }, sid)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' }, sid)
}

switch (action) {
  case 'targets':
    console.log(tg.result.targetInfos.map(t => `${t.type} | ${t.title}`).join('\n')); break
  case 'eval':
    console.log(await ev(args.join(' '))); break
  case 'console':
    console.log(await ev(`(()=>{const c=document.getElementById("workbench.panel.positronConsole"); return c? c.textContent.trim().slice(-3000):"NO CONSOLE"})()`)); break
  case 'open': {
    const label = args.join(' ')
    const rect = JSON.parse(await ev(`(()=>{const rows=[...document.querySelectorAll('.monaco-list-row')];
      const r=rows.find(x=>x.textContent.trim()===${JSON.stringify(label)});
      if(!r) return JSON.stringify({found:false, sample: rows.slice(0,10).map(x=>x.textContent.trim())});
      const b=r.getBoundingClientRect(); return JSON.stringify({found:true,x:b.x+b.width/2,y:b.y+b.height/2})})()`))
    if (!rect.found) { console.error('row not found; sample:', rect.sample); process.exit(4) }
    await clickAt(rect.x, rect.y); await clickAt(rect.x, rect.y, 2)
    await new Promise(r => setTimeout(r, 3000))
    console.log(await ev(`[...document.querySelectorAll('.tab')].map(t=>t.textContent.trim()).join(' | ')`))
    break
  }
  case 'keys': {
    const combo = args.join(' ').toLowerCase()
    const parts = combo.split('+')
    const modifiers = (parts.includes('ctrl') ? 2 : 0) | (parts.includes('shift') ? 8 : 0) | (parts.includes('alt') ? 1 : 0) | (parts.includes('win') ? 4 : 0)
    const key = parts.filter(x => !['ctrl', 'shift', 'alt', 'win'].includes(x)).pop()
    const VK = { p: 80, a: 65, b: 66, c: 67, d: 68, e: 69, f: 70, h: 72, i: 73, k: 73, n: 78, o: 79, r: 82, s: 83, w: 87, x: 88, enter: 13, escape: 27 }[key] || 0
    await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, windowsVirtualKeyCode: VK, key, code: 'Key' + key.toUpperCase() }, sid)
    await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, windowsVirtualKeyCode: VK, key, code: 'Key' + key.toUpperCase() }, sid)
    await new Promise(r => setTimeout(r, 1200))
    console.log('sent ' + combo)
    break
  }
  case 'type': {
    await send('Input.insertText', { text: args.join(' ') }, sid)
    await new Promise(r => setTimeout(r, 800))
    console.log('typed')
    break
  }
  case 'enter': {
    await pressEnter()
    await new Promise(r => setTimeout(r, 800))
    console.log('enter')
    break
  }
  case 'r': {
    const code = args.join(' ')
    const rect = JSON.parse(await ev(`(()=>{
      const scoped=[...document.querySelectorAll('#workbench.panel.positronConsole textarea, .positron-console textarea, .positron-console input')];
      const t=scoped.find(i=>i.offsetParent)||document.querySelector('textarea.inputarea');
      if(!t) return JSON.stringify({found:false});
      const b=t.getBoundingClientRect();
      return JSON.stringify({found:true,x:b.x+b.width/2,y:b.y+b.height/2,cls:t.className.slice(0,60),id:t.closest('[id]')?.id||''})})()`))
    if (!rect.found) { console.error('no console input found'); process.exit(8) }
    console.error(`# console input: ${rect.cls} (${rect.id})`)
    await send('Page.bringToFront', {}, sid)
    await new Promise(r => setTimeout(r, 500))
    await clickAt(rect.x, rect.y)          // a real click, so focus lands like a user's
    await new Promise(r => setTimeout(r, 400))
    await send('Input.insertText', { text: code }, sid)
    await new Promise(r => setTimeout(r, 600))
    await pressEnter()
    await new Promise(r => setTimeout(r, 3000))
    console.log(await ev(`(()=>{const c=document.getElementById("workbench.panel.positronConsole"); return c? c.textContent.trim().slice(-3000):"NO CONSOLE"})()`))
    break
  }
  case 'screenshot': {
    const target = args[0] || 'screenshot.png'
    const shot = await send('Page.captureScreenshot', { format: 'png' }, sid)
    if (!shot.result?.data) { console.error('captureScreenshot failed:', JSON.stringify(shot).slice(0, 200)); process.exit(9) }
    const fsMod = await import('node:fs')
    fsMod.writeFileSync(target, Buffer.from(shot.result.data, 'base64'))
    console.log(`screenshot written: ${target}`)
    break
  }
  case 'scrollconsole': {
    const delta = Number(args[0]) || -400
    const count = Number(args[1]) || 3
    const rect = JSON.parse(await ev(`(()=>{const c=document.getElementById('workbench.panel.positronConsole'); if(!c) return JSON.stringify({found:false}); const b=c.getBoundingClientRect(); return JSON.stringify({found:true,x:b.x+b.width/2,y:b.y+b.height/2})})()`))
    if (!rect.found) { console.error('no console panel'); process.exit(10) }
    await send('Page.bringToFront', {}, sid)
    for (let i = 0; i < count; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY: delta }, sid)
      await new Promise(r => setTimeout(r, 300))
    }
    console.log(`scrolled console ${count} x ${delta}`)
    break
  }
  case 'sleep': {
    const secs = Math.max(1, Number(args[0]) || 10)
    await new Promise(r => setTimeout(r, secs * 1000))
    console.log(`slept ${secs}s`)
    break
  }
  case 'waitconsole': {
    const secs = Math.max(5, Number(args.pop()) || 30)
    const needle = args.join(' ')
    const deadline = Date.now() + secs * 1000
    let text = ''
    do {
      text = await ev(`(()=>{const c=document.getElementById("workbench.panel.positronConsole"); return c? c.textContent.trim():"NO CONSOLE"})()`)
      if (String(text).includes(needle)) { console.log(`console contains "${needle}"`); break }
      await new Promise(r => setTimeout(r, 1500))
    } while (Date.now() < deadline)
    console.log(String(text).slice(-3000))
    break
  }
  case 'pick':
  case 'waitpick': {
    const wait = action === 'waitpick' ? Math.max(5, Number(args.pop()) || 20) : 0
    const needle = args.join(' ')
    const findRect = () => ev(`(()=>{
      const quick=[...document.querySelectorAll('.quick-input-widget .monaco-list-row')];
      const rows=quick.length?quick:[...document.querySelectorAll('.monaco-list-row')];
      const r=rows.find(x=>(x.textContent||'').includes(${JSON.stringify(needle)}));
      if(!r) return JSON.stringify({found:false, quickInput:!!document.querySelector('.quick-input-widget'), sample: rows.map(x=>(x.textContent||'').trim()).slice(0,12)});
      const b=r.getBoundingClientRect(); return JSON.stringify({found:true,x:b.x+b.width/2,y:b.y+b.height/2,t:r.textContent.trim().slice(0,60)})})()`)
    const deadline = Date.now() + wait * 1000
    let rect
    do {
      rect = JSON.parse(await findRect())
      if (rect.found) break
      await new Promise(r => setTimeout(r, 1000))
    } while (Date.now() < deadline)
    if (!rect.found) { console.error(`no row contains "${needle}" (quickInput=${rect.quickInput}); sample:`, rect.sample); process.exit(7) }
    await clickAt(rect.x, rect.y)
    await new Promise(r => setTimeout(r, 600))
    await pressEnter()
    console.log(`picked: ${rect.t}`)
    break
  }
  case 'clicktext': {
    const label = args.join(' ')
    const rect = JSON.parse(await ev(`(()=>{const all=[...document.querySelectorAll('a,button,[role=button],.monaco-button,.action-label')];
      const e=all.find(x=>(x.textContent||'').trim()===${JSON.stringify(label)});
      if(!e) return JSON.stringify({found:false, sample: all.map(x=>(x.textContent||'').trim()).filter(Boolean).slice(0,12)});
      const b=e.getBoundingClientRect(); return JSON.stringify({found:true,x:b.x+b.width/2,y:b.y+b.height/2,t:e.textContent.trim()})})()`))
    if (!rect.found) { console.error('no element with that exact text; sample:', rect.sample); process.exit(6) }
    await clickAt(rect.x, rect.y)
    console.log(`clicked: ${rect.t}`)
    break
  }
  case 'click': {
    const sel = args.join(' ')
    const rect = JSON.parse(await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});
      if(!e) return JSON.stringify({found:false});
      const b=e.getBoundingClientRect(); return JSON.stringify({found:true,x:b.x+b.width/2,y:b.y+b.height/2,t:e.textContent.trim().slice(0,40)})})()`))
    if (!rect.found) { console.error('selector matched nothing'); process.exit(5) }
    await clickAt(rect.x, rect.y)
    console.log(`clicked: ${rect.t}`)
    break
  }
  case 'inputstate': {
    // What does the console region look like right now? Useful for bounded diagnosis.
    console.log(await ev(`(()=>{const out={};
      out.consoleText=(document.getElementById("workbench.panel.positronConsole")||{}).textContent?.trim().slice(0,300)||'NO CONSOLE';
      out.quickInput=!!document.querySelector('.quick-input-widget');
      out.rows=[...document.querySelectorAll('.monaco-list-row')].map(x=>(x.textContent||'').trim()).filter(Boolean).slice(0,12);
      out.buttons=[...document.querySelectorAll('a,button,[role=button],.monaco-button,.action-label')].map(x=>(x.textContent||'').trim()).filter(Boolean).slice(0,15);
      return JSON.stringify(out)})()`))
    break
  }
  default: console.error(`unknown action: ${action}`); process.exit(2)
}
process.exit(0)
