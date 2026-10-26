/**
 * DPR 变化探针：模拟 Windows 显示缩放 150% 下 resize，验证缓冲/样式/Unity 同步。
 * 用法：node tools/cdp-dpr.mjs <outDir>
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2] || 'C:/temp/dpr';
mkdirSync(OUT, { recursive: true });
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9336;
const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=884,805', '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--no-first-run', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required', 'about:blank'
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(300);
  }
  throw new Error('chrome 未就绪');
}
let id = 0; const pending = new Map(); let ws;
function send(method, params = {}, sessionId) {
  const msg = { id: ++id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    pending.set(msg.id, { resolve, reject });
    ws.send(JSON.stringify(msg));
  });
}
async function main() {
  ws = new WebSocket(await getWs());
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
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
  const shot = async (name) => {
    const r = await S('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'));
    console.log('shot:', name);
  };

  await S('Page.navigate', { url: 'http://127.0.0.1:8848/' });
  await sleep(3000);
  await evalJs('document.getElementById("start-btn") && document.getElementById("start-btn").click()');
  for (let i = 0; i < 40; i++) { await sleep(2000); if (await evalJs('(function(){var c=document.querySelector("canvas");return c&&c.width>100})()')) break; }
  await sleep(6000);
  await shot('1-base.png');
  console.log('base:', await evalJs('(function(){var c=document.querySelector("canvas");return JSON.stringify({iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio,cw:c.width,ch:c.height})})()'));

  // DPR 1.5 + 宽屏
  await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 620, deviceScaleFactor: 1.5, mobile: false });
  await sleep(3500);
  await shot('2-dpr15.png');
  console.log('dpr15:', await evalJs('(function(){var c=document.querySelector("canvas");var s=getComputedStyle(c);return JSON.stringify({iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio,cw:c.width,ch:c.height,style:[s.width,s.height]})})()'));

  // 等 3s 看巡检是否稳定
  await sleep(3000);
  console.log('stable:', await evalJs('(function(){var c=document.querySelector("canvas");return JSON.stringify({cw:c.width,ch:c.height})})()'));
  const ring = await evalJs('(window.__wxShimLogDump?window.__wxShimLogDump().split(String.fromCharCode(10)).filter(function(l){return l.indexOf("resize")>=0}).slice(-6).join(" ~~~ "):"none")');
  console.log('ring:', ring);

  child.kill(); process.exit(0);
}
main().catch((e) => { console.error('FAIL', e.message); try { child.kill(); } catch (e2) {} process.exit(1); });
