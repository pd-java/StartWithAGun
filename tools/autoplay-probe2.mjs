/**
 * autoplay-probe2.mjs —— 验证输入注入接口 + 走通「启动→主界面」
 *
 * 关键验证点：
 *  1) game 是否注册了 touch handler（__wxTouchHandlerCount）
 *  2) __wxInjectTouch 能否驱动游戏（画面状态变化 + 崩溃消失）
 *  3) 画面状态用 rAF 内采样哈希判断（WebGL 无 preserveDrawingBuffer，帧外读画布为黑）
 *  4) 逐步点击推进流程并记录每阶段 localStorage
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/?autotest';
const OUT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun/.workbuddy/probe-out';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9347;
const profile = mkdtempSync(join(tmpdir(), 'cdp-ap2-'));
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

  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const t = (m.params.args || []).map((a) => a.value || a.description || '').join(' ');
      if (t) errors.push(t.slice(0, 200));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push('EXC ' + String((m.params.exceptionDetails.exception || {}).description || '').slice(0, 200));
    }
  });

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 30000 });
    if (r.exceptionDetails) return { __err: String((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text || '').slice(0, 300) };
    return r.result.value;
  };

  await S('Page.navigate', { url: URL_ });
  await sleep(1500);

  // 装采样器：在 rAF 内读画布（WebGL 帧外为黑）
  await evalJs(`
    window.__s = { hashes: [], last: null, changes: 0, frames: 0 };
    (function(){
      var mc = document.createElement('canvas'); mc.width = 48; mc.height = 48;
      var g = mc.getContext('2d');
      function hash(){
        var c = document.querySelector('canvas'); if (!c || !c.width) return null;
        try { g.drawImage(c, 0, 0, 48, 48); } catch(e){ return null; }
        var d = g.getImageData(0, 0, 48, 48).data, h = 0, bright = 0;
        for (var i = 0; i < d.length; i += 4) { h = (h * 31 + d[i] + d[i+1] * 3 + d[i+2] * 7) >>> 0; if (d[i]+d[i+1]+d[i+2] > 45) bright++; }
        return { h: h, bright: bright };
      }
      window.__s.hashNow = hash;
      var _raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = function(cb){
        return _raf(function(t){
          var r = cb(t);
          try {
            window.__s.frames++;
            var v = hash();
            if (v && v.h !== window.__s.last) { window.__s.last = v.h; window.__s.changes++; window.__s.hashes.push(v.h); if (window.__s.hashes.length > 30) window.__s.hashes.shift(); }
          } catch(e){}
          return r;
        });
      };
    })(); 'ok'`);

  await evalJs('document.getElementById("start-btn").click()');
  log('已点开始，等待加载…');

  // 等待 canvas + rAF 起转
  for (let i = 0; i < 80; i++) {
    await sleep(2000);
    const st = await evalJs('(function(){var c=document.querySelector("canvas");return {w:c&&c.width,frames:window.__s.frames,ch:window.__s.changes,hs:window.__wxTouchHandlerCount?window.__wxTouchHandlerCount():null}})()');
    if (i % 4 === 0) log(`  t=${(i+1)*2}s`, JSON.stringify(st));
    if (st && st.w > 1 && st.frames > 30) break;
  }

  log('');
  log('=== touch handler 注册情况 ===');
  log(JSON.stringify(await evalJs('window.__wxTouchHandlerCount ? window.__wxTouchHandlerCount() : "no-api"')));
  log('注入接口存在:', await evalJs('typeof window.__wxInjectTouch'));

  log('');
  log('=== 逐阶段点击推进（每步：点中心 → 观察变化）===');
  for (let step = 1; step <= 10; step++) {
    const before = await evalJs('(function(){return {changes:window.__s.changes, frames:window.__s.frames, bright:(window.__s.hashNow()||{}).bright, targets:(window.__redTargets||[]).length}})()');
    const n = await evalJs('window.__wxInjectTouch("start", 0.5, 0.5)');
    await sleep(80);
    await evalJs('window.__wxInjectTouch("end", 0.5, 0.5)');
    await sleep(1800);
    const after = await evalJs('(function(){return {changes:window.__s.changes, frames:window.__s.frames, bright:(window.__s.hashNow()||{}).bright, targets:(window.__redTargets||[]).length}})()');
    log(`  步${step}: 注入处理器数=${n} 变化前=${before.changes} 后=${after.changes} 帧=${after.frames} 亮度=${before.bright}->${after.bright} 目标=${before.targets}->${after.targets}`);

    const shot = await S('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `step-${String(step).padStart(2, '0')}.png`), Buffer.from(shot.data, 'base64'));

    if (errors.length) { log('    错误:', errors.slice(-2)); errors.length = 0; }
  }

  log('');
  log('=== 最终 localStorage ===');
  log(await evalJs('JSON.stringify((function(){var o={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);o[k]=(localStorage.getItem(k)||"").length;}return o})())'));

  log('');
  log('=== 最终诊断日志（尾部 15 行）===');
  log(await evalJs('(window.__wxShimLogDump?window.__wxShimLogDump().split("\\n").slice(-15).join("\\n"):"none")'));

  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
