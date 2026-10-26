/**
 * 推进到主城/军械库界面 → resize 对比，复现「图层错乱」。
 * 用法：node tools/cdp-city.mjs <outDir>
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2] || 'C:/temp/city';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9335;
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
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Page.enable');
  await S('Runtime.enable');

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return null;
    return r.result.value;
  };
  const shot = async (name) => {
    const r = await S('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'));
    console.log('shot:', name);
  };
  const tap = async (fx = 0.5, fy = 0.5) => {
    const r = await evalJs('(function(){var c=document.querySelector("canvas");var b=HTMLCanvasElement.prototype.getBoundingClientRect.call(c);return [Math.round(b.left+b.width*' + fx + '),Math.round(b.top+b.height*' + fy + ')]}())');
    if (!r) return;
    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r[0], y: r[1] }] });
    await sleep(80);
    await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  // 狙击：按住瞄准(开镜) → 保持 → 松开(射击)
  const snipe = async (fx = 0.5, fy = 0.5) => {
    const r = await evalJs('(function(){var c=document.querySelector("canvas");var b=HTMLCanvasElement.prototype.getBoundingClientRect.call(c);return [Math.round(b.left+b.width*' + fx + '),Math.round(b.top+b.height*' + fy + ')]}())');
    if (!r) return;
    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r[0], y: r[1] }] });
    await sleep(2200);
    await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(1500);
  };

  await S('Page.navigate', { url: 'http://127.0.0.1:8848/' });
  await sleep(3000);
  await evalJs('document.getElementById("start-btn") && document.getElementById("start-btn").click()');
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    if (await evalJs('(function(){var c=document.querySelector("canvas");return c&&c.width>100})()')) break;
  }
  await sleep(5000);

  // 推进：新手对局。按住-松开狙击左右靶，多轮
  for (let i = 0; i < 6; i++) {
    await snipe(0.33, 0.37);
    await snipe(0.72, 0.53);
    await shot('b' + i + '.png');
  }

  // 对局中可能有引导，点底部/中央推进
  for (let i = 0; i < 6; i++) {
    await tap(0.5, 0.85); await sleep(1500);
  }
  await shot('mid.png');

  // 对话/引导：反复点击推进，等进入主城（检测画面 UI 变化：持续点击 12 轮）
  for (let i = 0; i < 14; i++) {
    await tap(0.5, 0.14); await sleep(1200);
    await tap(0.5, 0.5); await sleep(1200);
    if (i % 3 === 2) await shot('d' + i + '.png');
  }
  await shot('after-settle.png');
  await sleep(4000);
  await shot('city.png');

  console.log('done ->', OUT);
  child.kill();
  process.exit(0);
}
main().catch((e) => { console.error('FAIL', e.message); try { child.kill(); } catch (e2) {} process.exit(1); });
