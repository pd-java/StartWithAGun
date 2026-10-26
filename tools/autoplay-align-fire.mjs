/**
 * autoplay-align-fire.mjs —— 手势 v2：单次触摸内闭环对准，然后释放
 *
 * v1（autoplay-gesture-test.mjs）的结论与缺陷：
 *   结论：INCONCLUSIVE。准星邻域暗像素占比 D 在整个拖动过程中恒为 0，
 *         因为候选目标排序挑中了一块石头 (0.454, 0.4693, area=62)，
 *         真靶子根本没进准星，所以"释放不开火"这个结论不成立。
 *   附带产出：拖动增益第二次独立验证 —— 靶候选整体右移 0.0445，拖动 -0.108 ⇒ 增益 0.41。
 *
 * v2 的两处改进（都来自实测，不是猜）：
 *   1. **用运动筛掉布景**。靶场里的真靶子在导轨上移动，山石/护栏不动。
 *      做法：连采两帧深度图，按最近邻匹配每个连通域，|dx| > 0.004 才算"活物"。
 *      这比面积、亮度、形状都可靠 —— 上一版就是被"面积最大/离准星最近"带偏的。
 *   2. **同一个手势内闭环**。v1 是一次性按预测距离盲拖，增益有误差就偏。
 *      现在每 320ms 回读靶子 x，误差 e = x_t - x_reticle，
 *      本步手指位移 = e / 0.40 × 0.85（阻尼防止过冲），直到 |e| < 0.012 再释放。
 *      全程只有一次 press / 一次 release，仍然是"一次连续手势"，
 *      所以对"松手即开枪"和"松手不开枪"两种模型都成立。
 *
 * 判据：与 v1 相同 —— 教程是否离开 WaitForHealthComponentsKilled(total=2)。
 *   额外增加一道保险：释放前必须 D >= 0.15，否则标记 INCONCLUSIVE 而不是 FAIL。
 *
 * 用法: node tools/autoplay-align-fire.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const OUT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun/.workbuddy/probe-out';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9383;
const profile = mkdtempSync(join(tmpdir(), 'cdp-align-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1000,1000', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  'http://127.0.0.1:8848/robots.txt'
], { stdio: 'ignore' });
process.on('exit', () => { try { child.kill(); } catch (e) {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const NOISE = /ASTC6X6|decompressing texture|本地 bundle|Odin Serializer|report_fail|storage-probe|命中映射|dn-sdk|glCreateShader|SoftMask|referenced script|Shader |Convex Mesh|kinematic body|RectTransform is being set|memorysetup|RemoteConfig|DeserializedConfiguration|Time set to|cloud-store|CloudStorage|PLUGIN|GameSessionTimeReporter|npc data impl/i;

const RET_X = 0.4975;
const RET_Y = 0.49;

/* 帧缓存 + 三个测量函数。全部基于 rAF 回调之后缓存的 800xH 帧（帧外读必为全 0）。 */
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

/** 准星邻域暗像素占比。只跳过 lum<8 的纯黑笔画，不挖空整个区域。 */
window.__reticle = function (hx, hy, thr) {
  var F = window.__hi; if (!F) return null;
  var W = F.w, H = F.h, d = F.data;
  var cx = ${RET_X} * W, cy = ${RET_Y} * H;
  var x0 = Math.max(0, Math.floor(cx - hx * W)), x1 = Math.min(W - 1, Math.ceil(cx + hx * W));
  var y0 = Math.max(0, Math.floor(cy - hy * H)), y1 = Math.min(H - 1, Math.ceil(cy + hy * H));
  var dark = 0, valid = 0, sum = 0;
  for (var y = y0; y <= y1; y++) {
    for (var x = x0; x <= x1; x++) {
      var i = (y * W + x) * 4;
      var lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      if (lum < 8) continue;
      valid++; sum += lum;
      if (lum < thr) dark++;
    }
  }
  return { frac: valid ? dark / valid : 0, mean: valid ? Math.round(sum / valid) : -1, valid: valid };
};

/** 沙地带内的深色连通域 */
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
      if (bh < bw * 1.05) continue;
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

/** 只挑"会动"的：两帧之间按最近邻匹配，位移绝对值排序 */
window.__moving = function (o, minDx) {
  var a = window.__blobs(o);
  return new Promise(function (res) {
    setTimeout(function () {
      var b = window.__blobs(o);
      var movers = [];
      for (var i = 0; i < a.length; i++) {
        var best = null, bd = 0.06;
        for (var j = 0; j < b.length; j++) {
          var dx = b[j].x - a[i].x, dy = b[j].y - a[i].y;
          var dst = Math.sqrt(dx * dx + dy * dy);
          if (dst < bd) { bd = dst; best = b[j]; }
        }
        if (!best) { movers.push({ x: a[i].x, y: a[i].y, dx: null, gone: true, area: a[i].area, w: a[i].w, h: a[i].h }); continue; }
        movers.push({ x: a[i].x, y: a[i].y, dx: Math.round((best.x - a[i].x) * 10000) / 10000, area: a[i].area, w: a[i].w, h: a[i].h });
      }
      movers.sort(function (p, q) {
        var ap = p.dx === null ? 1 : Math.abs(p.dx);
        var aq = q.dx === null ? 1 : Math.abs(q.dx);
        return aq - ap;
      });
      res(JSON.stringify({ before: a.length, after: b.length, movers: movers, minDx: minDx }));
    }, 820);
  });
};

/**
 * 单次触摸内闭环对准 + 释放。
 * 全程一次 press、一次 move 流、一次 release —— 不插入任何额外手势。
 */
window.__alignFire = function (cfg) {
  var I = window.AutoplayInput;
  var ROI = { y0: 0.40, y1: 0.60, x0: 0.05, x1: 0.97, thr: 120, minArea: 25, maxW: 60, maxH: 90 };
  function pickNear(ref) {
    var bs = window.__blobs(ROI);
    if (!bs.length) return null;
    if (!ref) {
      bs.sort(function (p, q) { return Math.abs(p.x - cfg.retX) - Math.abs(q.x - cfg.retX); });
      return bs[0];
    }
    var best = null, bd = 0.09;
    for (var i = 0; i < bs.length; i++) {
      var d = Math.hypot(bs[i].x - ref.x, bs[i].y - ref.y);
      if (d < bd) { bd = d; best = bs[i]; }
    }
    return best;
  }
  return new Promise(function (res) {
    var t0 = pickNear(cfg.seed || null);
    if (!t0) { res(JSON.stringify({ error: 'no-target' })); return; }
    var need = (t0.x - cfg.retX) / cfg.gain;
    var fx = Math.max(0.06, Math.min(0.94, 0.5 - need / 2));
    var fy = 0.62;
    var trace = [];
    I.press(fx, fy);
    var prev = t0, step = 0;
    var iv = setInterval(function () {
      step++;
      var e = prev.x - cfg.retX;
      var delta = Math.max(-0.12, Math.min(0.12, (e / cfg.gain) * 0.85));
      fx = Math.max(0.05, Math.min(0.95, fx + delta));
      I.moveTo(fx, fy);
      var cur = pickNear(prev);
      if (cur) prev = cur;
      var r = window.__reticle(0.030, 0.034, 115);
      trace.push({
        step: step,
        finger: Math.round(fx * 1000) / 1000,
        tx: cur ? cur.x : null,
        err: cur ? Math.round((cur.x - cfg.retX) * 1000) / 1000 : null,
        D: r ? Math.round(r.frac * 1000) / 1000 : null
      });
      var aligned = cur && Math.abs(cur.x - cfg.retX) < 0.012;
      if (aligned || step >= cfg.maxSteps) {
        clearInterval(iv);
        setTimeout(function () {
          I.moveTo(fx, fy);
          setTimeout(function () {
            var rr = window.__reticle(0.030, 0.034, 115);
            I.release(fx, fy);
            res(JSON.stringify({
              trace: trace, aligned: !!aligned,
              atRelease: rr ? { frac: Math.round(rr.frac * 1000) / 1000, mean: rr.mean } : null
            }));
          }, cfg.holdMs);
        }, 320);
      }
    }, cfg.stepMs);
  });
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
      if (/TUTORIAL_SEQUENCE|HealthComponents|GotoNextLevel|Level activated|TrackTutorial/i.test(s)) {
        const line = `+${Math.round((Date.now() - t0c) / 1000)}s ${s.slice(0, 170)}`;
        tutLog.push(line); console.log('   [tut]', line);
      }
    }
  });

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 120000 });
    if (r.exceptionDetails) return { __err: String((r.exceptionDetails.exception || {}).description || '').slice(0, 250) };
    return r.result.value;
  };
  const shot = async (name) => {
    const sh = await S('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, name + '.png'), Buffer.from(sh.data, 'base64'));
  };
  const jparse = (s, dflt) => { try { return JSON.parse(s); } catch (e) { return dflt; } };

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
  if (!entered) { log('  ✘ 未进入战斗'); try { child.kill(); } catch (e) {} process.exit(2); }
  await evalJs('(function(){var b=document.getElementById("ap-fold"); if(b) b.click(); return 1})()');
  log('  稳定 20s…');
  await sleep(20000);

  log('');
  log('=== 阶段 1：按"会动"筛出真靶子 ===');
  const mo = jparse(await evalJs(`window.__moving({y0:0.40,y1:0.60,x0:0.05,x1:0.97,thr:120,minArea:25,maxW:60,maxH:90}, 0.004)`), null);
  if (!mo) { log('  ✘ __moving 无返回'); } else {
    log(`  连通域 ${mo.before} → ${mo.after}`);
    log('  位移排序（前 10）:');
    mo.movers.slice(0, 10).forEach((t, i) => {
      log(`    ${String(i).padStart(2)} (${t.x.toFixed(3)},${t.y.toFixed(3)}) ${t.w}x${t.h} a=${String(t.area).padStart(4)} dx=${t.dx === null ? 'GONE' : t.dx}`);
    });
  }

  const movers = (mo ? mo.movers : []).filter((t) => t.dx !== null && Math.abs(t.dx) >= 0.004);
  const living = movers.filter((t) => Math.abs(t.y - RET_Y) < 0.045);
  const pick = living[0] || movers[0] || null;
  log('');
  if (pick) log(`  → 选中活靶 (${pick.x.toFixed(3)}, ${pick.y.toFixed(3)}) dx=${pick.dx} 面积=${pick.area}`);
  else log('  ⚠ 没有检测到会动的目标，退回"离准星最近的暗块"');

  const dBefore = jparse(await evalJs('JSON.stringify(window.__reticle(0.030,0.034,115))'), null);
  log('  准星基线 D: ' + JSON.stringify(dBefore));
  await shot('align-00-before');

  log('');
  log('=== 阶段 2：单次触摸内闭环对准 → 保持 → 释放 ===');
  const resRaw = await evalJs(`window.__alignFire(${JSON.stringify({
    retX: RET_X, gain: 0.40, maxSteps: 16, stepMs: 330, holdMs: 400,
    seed: pick ? { x: pick.x, y: pick.y } : null
  })})`);
  const rel = jparse(resRaw, null);
  if (!rel) log('  ⚠ 手势返回异常: ' + String(resRaw).slice(0, 200));
  else if (rel.error) log('  ⚠ ' + rel.error);
  else {
    log('  逐步轨迹（step / 手指x / 靶子x / 误差 / 准星D）:');
    rel.trace.forEach((t) => log(`    #${String(t.step).padStart(2)} finger=${t.finger} tx=${t.tx} err=${t.err} D=${t.D}`));
    log(`  是否对准: ${rel.aligned}   释放瞬间: ${JSON.stringify(rel.atRelease)}`);
  }

  log('');
  log('=== 阶段 3：释放后判定 ===');
  await sleep(4000);
  const dAfter = jparse(await evalJs('JSON.stringify(window.__reticle(0.030,0.034,115))'), null);
  log('  释放后准星 D: ' + JSON.stringify(dAfter));
  await shot('align-01-after');
  await sleep(3500);
  const dLater = jparse(await evalJs('JSON.stringify(window.__reticle(0.030,0.034,115))'), null);
  log('  再 3.5s 后准星 D: ' + JSON.stringify(dLater));
  await shot('align-02-later');

  const waitN = tutLog.filter((l) => /WaitForHealthComponentsKilled/.test(l) && /total=/.test(l)).length;
  const progN = tutLog.filter((l) => /GotoNextLevel|Level activated|TrackTutorial/.test(l)).length;

  log('');
  log('=== 判定 ===');
  log('  文本日志尾部: ' + (tutLog.slice(-4).join('  |  ') || '(none)'));
  const frac = rel && rel.atRelease ? rel.atRelease.frac : 0;
  if (rel && rel.aligned && frac >= 0.15) {
    log('  ✔ 目标是真正对准了（|err|<0.012 且 D=' + frac + '）');
    log('    → 若教程未前进，可判定"释放不开火"（FAIL），下一步转向 WASM 诊断补丁');
  } else if (rel && !rel.aligned) {
    log('  ⚠ INCONCLUSIVE：16 步内没收敛（末次 err=' + (rel.trace.length ? rel.trace[rel.trace.length - 1].err : '?') + '）');
  } else {
    log('  ⚠ INCONCLUSIVE：对准了但准星 D 只有 ' + frac + '，目标可能已被准星笔画遮掉或并非真靶');
  }

  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
