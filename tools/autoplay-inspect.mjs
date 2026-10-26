/**
 * autoplay-inspect.mjs —— 进入战斗后拍一张"干净"的高分辨率截图并切成四块
 *
 * 用途：面板会挡住右侧画面，且 900x900 下靶子只有几个像素。
 * 这里放大窗口、折叠面板、等真正进入战斗，再输出可直接肉眼看靶子的切片。
 *
 * 用法: node tools/autoplay-inspect.mjs [url]
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
const PORT = 9361;
const profile = mkdtempSync(join(tmpdir(), 'cdp-insp-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1280,1280', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
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

const NOISE = /ASTC6X6|decompressing texture|本地 bundle|Odin Serializer|report_fail|storage-probe|命中映射|dn-sdk/i;

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

  const t0c = Date.now();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      const a = (m.params.args || []).map((x) => (x.value !== undefined ? x.value : x.description)).join(' ');
      const s = String(a || '');
      if (!s || NOISE.test(s)) return;
      console.log(`   [+${Math.round((Date.now() - t0c) / 1000)}s]`, s.slice(0, 200));
    }
  });

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 60000 });
    if (r.exceptionDetails) return { __err: String((r.exceptionDetails.exception || {}).description || '').slice(0, 250) };
    return r.result.value;
  };
  const shot = async (name) => {
    const sh = await S('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, name + '.png'), Buffer.from(sh.data, 'base64'));
    return join(OUT, name + '.png');
  };

  await S('Page.navigate', { url: URL_ });
  await sleep(2500);
  await evalJs('document.getElementById("start-btn").click()');

  log('等待进入战斗…');
  for (let i = 0; i < 80; i++) {
    await sleep(3000);
    const st = await evalJs('window.AutoplayPerception.observe().metrics.avgLuma');
    if (i % 5 === 0) log(`  t=${(i + 1) * 3}s luma=${st}`);
    if (st > 178) { log(`  进入战斗 @ ${(i + 1) * 3}s`); break; }
    if (i % 2 === 0) await evalJs('window.__wxInjectTouch("start",0.5,0.5), window.__wxInjectTouch("end",0.5,0.5)');
  }
  await sleep(2000);

  // 折叠面板，让出画面
  await evalJs('(function(){var b=document.getElementById("ap-fold"); if(b) b.click(); return true})()');
  await sleep(600);
  const p1 = await shot('insp-full');
  log('已存', p1);
  log('canvas:', await evalJs('JSON.stringify({w:document.querySelector("canvas").width,h:document.querySelector("canvas").height,cw:document.querySelector("canvas").clientWidth,ch:document.querySelector("canvas").clientHeight})'));
  log('targets:', await evalJs('JSON.stringify(window.AutoplayPerception.observe().targets)'));

  try { child.kill(); } catch (e) {}
  await sleep(500);
  // 切片放大，方便肉眼看靶子
  try {
    execFileSync('C:/Users/11313/.workbuddy/binaries/python/envs/default/Scripts/python.exe', ['-c', `
from PIL import Image
im = Image.open(r'${OUT}/insp-full.png')
w,h = im.size
print('full', w, h)
tiles = {'tl':(0.0,0.30,0.55,0.70),'tr':(0.45,0.30,1.0,0.70),'mid':(0.30,0.38,0.75,0.62)}
for k,(x0,y0,x1,y1) in tiles.items():
    b=(int(x0*w),int(y0*h),int(x1*w),int(y1*h))
    im.crop(b).resize(((b[2]-b[0])*2,(b[3]-b[1])*2), Image.LANCZOS).save(r'${OUT}/insp-'+k+'.png')
    print('tile', k, b[2]-b[0], b[3]-b[1])
`], { stdio: 'inherit' });
  } catch (e) { log('切片失败', String(e).slice(0, 200)); }
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
