/**
 * autoplay-kill-probe.mjs —— 最小决定性验证：按住释放能不能打掉那个暗点
 *
 * 放弃"目标检测"这条路（布景太多，怎么排都会排到混凝土墩）。
 * 改用最稳的特征：**沙地里最暗的那个点**（靶子 lum≈42，沙地 lum≈200，对比度极大）。
 *
 * 步骤：
 *   1. rAF 后缓存 400 宽帧，在 y 0.40~0.60 / x 0.15~0.85 内找最暗点 → 视为靶子
 *   2. 记录该点周围 ±0.02 小方框的**平均亮度**（靶子在=暗，靶子没了=变亮）
 *   3. 依次试：快速点击 / 按住 400ms 释放 / 按住 900ms 释放 / 按住 1800ms 释放
 *   4. 每次之后重新测量同一小方框的亮度
 *
 * 判据：方框平均亮度从 ~40-80 跳到 ~180+ ⇒ 靶子被打掉了。
 *
 * 用法: node tools/autoplay-kill-probe.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const OUT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun/.workbuddy/probe-out';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9375;
const profile = mkdtempSync(join(tmpdir(), 'cdp-kill-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1000,1000', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  'http://127.0.0.1:8848/robots.txt'
], { stdio: 'ignore' });
process.on('exit', () => { try { child.kill(); } catch (e) {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const NOISE = /ASTC6X6|decompressing texture|本地 bundle|Odin Serializer|report_fail|storage-probe|命中映射|dn-sdk|glCreateShader|SoftMask|referenced script|Shader |Convex Mesh|kinematic body|RectTransform is being set|memorysetup|RemoteConfig|DeserializedConfiguration|Time set to|cloud-store|CloudStorage|PLUGIN|GameSessionTimeReporter/i;

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

const HOOK = `
window.__hi = null;
(function () {
  if (window.__hiHooked) return; window.__hiHooked = true;
  var _raf = window.requestAnimationFrame.bind(window);
  var W = 400, H = 0, b = document.createElement('canvas');
  var x = b.getContext('2d', { willReadFrequently: true });
  window.requestAnimationFrame = function (cb) {
    return _raf(function (t) {
      var r; try { r = cb(t); } catch (e) { r = undefined; }
      try {
        var c = document.querySelector('canvas');
        if (c && c.width > 1) {
          H = Math.max(1, Math.round(W * c.height / c.width));
          if (b.width !== W || b.height !== H) { b.width = W; b.height = H; }
          x.drawImage(c, 0, 0, W, H);
          window.__hi = { t: Math.round(performance.now()), w: W, h: H, data: x.getImageData(0, 0, W, H).data };
        }
      } catch (e) {}
      return r;
    });
  };
})();

/** 在沙地范围内找最暗点；返回归一化坐标与该点亮度 */
window.__darkest = function () {
  var F = window.__hi; if (!F) return null;
  var W = F.w, H = F.h, d = F.data;
  var y0 = Math.floor(0.40*H), y1 = Math.floor(0.60*H);
  var x0 = Math.floor(0.15*W), x1 = Math.floor(0.85*W);
  var best = 1e9, bx = -1, by = -1;
  for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) {
    var i = (y*W+x)*4;
    var lum = d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114;
    if (lum < best) { best = lum; bx = x; by = y; }
  }
  if (bx < 0) return null;
  return { x: Math.round(bx/W*10000)/10000, y: Math.round(by/H*10000)/10000, lum: Math.round(best) };
};

/** 指定归一化方框内的平均亮度 */
window.__boxLuma = function (cx, cy, rad) {
  var F = window.__hi; if (!F) return -1;
  var W = F.w, H = F.h, d = F.data;
  var xa = Math.max(0, Math.floor((cx-rad)*W)), xb = Math.min(W, Math.ceil((cx+rad)*W));
  var ya = Math.max(0, Math.floor((cy-rad)*H)), yb = Math.min(H, Math.ceil((cy+rad)*H));
  var s = 0, n = 0;
  for (var y = ya; y < yb; y++) for (var x = xa; x < xb; x++) {
    var i = (y*W+x)*4;
    s += d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114; n++;
  }
  return n ? Math.round(s/n) : -1;
};
'ok'`;

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
  const tutLog = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      const a = (m.params.args || []).map((x) => (x.value !== undefined ? x.value : x.description)).join(' ');
      const s = String(a || '');
      if (!s || NOISE.test(s)) return;
      if (/TUTORIAL_SEQUENCE|HealthComponents|GotoNextLevel|Level activated|MovingHand/i.test(s)) {
        const line = `+${Math.round((Date.now() - t0c) / 1000)}s ${s.slice(0, 190)}`;
        tutLog.push(line);
        console.log('   [tut]', line);
      }
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
  };
  const darkest = async () => {
    const r = await evalJs('JSON.stringify(window.__darkest())');
    try { return JSON.parse(r); } catch (e) { return null; }
  };
  const boxLuma = async (x, y) => Number(await evalJs(`window.__boxLuma(${x}, ${y}, 0.022)`));
  const holdRel = (x, y, ms) => evalJs(`(function(){
    var I = window.AutoplayInput;
    return new Promise(function(res){ I.press(${x},${y}); setTimeout(function(){ I.release(${x},${y}); res(true); }, ${ms}); });
  })()`);
  const quickTap = (x, y) => evalJs(`window.__wxInjectTouch("start",${x},${y}), window.__wxInjectTouch("end",${x},${y})`);

  await S('Page.navigate', { url: URL_ });
  await sleep(2500);
  await evalJs('document.getElementById("start-btn").click()');
  await evalJs(HOOK);

  log('等待进入战斗…');
  for (let i = 0; i < 80; i++) {
    await sleep(3000);
    const l = await evalJs('window.AutoplayPerception.observe().metrics.avgLuma');
    if (i % 5 === 0) log(`  t=${(i + 1) * 3}s luma=${l}`);
    if (l > 178) { log(`  进入战斗 @ ${(i + 1) * 3}s`); break; }
    if (i % 2 === 0) await evalJs('window.__wxInjectTouch("start",0.5,0.5), window.__wxInjectTouch("end",0.5,0.5)');
  }
  await evalJs('(function(){var b=document.getElementById("ap-fold"); if(b) b.click(); return 1})()');
  log('等待 20s 让教程进入等待击杀…');
  await sleep(20000);

  const d0 = await darkest();
  log('');
  log('最暗点（视为靶子）: ' + JSON.stringify(d0));
  if (!d0) { log('！！拿不到帧'); process.exit(3); }
  const bx = d0.x, by = d0.y;
  log(`小方框平均亮度（打之前）: ${await boxLuma(bx, by)}`);
  await shot('kill-00-base');

  const trials = [
    { n: 'quick-tap', hold: 0 },
    { n: 'hold-400', hold: 400 },
    { n: 'hold-900', hold: 900 },
    { n: 'hold-1800', hold: 1800 }
  ];
  for (const tr of trials) {
    log('');
    log(`--- ${tr.n} @ (${bx},${by}) ---`);
    if (tr.hold === 0) await quickTap(bx, by); else await holdRel(bx, by, tr.hold);
    await sleep(1700);
    const nowL = await boxLuma(bx, by);
    const nd = await darkest();
    log(`  之后小方框亮度=${nowL}   当前最暗点=${JSON.stringify(nd)}`);
    await shot('kill-' + tr.n);
  }

  log('');
  log('=== 连续按住 900ms 释放 ×8，看是否推进 ===');
  for (let i = 0; i < 8; i++) {
    const cur = await darkest();
    if (!cur) break;
    await holdRel(cur.x, cur.y, 900);
    await sleep(1700);
    log(`  第 ${i + 1} 次 @ (${cur.x},${cur.y}) lum=${cur.lum} -> 方框亮度=${await boxLuma(cur.x, cur.y)}`);
  }
  await shot('kill-final');

  log('');
  log('=== 教程日志 ===');
  log(tutLog.join('\n') || '(none)');

  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
