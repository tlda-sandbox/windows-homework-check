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
const pages = tg.result.targetInfos.filter(x => x.type === 'page')
const page = pages.find(x => x.url.startsWith('vscode-file:')) || pages.find(x => x.title.includes('Positron')) || pages[0]
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
  case 'preview': {
    const filename = args[0]
    if (!filename) { console.error('preview requires the expected HTML filename'); process.exit(17) }
    const deadline = Date.now() + (Number(args[1]) || 90) * 1000
    const minimumImages = Number(args[2] ?? 1)
    const sessions = new Map()
    const observed = new Map()
    const expected = value => value?.hasDocument && decodeURIComponent(new URL(value.url).pathname).endsWith('/' + filename)
    const bounded = (method, params = {}, session) => Promise.race([
      send(method, params, session),
      new Promise((_, reject) => setTimeout(() => reject(new Error('CDP timed out: ' + method)), 3000))
    ])
    do {
      const infos = (await bounded('Target.getTargets')).result.targetInfos
      for (const target of infos.filter(t => ['page', 'iframe', 'webview', 'other'].includes(t.type))) {
        try {
          if (!sessions.has(target.targetId)) {
            sessions.set(target.targetId, (await bounded('Target.attachToTarget', { targetId: target.targetId, flatten: true })).result?.sessionId)
          }
          const child = sessions.get(target.targetId)
          if (!child) continue
          const tree = await bounded('Page.getFrameTree', {}, child)
          const frames = []
          const walk = node => { if (!node) return; frames.push(node.frame); for (const c of node.childFrames || []) walk(c) }
          walk(tree.result?.frameTree)
          for (const frame of frames) {
            const contextId = (await bounded('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'homework-preview-check' }, child)).result?.executionContextId
            if (!contextId) continue
            const result = await bounded('Runtime.evaluate', {
              contextId, returnByValue: true,
              expression: `(()=>{
                const main=document.getElementById('quarto-document-content');
                if(!main) return {url:location.href,ready:false,title:document.title};
                const images=[...main.querySelectorAll('img')].map(e=>({src:e.getAttribute('src'),complete:e.complete,width:e.naturalWidth}));
                const mathCount=main.querySelectorAll('.katex,mjx-container,.MathJax').length;
                const rect=main.getBoundingClientRect();
                return {
                  url:location.href,title:document.title,hasDocument:true,heading:main.querySelector('h1')?.textContent,
                  ready:document.readyState==='complete' && rect.width>0 && rect.height>0 &&
                    images.length>=${minimumImages} && images.every(e=>e.complete && e.width>0) && mathCount>0,
                  images,mathCount,mathErrors:[...main.querySelectorAll('.katex-error,merror')].map(e=>e.textContent),
                  text:main.innerText.slice(0,700)
                };
              })()`
            }, child)
            const value = result.result?.result?.value
            if (value) observed.set(frame.id, value)
            if (value?.ready && expected(value)) {
              if (value.mathErrors.length) { console.error(JSON.stringify(value)); process.exit(19) }
              console.log(JSON.stringify(value))
              process.exit(0)
            }
          }
        } catch (error) {
          observed.set(target.targetId, {target:target.url,error:String(error)})
        }
      }
      await new Promise(r => setTimeout(r, 1000))
    } while (Date.now() < deadline)
    const samples = [...observed.values()]
    console.error('Native Preview did not display the expected homework: ' + JSON.stringify(samples))
    if (!samples.some(value => typeof value.ready === 'boolean')) process.exit(18)
    process.exit(samples.some(expected) ? 20 : 17)
  }
  case 'visual-eval': {
    const infos = (await send('Target.getTargets')).result.targetInfos
    for (const target of infos.filter(t => ['page', 'iframe'].includes(t.type))) {
      const child = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).result?.sessionId
      if (!child) continue
      const tree = await send('Page.getFrameTree', {}, child)
      const frames = []
      const walk = node => { if (!node) return; frames.push(node.frame); for (const c of node.childFrames || []) walk(c) }
      walk(tree.result?.frameTree)
      for (const frame of frames) {
        const contextId = (await send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'hw5-visual-inspection' }, child)).result?.executionContextId
        if (!contextId) continue
        const probe = await send('Runtime.evaluate', { contextId, returnByValue: true, expression: "!!document.querySelector('.ProseMirror,.pm-code-editor')" }, child)
        if (!probe.result?.result?.value) continue
        const result = await send('Runtime.evaluate', { contextId, returnByValue: true, awaitPromise: true, expression: args.join(' ') }, child)
        if (result.result?.exceptionDetails) { console.error(JSON.stringify(result.result.exceptionDetails)); process.exit(16) }
        console.log(JSON.stringify(result.result?.result?.value))
        process.exit(0)
      }
    }
    console.error('Visual editor DOM not found')
    process.exit(16)
  }
  case 'visual-code': {
    const infos = (await send('Target.getTargets')).result.targetInfos
    const inspected = []
    for (const target of infos.filter(t => ['page', 'iframe'].includes(t.type))) {
      const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
      const child = attached.result?.sessionId
      if (!child) continue
      const tree = await send('Page.getFrameTree', {}, child)
      const frames = []
      const walk = node => { if (!node) return; frames.push(node.frame); for (const c of node.childFrames || []) walk(c) }
      walk(tree.result?.frameTree)
      for (const frame of frames) {
        const world = await send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'hw5-dom-check' }, child)
        const contextId = world.result?.executionContextId
        if (!contextId) continue
        const result = await send('Runtime.evaluate', {
          contextId, returnByValue: true, awaitPromise: true,
          expression: `(async()=>{
            const cells=[...document.querySelectorAll('.CodeMirror, .cm-editor, .ace_editor, pre')];
            const cell=cells.find(e=>(e.innerText||e.textContent||'').includes(${JSON.stringify(args[0] || 'library.files')}));
            if(!cell) return {found:false,url:location.href,sample:document.body?.innerText.slice(0,300),classes:[...new Set([...document.querySelectorAll('[contenteditable],textarea')].map(e=>e.className))]};
            cell.scrollIntoView({block:'center'});
            await new Promise(r=>setTimeout(r,1000));
            const input=(cell.closest('.pm-code-editor')||cell).querySelector('textarea,[contenteditable=true]');
            if(!input) return {found:false,reason:'R block has no editor input',html:cell.outerHTML.slice(0,1500)};
            input.focus();
            return {found:true,url:location.href,cell:cell.className,input:input.tagName,text:cell.innerText.slice(0,250)};
          })()`
        }, child)
        const value = result.result?.result?.value
        inspected.push(value || result.error || result.result?.exceptionDetails)
        if (value?.found) {
          await send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 39, key: 'ArrowRight', code: 'ArrowRight' }, child)
          await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 39, key: 'ArrowRight', code: 'ArrowRight' }, child)
          await new Promise(r => setTimeout(r, 1000))
          console.log(JSON.stringify(value)); process.exit(0)
        }
      }
    }
    console.error(JSON.stringify(inspected)); process.exit(15)
  }
  case 'requireexpr': {
    const secs = Math.max(1, Number(args.pop()) || 30)
    const expression = args.join(' ')
    const deadline = Date.now() + secs * 1000
    do {
      if (await ev(expression) === true) { console.log('Required IDE condition observed'); process.exit(0) }
      await new Promise(r => setTimeout(r, 500))
    } while (Date.now() < deadline)
    console.error('Required IDE condition was not observed: ' + expression)
    process.exit(13)
  }
  case 'command': {
    const label = args.join(' ')
    await send('Page.bringToFront', {}, sid)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 10, windowsVirtualKeyCode: 80, key: 'P', code: 'KeyP' }, sid)
    await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 10, windowsVirtualKeyCode: 80, key: 'P', code: 'KeyP' }, sid)
    await new Promise(r => setTimeout(r, 800))
    await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, windowsVirtualKeyCode: 65, key: 'A', code: 'KeyA' }, sid)
    await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, windowsVirtualKeyCode: 65, key: 'A', code: 'KeyA' }, sid)
    await send('Input.insertText', { text: '>' + label }, sid)
    const deadline = Date.now() + 30000
    let rect
    do {
      rect = await ev(`(()=>{const r=[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].find(r=>r.innerText.includes(${JSON.stringify(label)})); if(!r) return null; const b=r.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2}})()`)
      if (rect && typeof rect === 'object') break
      await new Promise(r => setTimeout(r, 500))
    } while (Date.now() < deadline)
    if (!rect || typeof rect !== 'object') { console.error('Required IDE command was not offered: ' + label); process.exit(12) }
    await pressEnter()
    console.log('Selected IDE command: ' + label)
    break
  }
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
    await send('Page.bringToFront', {}, sid)
    const rect = JSON.parse(await ev(`(()=>{
      const root=document.getElementById('workbench.panel.positronConsole');
      const scoped=[...root.querySelectorAll('.console-input:not(.hidden) .native-edit-context, .console-input:not(.hidden) textarea.inputarea')];
      const t=scoped.find(i=>i.offsetParent);
      if(!t) return JSON.stringify({found:false});
      t.focus();
      const b=t.getBoundingClientRect();
      return JSON.stringify({found:true,x:b.x+b.width/2,y:b.y+b.height/2,cls:t.className.slice(0,60),id:t.closest('[id]')?.id||''})})()`))
    if (!rect.found) { console.error('no console input found'); process.exit(8) }
    console.error(`# console input: ${rect.cls} (${rect.id})`)
    await new Promise(r => setTimeout(r, 500))
    await new Promise(r => setTimeout(r, 400))
    const focused = await ev(`(()=>{const root=document.getElementById('workbench.panel.positronConsole'); const t=[...root.querySelectorAll('.console-input:not(.hidden) .native-edit-context, .console-input:not(.hidden) textarea.inputarea')].find(t=>t.offsetParent); if(!t) return false; t.focus(); return document.activeElement===t})()`)
    if (!focused) { console.error('R console input did not receive focus'); process.exit(8) }
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
