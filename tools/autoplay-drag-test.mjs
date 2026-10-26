/**
 * autoplay-drag-test.mjs —— 决定性实验：拖动到底转不转视角
 *
 * 为什么需要它：
 *   UI 点击已被证明能进游戏（点齿轮弹出设置面板）。但瞄准/射击毫无反应。
 *   于是必须把问题一分为二：**move 事件有没有进到瞄准逻辑**。
 *   判定方式不是看靶子（靶子自己在动），而是看**远处静止的山脊**是否横向平移。
 *
 * 做法：
 *   1. rAF 后缓存 400 宽帧；取 y∈[0.24,0.36] 这一带的"每列平均亮度"作为一维轮廓
 *   2. 基线：静止状态下间隔 300ms 取两次轮廓 → 互相关系数最优位移 ≈ 0（只有呼吸晃动）
 *   3. 执行一次全宽拖动（30 个 move 事件 / 1.2s），再取轮廓 → 求最优位移
 *   4. 再用"保持按住 + 每帧原地 move（抖动馈送）后释放"再试一次
 *
 * 判据：
 *   拖动后山脊横移 > 基线晃动的 3 倍且绝对值 > 8 像素(400宽下) ⇒ 视角确实被转动
 *   否则 ⇒ move 事件没进瞄准逻辑，问题在输入状态维持而非输入数值
 *
 * 用法: node tools/autoplay-drag-test.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const OUT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun/.workbuddy/probe-out';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9377;
const profile = mkdtempSync(join(tmpdir(), 'cdp-drag-'));
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

/** 取一条横向带子的"每列平均亮度"作为一维轮廓，用于测视角横移 */
window.__profile = function (y0f, y1f) {
  var F = window.__hi; if (!F) return null;
  var W = F.w, H = F.h, d = F.data;
  var ya = Math.floor(y0f * H), yb = Math.floor(y1f * H);
  var out = new Array(W).fill(0);
  for (var x = 0; x < W; x++) {
    var s = 0;
    for (var y = ya; y < yb; y++) {
      var i = (y * W + x) * 4;
      s += d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114;
    }
    out[x] = Math.round(s / Math.max(1, yb - ya));
  }
  return out;
};
'ok'`;

/** 一维轮廓互相关：返回使 b 对齐 a 的最优位移（像素，正=向右平移） */
function bestShift(a, b, maxShift = 100) {
  if (!a || !b || a.length !== b.length) return { dx: NaN, score: NaN, curve: [] };
  let best = null;
  const curve = [];
  for (let dx = -maxShift; dx <= maxShift; dx++) {
    let sad = 0, n = 0;
    for (let x = 0; x < a.length; x++) {
      const y = x + dx;
      if (y < 0 || y >= b.length) continue;
      sad += Math.abs(a[x] - b[y]);
      n++;
    }
    if (!n) continue;
    const v = sad / n;
    curve.push([dx, Math.round(v * 100) / 100]);
    if (!best || v < best.score) best = { dx, score: v };
  }
  return { dx: best ? best.dx : NaN, score: best ? Math.round(best.score * 100) / 100 : NaN, curve };
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

  const t0c = Date.now();
  const tutLog = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      const a = (m.params.args || []).map((x) => (x.value !== undefined ? x.value : x.description)).join(' ');
      const s = String(a || '');
      if (!s || NOISE.test(s)) return;
      if (/TUTORIAL_SEQUENCE|HealthComponents|GotoNextLevel|Level activated/i.test(s)) {
        const line = `+${Math.round((Date.now() - t0c) / 1000)}s ${s.slice(0, 180)}`;
        tutLog.push(line); console.log('   [tut]', line);
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
  const prof = async (y0, y1) => {
    const r = await evalJs(`JSON.stringify(window.__profile(${y0}, ${y1}))`);
    try { return JSON.parse(r); } catch (e) { return null; }
  };

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
  log('等待 18s 稳定…');
  await sleep(18000);
  await shot('drag-00-base');

  const RIDGE = [0.24, 0.34];
  log('');
  log('=== 基线：静止状态下 300ms 内的山脊横移（呼吸晃动）===');
  const baseShifts = [];
  for (let i = 0; i < 3; i++) {
    const a = await prof(RIDGE[0], RIDGE[1]);
    await sleep(320);
    const b = await prof(RIDGE[0], RIDGE[1]);
    const r = bestShift(a, b, 60);
    baseShifts.push({ dx: r.dx, score: r.score });
    log(`  #${i + 1} dx=${r.dx}px 残差=${r.score}`);
  }

  log('');
  log('=== 实验：全宽拖动（30 个 move / 1.2s），起点 0.15 → 终点 0.85 ===');
  const before = await prof(RIDGE[0], RIDGE[1]);
  const nMoveBefore = Number(await evalJs('window.__hi ? window.__hi.t : 0'));
  await evalJs(`(function(){
    var I = window.AutoplayInput;
    return new Promise(function(res){
      I.press(0.15, 0.45);
      var n = 0, steps = 30;
      var iv = setInterval(function(){
        n++;
        I.moveTo(0.15 + 0.70 * (n / steps), 0.45);
        if (n >= steps) { clearInterval(iv); I.release(0.85, 0.45); res(true); }
      }, 40);
    });
  })()`);
  await sleep(1200);
  const after = await prof(RIDGE[0], RIDGE[1]);
  const rAfter = bestShift(before, after, 150);
  log(`  拖动后山脊横移 dx=${rAfter.dx}px 残差=${rAfter.score}`);
  await shot('drag-01-after-drag');

  // 用另一条带子交叉验证（近处的围墙，y 0.40-0.44）
  const b2 = await prof(0.40, 0.44);
  await sleep(50);
  const a2 = await prof(0.40, 0.44);
  log(`  （对照）围墙带静止 dx=${bestShift(b2, a2, 60).dx}px`);

  log('');
  log('=== 实验 2：按住 + 每帧原地 move（抖动馈送）后释放 ===');
  const before2 = await prof(RIDGE[0], RIDGE[1]);
  await evalJs(`(function(){
    var I = window.AutoplayInput;
    return new Promise(function(res){
      I.press(0.5, 0.45);
      var n = 0;
      var iv = setInterval(function(){
        n++;
        I.moveTo(0.5, 0.45);
        if (n >= 24) { clearInterval(iv); I.release(0.5, 0.45); res(true); }
      }, 50);
    });
  })()`);
  await sleep(1200);
  const after2 = await prof(RIDGE[0], RIDGE[1]);
  const r2 = bestShift(before2, after2, 100);
  log(`  抖动馈送后山脊横移 dx=${r2.dx}px 残差=${r2.score}`);

  log('');
  log('=== 实验 3：短促大幅左右拖动（模拟甩镜）===');
  const before3 = await prof(RIDGE[0], RIDGE[1]);
  await evalJs(`(function(){
    var I = window.AutoplayInput;
    return new Promise(function(res){
      I.press(0.30, 0.45);
      var n = 0;
      var iv = setInterval(function(){
        n++;
        I.moveTo(0.30 + 0.40 * Math.sin(n / 2), 0.45);
        if (n >= 16) { clearInterval(iv); I.release(0.30, 0.45); res(true); }
      }, 50);
    });
  })()`);
  await sleep(1200);
  const after3 = await prof(RIDGE[0], RIDGE[1]);
  const r3 = bestShift(before3, after3, 150);
  log(`  甩镜后山脊横移 dx=${r3.dx}px 残差=${r3.score}`);

  log('');
  log('=== 汇总 ===');
  log('基线晃动 dx: ' + JSON.stringify(baseShifts));
  log(`全宽拖动 dx=${rAfter.dx}  抖动馈送 dx=${r2.dx}  甩镜 dx=${r3.dx}`);
  const baseMax = Math.max(...baseShifts.map((b) => Math.abs(b.dx)));

  log('');
  log('=== 判据 ===');
  if (Math.abs(rAfter.dx) > Math.max(8, baseMax * 3)) {
    log('  ✔ 拖动确实转动了视角 —— 输入模型是「拖动瞄准」，问题在射击触发条件');
  } else {
    log('  ✘ 拖动没有转动视角（|dx|=' + Math.abs(rAfter.dx) + ' ≤ 阈值 ' + Math.max(8, baseMax * 3) + '）');
    log('    ⇒ move 事件没有进到瞄准逻辑，问题在触摸状态的跨帧维持，而不是输入数值');
  }

  log('');
  log('教程日志: ' + (tutLog.slice(-3).join(' | ') || '(none)'));
  await shot('drag-final');

  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
