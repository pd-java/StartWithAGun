/**
 * 深度探针：推进游戏到主城界面 → 截图 → resize → 截图，用于复现「图层错乱」。
 *
 * 用法：node tools/cdp-deep.mjs <outDir> [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2] || 'C:/temp/deep';
const URL_ = process.argv[3] || 'http://127.0.0.1:8848/';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334;
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

let id = 0;
const pending = new Map();
let ws;
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
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const txt = (m.params.args || []).map((a) => a.value || a.description || '').join(' ');
      if (txt) console.log('[err]', txt.slice(0, 260));
    }
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Page.enable');
  await S('Runtime.enable');

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      console.log('[eval-err]', (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 300));
      return null;
    }
    return r.result.value;
  };
  const shot = async (name) => {
    const r = await S('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'));
    console.log('shot:', name);
  };

  await S('Page.navigate', { url: URL_ });
  await sleep(3000);
  await evalJs('document.getElementById("start-btn") && document.getElementById("start-btn").click()');

  // 等 canvas 起来
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const st = await evalJs('(function(){var c=document.querySelector("canvas");return c&&c.width>100})()');
    if (st) break;
  }
  await sleep(6000);

  // 在 canvas 中心模拟触摸（登录/跳过启动页）
  const tap = async (fx = 0.5, fy = 0.5) => {
    const r = await evalJs('(function(){var c=document.querySelector("canvas");var b=c.getBoundingClientRect();return [Math.round(b.left+b.width*' + fx + '),Math.round(b.top+b.height*' + fy + ')]}())');
    if (!r) return;
    const [x, y] = r;
    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await sleep(90);
    await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };

  // 等启动页加载完（spinner 消失可能较慢），每 12s 点一次推进
  for (let i = 0; i < 8; i++) {
    await sleep(12000);
    await tap();
    await shot('0' + (i + 1) + '-step' + i + '.png');
    const boot = await evalJs('(function(){var c=document.querySelector("canvas");return c.width+"x"+c.height+" booted="+String(!!window.__gameBooted)})()');
    console.log('step', i, boot);
    if (i >= 2) { /* 后面几轮继续点，尽量推进 */ }
  }

  // resize 到宽扁
  await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 620, deviceScaleFactor: 1, mobile: false });
  await sleep(4000);
  await shot('04-after-resize.png');
  await sleep(4000);
  await shot('05-after-resize-8s.png');

  // 再 resize 回竖长
  await S('Emulation.setDeviceMetricsOverride', { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(4000);
  await shot('06-back-tall.png');

  console.log('state:', await evalJs('(function(){var c=document.querySelector("canvas");var cs=getComputedStyle(c);return JSON.stringify({iw:innerWidth,ih:innerHeight,cw:c.width,ch:c.height,rstyle:[cs.width,cs.height,cs.left,cs.top],booted:!!window.__gameBooted})})()'));
  console.log('done ->', OUT);
  child.kill();
  process.exit(0);
}
main().catch((e) => { console.error('FAIL', e.message); try { child.kill(); } catch (e2) {} process.exit(1); });
