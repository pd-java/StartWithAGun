/**
 * autoplay-gesture-test.mjs —— ChatGPT 指定的下一步单实验：连续「按下 → 拖动对准 → 释放」
 *
 * 为什么只做这一个实验：
 *   拖动确实转视角（山脊横移 -111px / 400 宽，增益 0.40）已被证明。
 *   但「释放是否开火」与「瞄准和开火是否同一个手势」还没定论：
 *     模型 1：一次触摸 = 瞄准 + 松手开枪
 *     模型 2：先拖动瞄准，再单独一次按住-释放开枪
 *   两者的差别决定了整个自动玩的结构，必须先判定，否则后面写的闭环逻辑可能全错。
 *
 * 本实验同时修掉上一版的两个缺陷（ChatGPT 第 3、4 点的要求）：
 *   A. 不用「全屏最暗点」。准星附近有一块纯黑、屏幕固定的 UI（lum=0，位于 0.4975/0.3777），
 *      全局 argmin 会被它永久劫持。改为**准星邻域内暗像素占比** D（排除 lum<8 的准星笔画）。
 *   B. 不在对准之后再补一次开火手势。整段只用一次触摸，全程 press → move… → release。
 *
 * 判据（ChatGPT 给的显式 PASS/FAIL）：
 *   PASS：教程从 total=2 前进（出现击杀、或 WaitForHealthComponentsKilled 消失、或事件推进）
 *   FAIL：释放并静置后仍是 total=2，且无任何可靠的命中迹象
 *   若拖动结束时 D 仍为低值（目标没进准星）→ 记为 INCONCLUSIVE，不能据此否定模型 1
 *
 * 用法: node tools/autoplay-gesture-test.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const OUT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun/.workbuddy/probe-out';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9381;
const profile = mkdtempSync(join(tmpdir(), 'cdp-gest-'));
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

/* ── 准星几何：上一轮实测，狙击镜固定在画面中央 ───────────────── */
const RET_X = 0.4975;
const RET_Y = 0.49;

/* ── 帧缓存 + 两个测量函数 ──────────────────────────────────────
 * 关键（踩过两次坑）：WebGL 未开 preserveDrawingBuffer，帧外读画布必得全 0。
 * 所以所有测量都基于 rAF 回调「之后、同一 JS 任务内」缓存的这份 800xH 帧。
 * 分辨率用 800 而不是 400：靶子在 400 宽下只有 5x12 像素，连通域会碎。
 */
const HOOK = `
window.__hi = null;
(function () {
  if (window.__hiHooked) return; window.__hiHooked = true;
  var _raf = window.requestAnimationFrame.bind(window);
  var W = 800, H = 0, b = document.createElement('canvas');
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

/**
 * 准星邻域暗像素占比 D。
 * 刻意**不**排除整块准星区域，只跳过 lum<8 的纯黑笔画（准星本身/UI 遮罩），
 * 因为要判断的正是"靶子有没有落到准星上"，把区域挖空就没证据了。
 */
window.__reticle = function (hx, hy, thr) {
  var F = window.__hi; if (!F) return null;
  var W = F.w, H = F.h, d = F.data;
  var cx = ${RET_X} * W, cy = ${RET_Y} * H;
  var x0 = Math.max(0, Math.floor(cx - hx * W)), x1 = Math.min(W - 1, Math.ceil(cx + hx * W));
  var y0 = Math.max(0, Math.floor(cy - hy * H)), y1 = Math.min(H - 1, Math.ceil(cy + hy * H));
  var dark = 0, valid = 0, sum = 0, minL = 999;
  for (var y = y0; y <= y1; y++) {
    for (var x = x0; x <= x1; x++) {
      var i = (y * W + x) * 4;
      var lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      if (lum < 8) continue;              // 准星/纯黑 UI 笔画，不计入
      valid++; sum += lum;
      if (lum < minL) minL = lum;
      if (lum < thr) dark++;
    }
  }
  return {
    frac: valid ? dark / valid : 0,
    mean: valid ? Math.round(sum / valid) : -1,
    min: minL === 999 ? -1 : Math.round(minL),
    valid: valid
  };
};

/**
 * 沙地带内的深色连通域（候选靶子）。
 * 只用一条很弱的判据：沙地亮度 ~200，靶子 ~42，所以 lum<thr 就够，不玩形状启发式。
 * 额外要求 h >= w*1.1（站立人形是竖直的），用来滤掉横向的护栏细线。
 */
window.__blobs = function (o) {
  var F = window.__hi; if (!F) return [];
  var W = F.w, H = F.h, d = F.data;
  var thr = o.thr || 120;
  var y0 = Math.floor(o.y0 * H), y1 = Math.floor(o.y1 * H);
  var x0 = Math.floor(o.x0 * W), x1 = Math.floor(o.x1 * W);
  var m = new Uint8Array(W * H);
  for (var y = y0; y < y1; y++) {
    for (var x = x0; x < x1; x++) {
      var i = (y * W + x) * 4;
      var lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      if (lum >= 8 && lum < thr) m[y * W + x] = 1;
    }
  }
  var out = [], st = [];
  var minA = o.minArea || 25, maxW = o.maxW || 60, maxH = o.maxH || 90;
  for (var y = y0; y < y1; y++) {
    for (var x = x0; x < x1; x++) {
      var k = y * W + x; if (!m[k]) continue;
      m[k] = 0; st.length = 0; st.push(k);
      var n = 0, sx = 0, sy = 0, minx = x, maxx = x, miny = y, maxy = y;
      while (st.length) {
        var p = st.pop(); var py = (p / W) | 0, px = p - py * W;
        n++; sx += px; sy += py;
        if (px < minx) minx = px; if (px > maxx) maxx = px;
        if (py < miny) miny = py; if (py > maxy) maxy = py;
        if (px > 0) { var q = p - 1; if (m[q]) { m[q] = 0; st.push(q); } }
        if (px < W - 1) { var q2 = p + 1; if (m[q2]) { m[q2] = 0; st.push(q2); } }
        if (py > 0) { var q3 = p - W; if (m[q3]) { m[q3] = 0; st.push(q3); } }
        if (py < H - 1) { var q4 = p + W; if (m[q4]) { m[q4] = 0; st.push(q4); } }
      }
      var bw = maxx - minx + 1, bh = maxy - miny + 1;
      if (n < minA || bw > maxW || bh > maxH) continue;
      if (bh < bw * 1.1) continue;
      out.push({
        x: Math.round((sx / n) / W * 10000) / 10000,
        y: Math.round((sy / n) / H * 10000) / 10000,
        w: bw, h: bh, area: n
      });
    }
  }
  out.sort(function (a, b) { return b.area - a.area; });
  return out;
};
'ok'`;

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

  const t0c = Date.now();
  const tutLog = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      const a = (m.params.args || []).map((x) => (x.value !== undefined ? x.value : x.description)).join(' ');
      const s = String(a || '');
      if (!s || NOISE.test(s)) return;
      if (/TUTORIAL_SEQUENCE|HealthComponents|GotoNextLevel|Level activated|killed|Kill/i.test(s)) {
        const line = `+${Math.round((Date.now() - t0c) / 1000)}s ${s.slice(0, 180)}`;
        tutLog.push(line); console.log('   [tut]', line);
      }
    }
  });

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 90000 });
    if (r.exceptionDetails) return { __err: String((r.exceptionDetails.exception || {}).description || '').slice(0, 250) };
    return r.result.value;
  };
  const shot = async (name) => {
    const sh = await S('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, name + '.png'), Buffer.from(sh.data, 'base64'));
  };
  const D = async (hx = 0.030, hy = 0.034, thr = 115) =>
    evalJs(`JSON.stringify(window.__reticle(${hx},${hy},${thr}))`).then((s) => { try { return JSON.parse(s); } catch (e) { return null; } });
  const blobs = async (o) => evalJs(`JSON.stringify(window.__blobs(${JSON.stringify(o)}))`).then((s) => { try { return JSON.parse(s); } catch (e) { return []; } });

  await S('Page.navigate', { url: URL_ });
  await sleep(2500);
  await evalJs('document.getElementById("start-btn").click()');
  await evalJs(HOOK);

  log('=== 阶段 0：启动到可玩 ===');
  let entered = false;
  for (let i = 0; i < 80; i++) {
    await sleep(3000);
    const l = await evalJs('window.AutoplayPerception.observe().metrics.avgLuma');
    if (i % 5 === 0) log(`  t=${(i + 1) * 3}s luma=${l}`);
    if (l > 178) { log(`  进入战斗 @ ${(i + 1) * 3}s luma=${l}`); entered = true; break; }
    if (i % 2 === 0) await evalJs('window.__wxInjectTouch("start",0.5,0.5), window.__wxInjectTouch("end",0.5,0.5)');
  }
  if (!entered) { log('  ✘ 未进入战斗，实验中止'); try { child.kill(); } catch (e) {} process.exit(2); }

  // 折叠面板，避免它干扰右侧画面测量
  await evalJs('(function(){var b=document.getElementById("ap-fold"); if(b) b.click(); return 1})()');
  log('  等待 20s 让教程推进到「等待击杀」…');
  await sleep(20000);

  log('');
  log('=== 阶段 1：输入链路自检 ===');
  const hc = await evalJs('JSON.stringify(window.__wxTouchHandlerCount())');
  log('  touch handlers: ' + hc);
  log('  准星基线 D（未被靶子覆盖时）: ' + JSON.stringify(await D()));

  log('');
  log('=== 阶段 2：全分辨率寻找候选靶子 ===');
  const bands = [{ y0: 0.40, y1: 0.60 }, { y0: 0.36, y1: 0.44 }, { y0: 0.52, y1: 0.62 }];
  let cands = [];
  for (const b of bands) {
    const c = await blobs({ y0: b.y0, y1: b.y1, x0: 0.05, x1: 0.97, thr: 120, minArea: 25, maxW: 60, maxH: 90 });
    log(`  带 y[${b.y0},${b.y1}] → ${c.length} 个候选: ` + c.slice(0, 6).map((t) => `(${t.x},${t.y}) ${t.w}x${t.h} a=${t.area}`).join('  '));
    cands = cands.concat(c);
  }
  // 目标：靠近准星高度、且与准星有可纠正的水平偏差
  const near = cands
    .filter((t) => Math.abs(t.y - RET_Y) < 0.05)
    .filter((t) => Math.abs(t.x - RET_X) > 0.015 && Math.abs(t.x - RET_X) < 0.28)
    .sort((a, b) => Math.abs(a.x - RET_X) - Math.abs(b.x - RET_X));
  const pick = near[0] || null;
  if (pick) log(`  → 选中靶子 (${pick.x}, ${pick.y}) 面积=${pick.area} 偏差=${(pick.x - RET_X).toFixed(4)}`);
  else log('  ⚠ 没有符合条件的目标，将改为「准星亮度一维扫描」兜底');

  await shot('gest-00-before');

  /* ── 阶段 3：唯一一次触摸：press → drag → hold → release ───────── */
  const GAIN = 0.40;
  const moveMs = 45;
  const holdMs = 350;

  let plan;
  if (pick) {
    const needDx = (pick.x - RET_X) / GAIN;      // 手指需要移动的归一化距离（同向）
    log('');
    log(`=== 阶段 3：连续手势（预测拖动 ${needDx.toFixed(3)}，增益 ${GAIN}）===`);
    const startX = Math.min(0.90, Math.max(0.10, 0.5 - needDx / 2));
    const endX = Math.min(0.94, Math.max(0.06, startX + needDx));
    plan = { startX, endX, startY: 0.62, endY: 0.62 };
  } else {
    // 兜底：从右侧起手，向左横扫整屏，边走边看准星 D
    log('');
    log('=== 阶段 3：兜底横扫手势（0.88 → 0.12）===');
    plan = { startX: 0.88, endX: 0.12, startY: 0.62, endY: 0.62 };
  }
  log(`  起点 (${plan.startX.toFixed(3)}, ${plan.startY}) → 终点 (${plan.endX.toFixed(3)}, ${plan.endY})`);

  // 整段只有一次 press / 一次 release，中途 move 若干；每 4 步回读准星 D
  const trace = await evalJs(`(function(){
    var I = window.AutoplayInput;
    var sx = ${plan.startX}, ex = ${plan.endX}, sy = ${plan.startY}, ey = ${plan.endY};
    var steps = 26;
    var trace = [];
    return new Promise(function (res) {
      I.press(sx, sy);
      var n = 0;
      var iv = setInterval(function () {
        n++;
        var f = n / steps;
        I.moveTo(sx + (ex - sx) * f, sy + (ey - sy) * f);
        if (n % 4 === 0) {
          var r = window.__reticle(0.030, 0.034, 115);
          trace.push({ n: n, frac: r ? Math.round(r.frac * 1000) / 1000 : null, mean: r ? r.mean : null });
        }
        if (n >= steps) {
          clearInterval(iv);
          // 保持触摸，原地再补两次 move（维持"活着的触摸状态"），然后释放
          var hold = 0;
          var iv2 = setInterval(function () {
            hold++;
            I.moveTo(ex, ey);
            if (hold >= Math.round(${holdMs} / 120)) {
              clearInterval(iv2);
              var r2 = window.__reticle(0.030, 0.034, 115);
              I.release(ex, ey);
              res(JSON.stringify({ trace: trace, atRelease: r2 ? { frac: Math.round(r2.frac * 1000) / 1000, mean: r2.mean } : null }));
            }
          }, 120);
        }
      }, ${moveMs});
    });
  })()`);
  let rel = null;
  try { rel = JSON.parse(trace); } catch (e) { log('  ⚠ 手势返回异常: ' + String(trace).slice(0, 200)); }
  if (rel) {
    log('  拖动过程准星 D 轨迹: ' + rel.trace.map((t) => `#${t.n}:${t.frac}`).join(' '));
    log('  释放瞬间准星 D: ' + JSON.stringify(rel.atRelease));
  }

  log('');
  log('=== 阶段 4：释放后静置并判定 ===');
  await sleep(4000);
  const dAfter = await D();
  log('  释放后准星 D: ' + JSON.stringify(dAfter));
  await shot('gest-01-after-release');
  await sleep(3000);
  await shot('gest-02-later');

  const after = await blobs({ y0: 0.36, y1: 0.62, x0: 0.05, x1: 0.97, thr: 120, minArea: 25, maxW: 60, maxH: 90 });
  log(`  释放后深色靶候选: ${after.length} 个 ` + after.slice(0, 6).map((t) => `(${t.x},${t.y})`).join(' '));

  const waitLines = tutLog.filter((l) => /WaitForHealthComponentsKilled/.test(l)).length;
  const killLines = tutLog.filter((l) => /GotoNextLevel|killed|Kill/i.test(l)).length;

  log('');
  log('=== 判定 ===');
  log('  WaitForHealthComponentsKilled 日志条数: ' + waitLines + '   其他前进迹象条数: ' + killLines);
  log('  教程日志尾部: ' + (tutLog.slice(-4).join('  |  ') || '(none)'));

  const aligned = rel && rel.atRelease && rel.atRelease.frac >= 0.18;
  if (killLines > 0 && waitLines <= 1) {
    log('  ✔ PASS：连续 press-drag-release 产生了教程前进 —— 模型 1（松手即开枪）成立');
  } else if (!aligned) {
    log('  ⚠ INCONCLUSIVE：释放时准星 D=' + (rel && rel.atRelease ? rel.atRelease.frac : '?') +
        ' 偏低，目标并未真正对准，不能据此否定模型 1');
  } else {
    log('  ✘ FAIL：已对准（D=' + (rel ? rel.atRelease.frac : '?') + '）但教程仍停在 total=2');
    log('    ⇒ 下一步应把「瞄准」与「开火」拆开，或直接走 WASM 诊断补丁路线');
  }

  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
