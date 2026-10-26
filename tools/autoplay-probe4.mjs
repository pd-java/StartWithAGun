/**
 * autoplay-probe4.mjs —— 真实输入 vs 注入输入 对照
 * 目的：判断「点不动」是输入路径问题，还是游戏自身卡在该界面。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/?autotest';
const OUT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun/.workbuddy/probe-out';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9351;
const profile = mkdtempSync(join(tmpdir(), 'cdp-ap4-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=900,900', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  'http://127.0.0.1:8848/robots.txt'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

async function getWs() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); const j = await r.json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl; } catch (e) {}
    await sleep(300);
  }
  throw new Error('chrome 未就绪');
}
let id = 0; const pending = new Map(); let ws;
function send(method, params = {}, sessionId) {
  const msg = { id: ++id, method, params }; if (sessionId) msg.sessionId = sessionId;
  return new Promise((res, rej) => { pending.set(msg.id, { resolve: res, reject: rej }); ws.send(JSON.stringify(msg)); });
}

async function main() {
  ws = new WebSocket(await getWs());
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Page.enable'); await S('Runtime.enable');

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 30000 });
    if (r.exceptionDetails) return { __err: String((r.exceptionDetails.exception || {}).description || '').slice(0, 200) };
    return r.result.value;
  };

  await S('Page.navigate', { url: URL_ });
  await sleep(1500);
  await evalJs(`
    window.__s={changes:0,frames:0,last:null};
    (function(){var mc=document.createElement('canvas');mc.width=48;mc.height=48;var g=mc.getContext('2d');
     function h(){var c=document.querySelector('canvas');if(!c||!c.width)return null;try{g.drawImage(c,0,0,48,48);}catch(e){return null}
       var d=g.getImageData(0,0,48,48).data,x=0;for(var i=0;i<d.length;i+=4)x=(x*31+d[i]+d[i+1]*3+d[i+2]*7)>>>0;return x}
     window.__s.h=h;
     var _raf=window.requestAnimationFrame.bind(window);
     window.requestAnimationFrame=function(cb){return _raf(function(t){var r=cb(t);try{window.__s.frames++;var v=h();if(v!==null&&v!==window.__s.last){window.__s.last=v;window.__s.changes++}}catch(e){}
       return r})}})();'ok'`);
  await evalJs('document.getElementById("start-btn").click()');
  log('开始加载，等 50s…');
  await sleep(50000);

  const state = async () => evalJs('(function(){return {ch:window.__s.changes,f:window.__s.frames,h:window.__s.h&&window.__s.h(),tg:(window.__redTargets||[]).length}})()');
  const rect = await evalJs('(function(){var c=document.querySelector("canvas");var r=c.getBoundingClientRect();return {l:r.left,t:r.top,w:r.width,h:r.height}})()');
  log('canvas rect:', JSON.stringify(rect));

  const cx = rect.l + rect.w * 0.5;
  const cy = rect.t + rect.h * 0.5;

  log('');
  log('=== A) 真实鼠标输入（CDP Input.dispatchMouseEvent）===');
  let b = await state();
  log('  前:', JSON.stringify(b));
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none', buttons: 0 });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(90);
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(2500);
  log('  后:', JSON.stringify(await state()));
  let s = await S('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, 'p4-real-mouse.png'), Buffer.from(s.data, 'base64'));

  log('');
  log('=== B) 真实触摸输入（CDP Input.dispatchTouchEvent）===');
  b = await state();
  log('  前:', JSON.stringify(b));
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy, id: 1 }] });
  await sleep(90);
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(2500);
  log('  后:', JSON.stringify(await state()));
  s = await S('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, 'p4-real-touch.png'), Buffer.from(s.data, 'base64'));

  log('');
  log('=== C) 注入输入（__wxInjectTouch）===');
  b = await state();
  log('  前:', JSON.stringify(b));
  log('  handlers:', JSON.stringify(await evalJs('window.__wxTouchHandlerCount&&window.__wxTouchHandlerCount()')));
  await evalJs('window.__wxInjectTouch("start",0.5,0.5)');
  await sleep(90);
  await evalJs('window.__wxInjectTouch("end",0.5,0.5)');
  await sleep(2500);
  log('  后:', JSON.stringify(await state()));

  log('');
  log('=== 诊断：shim 日志里与触摸/加载相关的行 ===');
  log(await evalJs('(function(){var d=window.__wxShimLogDump?window.__wxShimLogDump().split("\\n"):[];var pick=d.filter(function(l){return /tap|touch|load|Addressables|ready|hideLoading|progress|error/i.test(l)});return pick.slice(-20).join("\\n")})()'));

  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
