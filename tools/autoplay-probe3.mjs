/**
 * autoplay-probe3.mjs —— 等加载真正结束，再逐步点击进入游戏
 * 判定「加载结束」：帧哈希变化率显著下降（进度条动画停止）
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/?autotest';
const OUT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun/.workbuddy/probe-out';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9349;
const profile = mkdtempSync(join(tmpdir(), 'cdp-ap3-'));
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

  const errs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      errs.push('EXC ' + String((m.params.exceptionDetails.exception || {}).description || '').slice(0, 160));
    }
  });

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 30000 });
    if (r.exceptionDetails) return { __err: String((r.exceptionDetails.exception || {}).description || '').slice(0, 200) };
    return r.result.value;
  };

  await S('Page.navigate', { url: URL_ });
  await sleep(1500);

  await evalJs(`
    window.__s = { hashes: [], last: null, changes: 0, frames: 0 };
    (function(){
      var mc = document.createElement('canvas'); mc.width = 48; mc.height = 48;
      var g = mc.getContext('2d');
      window.__s.probe = function(){
        var c = document.querySelector('canvas'); if (!c || !c.width) return null;
        try { g.drawImage(c, 0, 0, 48, 48); } catch(e){ return null; }
        var d = g.getImageData(0, 0, 48, 48).data, h = 0, bright = 0;
        for (var i = 0; i < d.length; i += 4) { h = (h * 31 + d[i] + d[i+1] * 3 + d[i+2] * 7) >>> 0; if (d[i]+d[i+1]+d[i+2] > 45) bright++; }
        return { h: h, bright: bright };
      };
      var _raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = function(cb){
        return _raf(function(t){ var r = cb(t);
          try { window.__s.frames++; var v = window.__s.probe(); if (v && v.h !== window.__s.last) { window.__s.last = v.h; window.__s.changes++; } } catch(e){}
          return r; });
      };
    })(); 'ok'`);

  await evalJs('document.getElementById("start-btn").click()');
  log('已点开始，等待加载（最多 240s）…');

  let prevChanges = 0, stableRounds = 0, loaded = false;
  for (let i = 0; i < 80; i++) {
    await sleep(3000);
    const st = await evalJs('(function(){var v=window.__s.probe()||{};return {ch:window.__s.changes,f:window.__s.frames,b:v.bright,t:(window.__redTargets||[]).length,ls:localStorage.length}})()');
    const rate = st.ch - prevChanges; prevChanges = st.ch;
    if (i % 5 === 0) log(`  t=${(i+1)*3}s ch=${st.ch}(+${rate}) f=${st.f} bright=${st.b} targets=${st.t}`);
    if (st.f > 200 && rate <= 2) { stableRounds++; } else { stableRounds = 0; }
    if (stableRounds >= 3) { loaded = true; log(`  画面已稳定 @${(i+1)*3}s`); break; }
  }
  if (!loaded) log('  !! 未检测到稳定画面，仍继续尝试');

  const shot0 = await S('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, 'p3-loaded.png'), Buffer.from(shot0.data, 'base64'));

  log('');
  log('=== 开始点击推进 ===');
  for (let step = 1; step <= 14; step++) {
    const b = await evalJs('(function(){var v=window.__s.probe()||{};return {ch:window.__s.changes,b:v.bright,t:(window.__redTargets||[]).length,tg:(window.__redTargets||[]).slice(0,3)}})()');
    await evalJs('window.__wxInjectTouch("start",0.5,0.5)');
    await sleep(90);
    await evalJs('window.__wxInjectTouch("end",0.5,0.5)');
    await sleep(2500);
    const a = await evalJs('(function(){var v=window.__s.probe()||{};return {ch:window.__s.changes,b:v.bright,t:(window.__redTargets||[]).length,tg:(window.__redTargets||[]).slice(0,3)}})()');
    log(`  步${step}: ch ${b.ch}->${a.ch}  bright ${b.b}->${a.b}  目标 ${b.t}->${a.t}  ${a.t ? JSON.stringify(a.tg) : ''}`);
    const s = await S('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `p3-step-${String(step).padStart(2, '0')}.png`), Buffer.from(s.data, 'base64'));
    if (errs.length) { log('    !', errs.slice(-1)); errs.length = 0; }
  }

  log('');
  log('=== localStorage（是否有新进度键）===');
  log(await evalJs('JSON.stringify((function(){var o={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);o[k]=(localStorage.getItem(k)||"").length;}return o})())'));

  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
