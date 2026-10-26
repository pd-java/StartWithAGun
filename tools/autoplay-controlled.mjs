/**
 * autoplay-controlled.mjs —— 受控触摸对照实验（ChatGPT 方案第二轮 P0 步骤）
 *
 * 要回答的唯一问题：
 *   「一次有效的触摸注入，为什么没有让 WaitForHealthComponentsKilled(total=2) 推进？」
 *
 * 拆成三种情况来区分：
 *   输入完全没反应 / 输入有反应但没命中 / 命中了但教程没推进
 *
 * 实验设计（同一教程状态，顺序执行，间隔 2.5s 让画面回到静止）：
 *   T1 屏幕中心短触摸
 *   T2 空白区域短触摸（画面左上天空，肯定没有敌人）
 *   T3 敌人位置短触摸（页面内高分辨率检测出的最"竖"的深色块）
 *   T4 完整拖动（start → 多次 move → end）
 *
 * 每次操作都记录：
 *   - 操作前/后各一张 PNG
 *   - 页面内帧缓冲的局部差分（准星区/武器区/目标区/全屏）
 *   - 操作前后教程日志状态
 *
 * 另外：Phase 1 会以 1.5s 间隔连拍整个教程窗口，用于肉眼找 ShowMovingHand 的手势。
 *
 * 用法: node tools/autoplay-controlled.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const OUT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun/.workbuddy/probe-out';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9367;
const profile = mkdtempSync(join(tmpdir(), 'cdp-ctl-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1000,1000', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  'http://127.0.0.1:8848/robots.txt'
], { stdio: 'ignore' });
process.on('exit', () => { try { child.kill(); } catch (e) {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const NOISE = /ASTC6X6|decompressing texture|本地 bundle|Odin Serializer|report_fail|storage-probe|命中映射|dn-sdk|glCreateShader|SoftMask|referenced script|Shader |Convex Mesh|kinematic body|RectTransform is being set|memorysetup|RemoteConfig|DeserializedConfiguration/i;

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

/** 帧缓冲 + 局部差分的页内实现（采样必须在渲染回调之后） */
const CAPTURE_HOOK = `
window.__fb = [];       // [{t, data(Uint8ClampedArray 128*128*4)}]
window.__FB_MAX = 90;
(function () {
  if (window.__fbHooked) return; window.__fbHooked = true;
  var _raf = window.requestAnimationFrame.bind(window);
  var W = 128, H = 128;
  var b = document.createElement('canvas'); b.width = W; b.height = H;
  var x = b.getContext('2d', { willReadFrequently: true });
  window.requestAnimationFrame = function (cb) {
    return _raf(function (t) {
      var r;
      try { r = cb(t); } catch (e) { r = undefined; }
      try {
        var c = document.querySelector('canvas');
        if (c && c.width > 1) {
          x.drawImage(c, 0, 0, W, H);
          var d = x.getImageData(0, 0, W, H).data;
          window.__fb.push({ t: Math.round(performance.now()), data: new Uint8ClampedArray(d) });
          if (window.__fb.length > window.__FB_MAX) window.__fb.shift();
        }
      } catch (e) { /* ignore */ }
      return r;
    });
  };
})();

/** 在归一化框 [x0,y0,x1,y1] 内比较两帧，返回变化像素占比 */
window.__diffBox = function (ia, ib, x0, y0, x1, y1) {
  var A = window.__fb[ia], B = window.__fb[ib];
  if (!A || !B) return -1;
  var W = 128, H = 128;
  var xa = Math.max(0, Math.floor(x0 * W)), xb = Math.min(W, Math.ceil(x1 * W));
  var ya = Math.max(0, Math.floor(y0 * H)), yb = Math.min(H, Math.ceil(y1 * H));
  var n = 0, ch = 0;
  for (var y = ya; y < yb; y++) {
    for (var x = xa; x < xb; x++) {
      var i = (y * W + x) * 4;
      n++;
      var d = Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i+1] - B.data[i+1]) + Math.abs(A.data[i+2] - B.data[i+2]);
      if (d > 30) ch++;
    }
  }
  return n ? Math.round(ch / n * 1000) / 10 : -1;
};

/** 指定帧的平均亮度（用于确认帧有效） */
window.__fbLuma = function (i) {
  var F = window.__fb[i];
  if (!F) return -1;
  var s = 0, n = 0;
  for (var k = 0; k < F.data.length; k += 4) { s += F.data[k]*0.299 + F.data[k+1]*0.587 + F.data[k+2]*0.114; n++; }
  return Math.round(s / n);
};

/** 高分辨率深色目标检测（判定"敌人位置"用） */
window.__cand = function () {
  var c = document.querySelector('canvas');
  if (!c || !c.width) return [];
  var W = 320, H = Math.max(1, Math.round(W * c.height / c.width));
  var b = window.__candBuf || (window.__candBuf = document.createElement('canvas'));
  if (b.width !== W || b.height !== H) { b.width = W; b.height = H; }
  var x2 = b.getContext('2d', { willReadFrequently: true });
  x2.drawImage(c, 0, 0, W, H);
  var d = x2.getImageData(0, 0, W, H).data;
  var dark = new Uint8Array(W * H);
  for (var i = 0; i < W * H; i++) {
    var r = d[i*4], g = d[i*4+1], bl = d[i*4+2];
    var lum = r*0.299 + g*0.587 + bl*0.114;
    var ny = (i / W) | 0;
    if (ny / H < 0.34 || ny / H > 0.62) continue;
    if (lum < 125) dark[i] = 1;
  }
  var seen = new Uint8Array(W * H), out = [];
  for (var p = 0; p < W * H; p++) {
    if (!dark[p] || seen[p]) continue;
    var st = [p], n = 0, sx = 0, sy = 0, minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
    seen[p] = 1;
    while (st.length) {
      var q = st.pop(), qx = q % W, qy = (q / W) | 0;
      n++; sx += qx; sy += qy;
      if (qx < minx) minx = qx; if (qx > maxx) maxx = qx;
      if (qy < miny) miny = qy; if (qy > maxy) maxy = qy;
      var nb = [[1,0],[-1,0],[0,1],[0,-1]];
      for (var k = 0; k < 4; k++) {
        var ax = qx + nb[k][0], ay = qy + nb[k][1];
        if (ax < 0 || ay < 0 || ax >= W || ay >= H) continue;
        var ai = ay * W + ax;
        if (dark[ai] && !seen[ai]) { seen[ai] = 1; st.push(ai); }
      }
    }
    var ww = maxx - minx + 1, hh = maxy - miny + 1;
    if (n < 15 || n > 2500) continue;
    if (ww > 70 || hh > 70) continue;
    out.push({ x: Math.round((sx/n)/W*1000)/1000, y: Math.round((sy/n)/H*1000)/1000, n: n, ar: Math.round(hh/ww*100)/100 });
  }
  out.sort(function (a, b) { return b.ar - a.ar; });
  return out;
}; 'ok'`;

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
  const timeline = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      const a = (m.params.args || []).map((x) => (x.value !== undefined ? x.value : x.description)).join(' ');
      const s = String(a || '');
      if (!s || NOISE.test(s)) return;
      const line = `+${Math.round((Date.now() - t0c) / 1000)}s ${s.slice(0, 220)}`;
      timeline.push(line);
      if (/TUTORIAL|Dialogue|MovingHand|RangeTargets|HealthComponents|Level activated|GotoNextLevel/i.test(s)) {
        console.log('   [tutorial]', line);
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
  const fbLen = async () => Number(await evalJs('window.__fb.length')) || 0;

  await S('Page.navigate', { url: URL_ });
  await sleep(2500);
  await evalJs('document.getElementById("start-btn").click()');
  await evalJs(CAPTURE_HOOK);
  log('已注入帧缓冲钩子');

  log('等待进入战斗…');
  let entered = false;
  for (let i = 0; i < 80; i++) {
    await sleep(3000);
    const l = await evalJs('window.AutoplayPerception.observe().metrics.avgLuma');
    if (i % 5 === 0) log(`  t=${(i + 1) * 3}s luma=${l}`);
    if (l > 178) { entered = true; log(`  进入战斗 @ ${(i + 1) * 3}s`); break; }
    if (i % 2 === 0) await evalJs('window.__wxInjectTouch("start",0.5,0.5), window.__wxInjectTouch("end",0.5,0.5)');
  }
  if (!entered) { log('！！未进入战斗'); process.exit(2); }

  // ── Phase 1：连拍教程窗口，用于找 ShowMovingHand 手势 ──────────────
  log('');
  log('=== Phase 1：教程窗口连拍（1.5s 一张，共 24 张）===');
  await evalJs('(function(){var b=document.getElementById("ap-fold"); if(b) b.click(); return 1})()');
  for (let i = 0; i < 24; i++) {
    await shot(`tut-${String(i).padStart(2, '0')}`);
    await sleep(1500);
  }
  log('  连拍完成');

  // ── Phase 2：受控触摸对照实验 ────────────────────────────────────
  log('');
  log('=== Phase 2：受控触摸对照实验 ===');
  const cands = async () => {
    const r = await evalJs('JSON.stringify(window.__cand())');
    try { return JSON.parse(r); } catch (e) { return []; }
  };
  const list = await cands();
  log('  候选目标: ' + (list.length ? list.slice(0, 5).map((t) => `(${t.x},${t.y} n=${t.n} ar=${t.ar})`).join(' ') : '无'));
  const enemy = list.length ? list[0] : { x: 0.5, y: 0.45 };

  const REGIONS = {
    crosshair: [0.42, 0.42, 0.58, 0.58],
    weapon: [0.28, 0.72, 0.72, 1.0],
    targets: [0.13, 0.34, 0.78, 0.62],
    full: [0.0, 0.0, 1.0, 1.0]
  };

  async function caseRun(name, act, box) {
    // 等画面稳定
    await sleep(2200);
    const before = await fbLen();
    log('');
    log(`--- ${name} ---`);
    log(`  帧缓冲 ${before} 帧，luma=${await evalJs(`window.__fbLuma(${before - 1})`)}`);
    await shot(`ctl-${name}-before`);

    const tInject = Date.now();
    await act();
    await sleep(1800);
    const after = await fbLen();
    log(`  注入后帧缓冲 ${after} 帧（新增 ${after - before}）`);
    await shot(`ctl-${name}-after`);

    if (after <= before) { log('  ✘ 注入后没有新帧，无法比较'); return; }

    // 前后对比：取注入前最后一帧 vs 注入后若干帧
    for (const idx of [before, Math.floor((before + after) / 2), after - 1]) {
      if (idx <= before - 1 || idx >= after) continue;
      const row = [];
      for (const [rn, bx] of Object.entries(REGIONS)) {
        const v = await evalJs(`window.__diffBox(${before - 1}, ${idx}, ${bx[0]}, ${bx[1]}, ${bx[2]}, ${bx[3]})`);
        row.push(`${rn}=${v}%`);
      }
      const dt = idx - before;
      log(`  frame+${dt}: ` + row.join(' '));
    }
    if (box) {
      const v = await evalJs(`window.__diffBox(${before - 1}, ${after - 1}, ${box[0]}, ${box[1]}, ${box[2]}, ${box[3]})`);
      log(`  点击点局部 ±0.06: ${v}%`);
    }
  }

  const tapAt = (x, y) => evalJs(`window.__wxInjectTouch("start",${x},${y}), window.__wxInjectTouch("end",${x},${y})`);

  // T0 空转对照（不注入任何输入）
  await caseRun('T0-noinput', async () => {}, null);
  // T1 中心
  await caseRun('T1-center', () => tapAt(0.5, 0.5), [0.44, 0.44, 0.56, 0.56]);
  // T2 空白（左上天空）
  await caseRun('T2-blank', () => tapAt(0.18, 0.12), [0.12, 0.06, 0.24, 0.18]);
  // T3 敌人
  await caseRun('T3-enemy', () => tapAt(enemy.x, enemy.y), [enemy.x - 0.06, enemy.y - 0.06, enemy.x + 0.06, enemy.y + 0.06]);
  // T4 拖动
  await caseRun('T4-drag', async () => {
    await evalJs(`(function(){
      var I = window.AutoplayInput;
      return new Promise(function(res){
        I.press(0.5, 0.45);
        var n = 0, steps = 10;
        var iv = setInterval(function(){
          n++;
          I.moveTo(0.5 + 0.015 * n, 0.45);
          if (n >= steps) { clearInterval(iv); I.release(0.5 + 0.15, 0.45); res(true); }
        }, 45);
      });
    })()`);
  }, [0.44, 0.40, 0.70, 0.50]);

  log('');
  log('=== 教程相关日志时间线 ===');
  const tlines = timeline.filter((l) => /TUTORIAL|Dialogue|MovingHand|RangeTargets|HealthComponents|GotoNextLevel|Level activated/i.test(l));
  log(tlines.length ? tlines.join('\n') : '（无）');

  log('');
  log('=== 最终状态 ===');
  log(await evalJs('JSON.stringify({luma: window.AutoplayPerception.observe().metrics.avgLuma, scene: window.AutoplayPerception.observe().scene})'));
  await shot('ctl-final');

  writeFileSync(join(OUT, 'controlled-timeline.txt'), timeline.join('\n'), 'utf8');
  log('时间线已写入 .workbuddy/probe-out/controlled-timeline.txt');

  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
