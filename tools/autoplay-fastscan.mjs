/**
 * autoplay-fastscan.mjs —— 页内毫秒级视觉采样（替换 CDP 截图 + target_scan.py 的 25s 链路）
 *
 * 背景：CDP `Page.captureScreenshot` 在这台机器的 headless swiftshader 下要 25 秒，
 * 导致「看到靶子」到「开火」之间有半分钟延迟，闭环瞄准必然失效。
 *
 * 本脚本验证一条新链路：
 *   rAF 回调内 drawImage(canvas) → getImageData → JS 找红标
 * 全部发生在页面里，不经过 CDP，不落盘，不 spawn python。
 *
 * 用法: node tools/autoplay-fastscan.mjs [url] [rounds]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const ROUNDS = Number(process.argv[3] || 10);
const ROOT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun';
const OUT = ROOT + '/.workbuddy/probe-out';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9407;
const profile = mkdtempSync(join(tmpdir(), 'cdp-fast-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1000,1000', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  'http://127.0.0.1:8848/robots.txt'
], { stdio: 'ignore' });
process.on('exit', () => { try { child.kill(); } catch (e) {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/* ── 页内工具（探针读取 + 输入注入）──────────────────────────── */
const HELPERS = `
window.__dbg = function () {
  var out = {};
  function take(o) { if (!o) return; for (var k in o) { try { var v = o[k]; if (v && typeof v === 'object' && typeof v.value === 'number') out[k] = v.value; } catch (e) {} } }
  take(window.__wasmMainExports);
  try { take(GameGlobal.__wasmCode1Instance && GameGlobal.__wasmCode1Instance.exports); } catch (e) {}
  return out;
};
window.__resetAll = function () {
  var n = 0;
  function zero(o) { if (!o) return; for (var k in o) { try { var v = o[k]; if (v && typeof v === 'object' && typeof v.value === 'number') { v.value = 0; n++; } } catch (e) {} } }
  zero(window.__wasmMainExports);
  try { zero(GameGlobal.__wasmCode1Instance && GameGlobal.__wasmCode1Instance.exports); } catch (e) {}
  return n;
};
window.__f32 = function (v) { var b = new ArrayBuffer(4); var dv = new DataView(b); dv.setInt32(0, v | 0, true); return dv.getFloat32(0, true); };
window.__geo = function () {
  var g = window.__dbg(), f = window.__f32;
  return {
    sphereHits: g.main_VAL_sphereHits,
    hitDist: f(g.main_LD_hitDist),
    hitPt: [f(g.main_LD_hitPointX), f(g.main_LD_hitPointY), f(g.main_LD_hitPointZ)],
    origin: [f(g.main_LD_rayOx), f(g.main_LD_rayOy), f(g.main_LD_rayOz)],
    dir: [f(g.main_LD_rayDx), f(g.main_LD_rayDy), f(g.main_LD_rayDz)]
  };
};
window.__fire = function (x, y, holdMs) {
  var I = window.AutoplayInput;
  return new Promise(function (res) {
    I.press(x, y);
    var h = 0;
    var hv = setInterval(function () {
      h++; I.moveTo(x, y);
      if (h * 100 >= holdMs) { clearInterval(hv); I.release(x, y); res('fired'); }
    }, 100);
  });
};
window.__drag = function (x0, y0, dx, dy, steps, stepMs) {
  var I = window.AutoplayInput;
  var cl = function (v) { return Math.max(0.03, Math.min(0.97, v)); };
  return new Promise(function (res) {
    I.press(cl(x0), cl(y0));
    var n = 0;
    var iv = setInterval(function () {
      n++;
      I.moveTo(cl(x0 + dx * n / steps), cl(y0 + dy * n / steps));
      if (n >= steps) { clearInterval(iv); I.release(cl(x0 + dx), cl(y0 + dy)); res('ok'); }
    }, stepMs);
  });
};
'ok'`;

/* ── 页内快扫：rAF 内读画布，找纯红标记 ──────────────────────── */
const FAST = `
window.__fsInit = function () {
  if (window.__fsBuf) return 'ok';
  window.__fsBuf = document.createElement('canvas');
  window.__fsCtx = window.__fsBuf.getContext('2d', { willReadFrequently: true });
  window.__fsStat = { calls: 0, took: [], black: 0 };
  return 'ok';
};
/* 返回 Promise：hooks 下一帧，渲染前读上一帧缓冲 */
window.__fast = function (W) {
  W = W || 480;
  return new Promise(function (resolve) {
    var settled = false;
    var to = setTimeout(function () { if (!settled) { settled = true; resolve({ err: 'timeout' }); } }, 4000);
    window.requestAnimationFrame(function () {
      if (settled) return;
      settled = true; clearTimeout(to);
      var t0 = performance.now();
      try {
        var cv = document.querySelector('canvas');
        if (!cv || !cv.width) return resolve({ err: 'nocanvas' });
        var H = Math.max(1, Math.round(W * cv.height / cv.width));
        var b = window.__fsBuf, c = window.__fsCtx;
        if (b.width !== W || b.height !== H) { b.width = W; b.height = H; }
        c.drawImage(cv, 0, 0, W, H);
        var d = c.getImageData(0, 0, W, H).data;

        var sum = 0;
        var px = [], py = [];
        for (var y = 0; y < H; y++) {
          var row = y * W * 4;
          for (var x = 0; x < W; x++) {
            var i = row + x * 4;
            var r = d[i], g = d[i + 1], bl = d[i + 2];
            sum += r * 0.299 + g * 0.587 + bl * 0.114;
            if (r >= 150 && g <= 100 && bl <= 100 && r - g >= 70) { px.push(x); py.push(y); }
          }
        }
        // 红像素按距离聚类（红标只有几条竖条，点数极少）
        var used = new Uint8Array(px.length), groups = [];
        for (var a = 0; a < px.length; a++) {
          if (used[a]) continue;
          var qx = [a], sx = 0, sy = 0, n = 0;
          used[a] = 1;
          while (qx.length) {
            var k = qx.pop(); sx += px[k]; sy += py[k]; n++;
            for (var m = 0; m < px.length; m++) {
              if (used[m]) continue;
              if (Math.abs(px[m] - px[k]) <= 10 && Math.abs(py[m] - py[k]) <= 14) { used[m] = 1; qx.push(m); }
            }
          }
          if (n >= 3) groups.push({ x: +(sx / n / W).toFixed(4), y: +(sy / n / H).toFixed(4), n: n });
        }
        groups.sort(function (p, q) { return q.n - p.n; });
        var st = window.__fsStat;
        st.calls++; st.took.push(Math.round(performance.now() - t0));
        if (st.took.length > 30) st.took.shift();
        var luma = sum / (W * H);
        if (luma < 2) st.black++;
        resolve({ w: W, h: H, luma: Math.round(luma), ms: Math.round(performance.now() - t0), marks: groups });
      } catch (e) {
        resolve({ err: String(e && e.message || e).slice(0, 160) });
      }
    });
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
function send(m, p = {}, sid) {
  const msg = { id: ++id, method: m, params: p }; if (sid) msg.sessionId = sid;
  return new Promise((res, rej) => { pending.set(msg.id, { resolve: res, reject: rej }); ws.send(JSON.stringify(msg)); });
}
const KEY = (k) => /_in$|_end$|_r\d+$|_BR_|_PT_|_VAL_|_LD_/.test(k);
function pick(o) { const r = {}; for (const k of Object.keys(o || {})) if (KEY(k)) r[k] = o[k]; return r; }
function show(d) { const ks = Object.keys(d); if (!ks.length) return '  (全 0)'; return ks.map((k) => `  ${k.padEnd(30)} ${d[k] > 0 ? '+' + d[k] : d[k]}`).join('\n'); }

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

  const ev = async (e) => {
    const r = await S('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, timeout: 180000 });
    if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description || '').slice(0, 300) };
    return r.result.value;
  };

  await S('Page.navigate', { url: URL_ });
  await sleep(2500);
  await ev('(function(){var b=document.getElementById("start-btn"); if(b) b.click(); return 1})()');
  log('=== 启动 ===');
  let ok = false;
  for (let i = 0; i < 90; i++) {
    await sleep(3000);
    const l = await ev('window.AutoplayPerception.observe().metrics.avgLuma');
    if (typeof l === 'number' && l > 178) { log(`  可玩 @ ${(i + 1) * 3}s luma=${l}`); ok = true; break; }
    if (i % 6 === 0) log(`  t=${(i + 1) * 3}s luma=${l}`);
    if (i % 2 === 0) await ev('window.__wxInjectTouch("start",0.5,0.5), window.__wxInjectTouch("end",0.5,0.5)');
  }
  if (!ok) { log('✘ 未进入战斗'); try { child.kill(); } catch (e) {} process.exit(2); }

  await ev('(function(){var b=document.getElementById("ap-fold"); if(b) b.click(); return 1})()');
  await ev(HELPERS);
  await ev(FAST);
  log('  快扫初始化 =', await ev('window.__fsInit()'));
  log('  可写全局数 =', await ev('window.__resetAll()'));

  log('\n=== 页内快扫延迟（同一帧，连续 ' + ROUNDS + ' 次）===');
  const rows = [];
  for (let i = 0; i < ROUNDS; i++) {
    const r = await ev(`JSON.stringify(window.__fast(480))`);
    const o = JSON.parse(r);
    rows.push(o);
    const ms = o.marks ? o.marks.map((m) => `(${m.x},${m.y})n=${m.n}`).join(' ') : String(o.err);
    log(`  #${String(i + 1).padStart(2)} ${String(o.ms).padStart(4)}ms luma=${o.luma} 红标${o.marks ? o.marks.length : '?'} → ${ms.slice(0, 150)}`);
    await sleep(120);
  }
  const took = rows.filter((r) => r.ms).map((r) => r.ms).sort((a, b) => a - b);
  if (took.length) log(`  中位 ${took[(took.length / 2) | 0]}ms  最小 ${took[0]}ms  最大 ${took[took.length - 1]}ms`);

  // 一致性检查：红标在多次采样间是否稳定（静止靶应几乎不动）
  const first = rows.find((r) => r.marks && r.marks.length);
  if (first) {
    const m0 = first.marks[0];
    const ds = rows.filter((r) => r.marks && r.marks.length).map((r) => Math.hypot(r.marks[0].x - m0.x, r.marks[0].y - m0.y));
    log(`  相对首帧最大漂移 = ${Math.max(...ds).toFixed(4)}`);
  }

  log('\n=== 探针链路自检（打一发）===');
  await ev('window.__resetAll()');
  await sleep(120);
  await ev('window.__fire(0.5, 0.72, 380)');
  await sleep(2400);
  const d = pick(await ev('window.__dbg()'));
  const geo = JSON.parse(await ev('JSON.stringify(window.__geo())'));
  log(show(d));
  log(`  命中数=${geo.sphereHits} 距离=${geo.hitDist.toFixed(2)} 方向=(${geo.dir.map((v) => v.toFixed(3)).join(',')})`);

  log('\n=== 对照：CDP 截图 + target_scan（一次性）===');
  const t0 = Date.now();
  const sh = await S('Page.captureScreenshot', { format: 'png' });
  const shMs = Date.now() - t0;
  const p = join(OUT, 'fastscan-ref.png');
  writeFileSync(p, Buffer.from(sh.data, 'base64'));
  log(`  captureScreenshot 单次 = ${shMs}ms → ${p}`);
  log(`  → 结论：快扫 ${took.length ? took[(took.length / 2) | 0] + 'ms' : '?'} vs 截图 ${shMs}ms`);

  writeFileSync(join(OUT, 'fastscan.json'), JSON.stringify({ rows, geo, d, shMs }, null, 1));
  log('\n结果 → ' + join(OUT, 'fastscan.json'));
  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
