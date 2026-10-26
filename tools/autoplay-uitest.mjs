/**
 * autoplay-uitest.mjs —— 用 UI 控件验证「输入到底进不进得了游戏」
 *
 * 思路：比瞄准/射击容易判定的多。画面左上角有一个齿轮（设置）图标，
 * 点它如果弹出设置面板，就是一次巨大的全局视觉变化 —— 这是输入链路是通的铁证。
 * 反之，如果点齿轮毫无反应，那问题就不在射击逻辑，而在注入链路本身。
 *
 * 依次测试：
 *   U1 齿轮 (0.035, 0.045)  —— 期望弹出设置面板
 *   U2 空点 (0.30, 0.20)    —— 负对照
 *   U3 齿轮 再点一次（关闭）—— 期望面板消失
 *
 * 用法: node tools/autoplay-uitest.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const OUT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun/.workbuddy/probe-out';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9371;
const profile = mkdtempSync(join(tmpdir(), 'cdp-ui-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1000,1000', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  'http://127.0.0.1:8848/robots.txt'
], { stdio: 'ignore' });
process.on('exit', () => { try { child.kill(); } catch (e) {} });

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
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 60000 });
    if (r.exceptionDetails) return { __err: String((r.exceptionDetails.exception || {}).description || '').slice(0, 250) };
    return r.result.value;
  };
  const shot = async (name) => {
    const sh = await S('Page.captureScreenshot', { format: 'png' });
    const p = join(OUT, name + '.png');
    writeFileSync(p, Buffer.from(sh.data, 'base64'));
    return p;
  };
  const tap = (x, y) => evalJs(`window.__wxInjectTouch("start",${x},${y}), window.__wxInjectTouch("end",${x},${y})`);
  const hold = (x, y, ms) => evalJs(`(function(){
    var I = window.AutoplayInput;
    return new Promise(function(res){ I.press(${x},${y}); setTimeout(function(){ I.release(${x},${y}); res(true); }, ${ms}); });
  })()`);

  await S('Page.navigate', { url: URL_ });
  await sleep(2500);
  await evalJs('document.getElementById("start-btn").click()');

  log('等待进入战斗…');
  for (let i = 0; i < 80; i++) {
    await sleep(3000);
    const l = await evalJs('window.AutoplayPerception.observe().metrics.avgLuma');
    if (i % 5 === 0) log(`  t=${(i + 1) * 3}s luma=${l}`);
    if (l > 178) { log(`  进入战斗 @ ${(i + 1) * 3}s`); break; }
    if (i % 2 === 0) await evalJs('window.__wxInjectTouch("start",0.5,0.5), window.__wxInjectTouch("end",0.5,0.5)');
  }
  await evalJs('(function(){var b=document.getElementById("ap-fold"); if(b) b.click(); return 1})()');
  await sleep(22000);

  log('');
  log('触摸处理器数量: ' + (await evalJs('JSON.stringify(window.__wxTouchHandlerCount ? window.__wxTouchHandlerCount() : null)')));

  const files = [];
  files.push(await shot('ui-00-base'));

  log('');
  log('=== U1：点左上齿轮 (0.035, 0.045) ===');
  await tap(0.035, 0.045);
  await sleep(1400);
  files.push(await shot('ui-01-gear-tap'));

  log('=== U2：按住齿轮 500ms ===');
  await hold(0.035, 0.045, 500);
  await sleep(1400);
  files.push(await shot('ui-02-gear-hold'));

  log('=== U3：点空白区 (0.30, 0.20) 负对照 ===');
  await tap(0.30, 0.20);
  await sleep(1400);
  files.push(await shot('ui-03-blank'));

  log('=== U4：再点齿轮（若面板已打开应关闭）===');
  await tap(0.035, 0.045);
  await sleep(1400);
  files.push(await shot('ui-04-gear-again'));

  // 全部原始真实点击（直接走 CDP Input）作为对照：绕过 shim
  log('=== U5：CDP 原生鼠标点击齿轮（绕过 shim）===');
  const box = await evalJs('JSON.stringify((function(){var c=document.querySelector("canvas");var r=c.getBoundingClientRect();return {l:r.left,t:r.top,w:r.width,h:r.height}})())');
  log('  canvas rect = ' + box);
  try {
    const b = JSON.parse(box);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await S('Input.dispatchMouseEvent', {
        type, x: b.l + b.w * 0.035, y: b.t + b.h * 0.045,
        button: 'left', clickCount: 1, pointerType: 'mouse'
      });
      await sleep(120);
    }
  } catch (e) { log('  CDP 点击失败: ' + String(e).slice(0, 120)); }
  await sleep(1400);
  files.push(await shot('ui-05-cdp-gear'));

  log('');
  log('=== 画面差分（与基线比，数值越大变化越明显）===');
  try {
    execFileSync('C:/Users/11313/.workbuddy/binaries/python/envs/default/Scripts/python.exe', ['-c', `
from PIL import Image
import numpy as np
import glob, os
base = r'${OUT}/ui-00-base.png'
B = np.asarray(Image.open(base).convert('RGB'), dtype=np.int16)
for f in sorted(glob.glob(r'${OUT}/ui-0*.png')):
    if f.endswith('ui-00-base.png'): continue
    A = np.asarray(Image.open(f).convert('RGB'), dtype=np.int16)
    if A.shape != B.shape:
        print(os.path.basename(f), 'size mismatch', A.shape, B.shape); continue
    d = np.abs(A - B).sum(axis=2)
    print('%-24s mean=%6.2f  >30px=%6.2f%%' % (os.path.basename(f), d.mean(), (d > 30).mean() * 100))
`], { stdio: 'inherit' });
  } catch (e) { log('差分失败: ' + String(e).slice(0, 160)); }

  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
