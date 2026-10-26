/**
 * 验证：① 活值 sysInfo ② 大幅 resize 自动重启。
 * 用法：node tools/cdp-verify-resize.mjs <outDir>
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2] || 'C:/temp/vres';
mkdirSync(OUT, { recursive: true });
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9337;
const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=900,900', '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--no-first-run', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required', 'about:blank'
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getWs() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); const j = await r.json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl; } catch (e) {}
    await sleep(300);
  }
  throw new Error('chrome 未就绪');
}
let id = 0; const pending = new Map(); let ws;
function send(method, params = {}, sessionId) {
  const msg = { id: ++id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  return new Promise((resolve, reject) => { pending.set(msg.id, { resolve, reject }); ws.send(JSON.stringify(msg)); });
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
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) { console.log('[eval-err]', r.exceptionDetails.text); return null; }
    return r.result.value;
  };
  const shot = async (name) => { const r = await S('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64')); console.log('shot:', name); };

  await S('Page.navigate', { url: 'http://127.0.0.1:8848/' });
  await sleep(3000);
  await evalJs('document.getElementById("start-btn") && document.getElementById("start-btn").click()');
  for (let i = 0; i < 40; i++) { await sleep(2000); if (await evalJs('(function(){var c=document.querySelector("canvas");return c&&c.width>100})()')) break; }
  await sleep(4000);
  await evalJs('window.__marker = 123; window.__gameBooted = true');  // 强制视为已启动以验证重载链路

  await S('Emulation.setFocusEmulationEnabled', { enabled: true });
  await S('Page.bringToFront', {});
  console.log('sysInfo@boot:', await evalJs('(function(){try{var s=GameGlobal.wx.getSystemInfoSync();return JSON.stringify({w:s.windowWidth,h:s.windowHeight,p:s.pixelRatio,sa:s.safeArea.width})}catch(e){return "ERR "+e.message}})()'));

  // 定时器活性自检
  console.log('timer-check:', await evalJs('(function(){return new Promise(function(res){var n=0;var t0=Date.now();var iv=setInterval(function(){n++;if(n>=5){clearInterval(iv);res("5 ticks in "+(Date.now()-t0)+"ms")}},100)})})()'));

  // 大幅 resize（>25% → 应触发自动重启）
  await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 620, deviceScaleFactor: 1, mobile: false });
  await sleep(1500);
  console.log('sysInfo@resize+1.5s:', await evalJs('(function(){try{var s=GameGlobal.wx.getSystemInfoSync();return JSON.stringify({w:s.windowWidth,h:s.windowHeight})}catch(e){return "ERR"}})()'));
  await sleep(6000);
  const marker = await evalJs('window.__marker || 0');
  console.log('marker after resize (0=已重启):', marker);
  await shot('after-reload.png');
  const canvasNow = await evalJs('(function(){var c=document.querySelector("canvas");return c?c.width+"x"+c.height:"none"})()');
  console.log('canvas after reload:', canvasNow);
  console.log('rrDbg:', await evalJs('JSON.stringify(window.__rrDbg||null)'));
  console.log('reload-flag:', await evalJs('(function(){try{return localStorage.getItem("wxshim.fs:__resizeReload")}catch(e){return "ERR"}})()'));
  console.log('resize-logs:', await evalJs('(window.__wxShimLogDump?window.__wxShimLogDump().split(String.fromCharCode(10)).filter(function(l){return l.indexOf("[resize]")>=0||l.indexOf("canvas sync")>=0||l.indexOf("resize-reload")>=0}).slice(-10).join(" ~~~ "):"none")'));
  console.log('docState:', await evalJs('JSON.stringify({hidden:document.hidden, vis:document.visibilityState, hasFocus:document.hasFocus()})'));
  console.log('ring:', ring);
  console.log('done ->', OUT);
  child.kill(); process.exit(0);
}
main().catch((e) => { console.error('FAIL', e.message); try { child.kill(); } catch (e2) {} process.exit(1); });
