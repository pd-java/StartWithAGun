/**
 * probe-smoke.mjs —— 30 秒冒烟：确认打桩后的 wasm 能在页面里正常加载，
 * 并确认诊断计数器已经能从 JS 读到。
 *
 * 用法: node tools/probe-smoke.mjs [url] [seconds]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const SECS = Number(process.argv[3] || 30);
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9393;
const profile = mkdtempSync(join(tmpdir(), 'cdp-smoke-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1000,1000', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  'http://127.0.0.1:8848/robots.txt'
], { stdio: 'ignore' });
process.on('exit', () => { try { child.kill(); } catch (e) {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); const j = await r.json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl; } catch (e) {}
    await sleep(300);
  }
  throw new Error('chrome 未就绪');
}
let id = 0; const pending = new Map(); let ws;
function send(m, p = {}, sid) {
  const msg = { id: ++id, method: m, params: p }; if (sid) msg.sessionId = sid;
  return new Promise((res, rej) => { pending.set(msg.id, { resolve: res, reject: rej }); ws.send(JSON.stringify(msg)); });
}

const msgs = [];
async function main() {
  ws = new WebSocket(await getWs());
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const a = (m.params.args || []).map((x) => (x.value !== undefined ? x.value : x.description)).join(' ');
      const s = String(a || '');
      if (/error|fail|fail|Compile|Link|wasm|instantiate|dbg|实例化|桩/i.test(s)) msgs.push(s.slice(0, 200));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      msgs.push('EXCEPTION ' + String(m.params.exceptionDetails?.exception?.description || '').slice(0, 300));
    }
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Page.enable'); await S('Runtime.enable');
  const ev = async (e) => {
    const r = await S('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, timeout: 60000 });
    if (r.exceptionDetails) return 'ERR ' + String(r.exceptionDetails.exception?.description || '').slice(0, 160);
    return r.result.value;
  };

  await S('Page.navigate', { url: URL_ });
  await sleep(3000);
  await ev('(function(){var b=document.getElementById("start-btn"); if(b) b.click(); return 1})()');

  for (let i = 0; i < Math.ceil(SECS / 5); i++) {
    await sleep(5000);
    const st = await ev('JSON.stringify({p:typeof window.AutoplayPerception, main:!!window.__wasmMainExports, split:!!(window.GameGlobal&&GameGlobal.__wasmCode1Instance), dbg:(function(){try{var o=window.__wasmMainExports;return o?Object.keys(o).filter(function(k){return /_in$|_BR_|_PT_/.test(k)}).length:0}catch(e){return -1}})()})');
    console.log(`t=${(i + 1) * 5}s`, st);
  }
  const v = await ev('JSON.stringify(window.__dbg ? window.__dbg() : null)');
  console.log('counters:', String(v).slice(0, 600));
  console.log('\n--- 相关 console 消息 ---');
  msgs.slice(-25).forEach((m) => console.log('  ' + m));
  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
