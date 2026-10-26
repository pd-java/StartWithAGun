/**
 * autoplay-aimgrid.mjs —— 用页内毫秒级视觉做闭环瞄准，再用「网格扫描」找真正的命中点
 *
 * 前置结论（已实测）：
 *  - 按下点与瞄准无关，准星固定在屏幕 (0.5000, 0.4994)
 *  - 拖动转视角；世界位移 = -g·拖动  （横向 g≈0.35，纵向 g≈0.82 且同号）
 *  - 开火链路是通的：SimulateShot 真的跑了，sphereHits=2，但首个命中体没有 HealthComponent
 *    （SIM_rej_noHealth=1）→ 不是"枪打不响"，是"没打在人身上"
 *  - CDP 截图 + target_scan 一帧 25 秒，闭环必然失效 → 本脚本改用页内 rAF 采样
 *
 * 本脚本要回答三个问题：
 *  P1 拖动到底有没有转动相机？（用射线方向 dir 直接判，不靠视觉）
 *  P2 把红标压到准星上之后，能不能打出伤害？
 *  P3 若不能，就以红标为原点做屏幕网格扫描，找出「命中活体」的那个偏移
 *
 * 用法: node tools/autoplay-aimgrid.mjs [url] [mode]
 *   mode = calib | sweep | full   (默认 full)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const MODE = process.argv[3] || 'full';
const ROOT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun';
const OUT = ROOT + '/.workbuddy/probe-out';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9409;
const profile = mkdtempSync(join(tmpdir(), 'cdp-grid-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1000,1000', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  'http://127.0.0.1:8848/robots.txt'
], { stdio: 'ignore' });
process.on('exit', () => { try { child.kill(); } catch (e) {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const RETX = 0.5, RETY = 0.4994;

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
  var d = [f(g.main_LD_rayDx), f(g.main_LD_rayDy), f(g.main_LD_rayDz)];
  var o = [f(g.main_LD_rayOx), f(g.main_LD_rayOy), f(g.main_LD_rayOz)];
  var yaw = Math.atan2(d[2], d[0]) * 180 / Math.PI;
  var pitch = Math.asin(Math.max(-1, Math.min(1, d[1] / (Math.hypot(d[0], d[1], d[2]) || 1)))) * 180 / Math.PI;
  return {
    sphereHits: g.main_VAL_sphereHits,
    hitDist: f(g.main_LD_hitDist),
    hitPt: [f(g.main_LD_hitPointX), f(g.main_LD_hitPointY), f(g.main_LD_hitPointZ)],
    origin: o, dir: d,
    yaw: +yaw.toFixed(2), pitch: +pitch.toFixed(2)
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
window.__fsInit = function () {
  if (window.__fsBuf) return 'ok';
  window.__fsBuf = document.createElement('canvas');
  window.__fsCtx = window.__fsBuf.getContext('2d', { willReadFrequently: true });
  return 'ok';
};
window.__fast = function (W) {
  W = W || 480;
  return new Promise(function (resolve) {
    var settled = false;
    var to = setTimeout(function () { if (!settled) { settled = true; resolve({ err: 'timeout' }); } }, 4000);
    window.requestAnimationFrame(function () {
      if (settled) return;
      settled = true; clearTimeout(to);
      try {
        var cv = document.querySelector('canvas');
        if (!cv || !cv.width) return resolve({ err: 'nocanvas' });
        var H = Math.max(1, Math.round(W * cv.height / cv.width));
        var b = window.__fsBuf, c = window.__fsCtx;
        if (b.width !== W || b.height !== H) { b.width = W; b.height = H; }
        c.drawImage(cv, 0, 0, W, H);
        var d = c.getImageData(0, 0, W, H).data;
        var px = [], py = [];
        for (var y = 0; y < H; y++) {
          var row = y * W * 4;
          for (var x = 0; x < W; x++) {
            var i = row + x * 4;
            var r = d[i], g = d[i + 1], bl = d[i + 2];
            if (r >= 150 && g <= 100 && bl <= 100 && r - g >= 70) { px.push(x); py.push(y); }
          }
        }
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
        resolve({ w: W, h: H, marks: groups });
      } catch (e) { resolve({ err: String(e && e.message || e).slice(0, 120) }); }
    });
  });
};
/* 多帧并集取红标（红标会闪，单帧可能丢）—— 必须逐帧串行，同一帧取三次没有意义 */
window.__marks = function (frames) {
  var all = [];
  return (function step(k) {
    if (k >= (frames || 3)) {
      all.sort(function (a, b) { return b.n - a.n; });
      return all;
    }
    return window.__fast(720).then(function (r) {
      (r.marks || []).forEach(function (m) {
        var hit = all.filter(function (p) { return Math.abs(p.x - m.x) < 0.02 && Math.abs(p.y - m.y) < 0.02; })[0];
        if (hit) { hit.x = (hit.x * hit.k + m.x) / (hit.k + 1); hit.y = (hit.y * hit.k + m.y) / (hit.k + 1); hit.k++; hit.n += m.n; }
        else all.push({ x: m.x, y: m.y, n: m.n, k: 1 });
      });
      return step(k + 1);
    });
  })(0);
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
    if (r.exceptionDetails) { log('   [ev-err]', String(r.exceptionDetails.exception?.description || '').slice(0, 200)); return null; }
    return r.result.value;
  };
  const j = async (e) => await ev(e);

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
  await ev('window.__fsInit()');
  await ev('window.__resetAll()');

  const marks = async () => await j('window.__marks(3)');
  const geo = async () => await j('window.__geo()');
  log('\n=== 环境自检 ===');
  log('  main exports 里带 table/wasmTable 的：' + JSON.stringify(await j(
    'Object.keys(window.__wasmMainExports||{}).filter(function(k){return /table|Table/.test(k)})')));
  log('  GameGlobal 里的 table：' + JSON.stringify(await j(
    'Object.keys(GameGlobal||{}).filter(function(k){return /table|wasm/i.test(k)})')));
  log('  画布尺寸：' + JSON.stringify(await j(
    '(function(){var c=document.querySelector("canvas");return c?{w:c.width,h:c.height,cw:c.clientWidth,ch:c.clientHeight,dpr:window.devicePixelRatio,iw:innerWidth,ih:innerHeight}:null})()')));
  const nearest = (ms) => {
    let best = null, bd = 9;
    for (const m of ms) { const d = Math.hypot(m.x - RETX, m.y - RETY); if (d < bd) { bd = d; best = m; } }
    return best;
  };
  const shoot = async () => {
    await ev('window.__resetAll()');
    await sleep(80);
    await ev('window.__fire(0.5, 0.72, 380)');
    await sleep(2200);
    const d = await j('window.__dbg()');
    const g = await geo();
    return {
      geo: g,
      rej: { flag76: d.main_BR_SIM_rej_flag76 || 0, noHealth: d.main_BR_SIM_rej_noHealth || 0, notAlive: d.main_BR_SIM_rej_notAlive || 0 },
      sim: d.main_SimulatorSimulateShot_in || 0,
      shoot: d.main_Shoot_in || 0,
      hasHealth: d.main_HasHealthInShotRadius_r1 || 0,
      dmg: d.main_TakeDamage_in || 0,
      kill: d.main_HealthKill_in || 0,
      mult: d.main_HitMultiplierBodyPart_in || 0,
      tutAlive: d.main_VAL_tutAliveCount,
    };
  };
  const line = (tag, r) =>
    log(`  ${tag.padEnd(18)} shoot=${r.shoot} hh=${r.hasHealth} sim=${r.sim} hits=${String(r.geo.sphereHits).padStart(2)} ` +
        `dist=${r.geo.hitDist.toFixed(1).padStart(5)} ` +
        `yaw=${String(r.geo.yaw).padStart(8)} pitch=${String(r.geo.pitch).padStart(7)} ` +
        `rej(${r.rej.flag76},${r.rej.noHealth},${r.rej.notAlive}) dmg=${r.dmg} kill=${r.kill} tut=${r.tutAlive}`);

  // ── P0：基线 ─────────────────────────────────────────────
  log('\n=== P0 基线射击 ===');
  let m0 = nearest(await marks());
  log(`  红标 ${JSON.stringify(m0)}  其它=${(await marks()).length} 个`);
  const b0 = await shoot();
  line('baseline', b0);

  // ── P1：拖动是否转动相机 ─────────────────────────────────
  log('\n=== P1 拖动 → 相机（射线方向直接判）===');
  await ev('window.__drag(0.5,0.70,0.06,0,12,35)');
  await sleep(400);
  const b1 = await shoot();
  line('drag +x0.06', b1);
  log(`  Δyaw=${(b1.geo.yaw - b0.geo.yaw).toFixed(2)}°  Δpitch=${(b1.geo.pitch - b0.geo.pitch).toFixed(2)}°`);

  await ev('window.__drag(0.5,0.70,0,0.06,12,35)');
  await sleep(400);
  const b2 = await shoot();
  line('drag +y0.06', b2);
  log(`  Δyaw=${(b2.geo.yaw - b1.geo.yaw).toFixed(2)}°  Δpitch=${(b2.geo.pitch - b1.geo.pitch).toFixed(2)}°`);

  // 视觉增益自校准：读红标屏幕位移
  log('\n=== P2 视觉增益自校准 ===');
  let mA = nearest(await marks());
  await ev('window.__drag(0.5,0.70,0.05,0,12,35)');
  await sleep(400);
  let mB = nearest(await marks());
  const gx = (mA && mB) ? (mA.x - mB.x) / 0.05 : 0.35;
  await ev('window.__drag(0.5,0.70,0,0.05,12,35)');
  await sleep(400);
  let mC = nearest(await marks());
  const gy = (mB && mC) ? (mC.y - mB.y) / 0.05 : 0.82;
  log(`  拖 +x0.05: ${mA && mA.x} → ${mB && mB.x}   gx=${gx.toFixed(3)}`);
  log(`  拖 +y0.05: ${mB && mB.y} → ${mC && mC.y}   gy=${gy.toFixed(3)}`);
  const GX = (Math.abs(gx) > 0.08 && Math.abs(gx) < 2) ? gx : 0.35;
  const GY = (Math.abs(gy) > 0.08 && Math.abs(gy) < 2.5) ? gy : 0.82;
  log(`  生效增益 GX=${GX.toFixed(3)} GY=${GY.toFixed(3)}`);

  // ── 闭环锁定：把红标压到准星 (0,0) 处 ────────────────────
  const lock = async (offX, offY, tag) => {
    let m = nearest(await marks());
    for (let it = 1; it <= 7; it++) {
      if (!m) { m = nearest(await marks()); if (!m) return null; }
      const ex = m.x - (RETX + offX), ey = m.y - (RETY + offY);
      log(`    ${tag} 迭代${it} 红标(${m.x.toFixed(4)},${m.y.toFixed(4)}) 误差(${ex.toFixed(4)},${ey.toFixed(4)})`);
      if (Math.abs(ex) < 0.006 && Math.abs(ey) < 0.008) return m;
      const dx = Math.max(-0.09, Math.min(0.09, ex / GX));
      const dy = Math.max(-0.09, Math.min(0.09, -ey / GY));
      await ev(`window.__drag(0.5,0.70,${dx.toFixed(4)},${dy.toFixed(4)},10,30)`);
      await sleep(320);
      m = nearest(await marks());
    }
    return m;
  };

  log('\n=== P3 红标压准星后开火 ===');
  const ml = await lock(0, 0, 'lock');
  if (ml) log(`  锁定 (${ml.x.toFixed(4)},${ml.y.toFixed(4)}) 残差=${Math.hypot(ml.x - RETX, ml.y - RETY).toFixed(4)}`);
  const b3 = await shoot();
  line('mark@reticle', b3);
  if (b3.dmg > 0 || b3.kill > 0) { log('\n  ✔✔ 命中！红标=命中点'); }

  // ── P4：以红标为原点做屏幕网格扫描 ───────────────────────
  if (MODE !== 'calib' && b3.dmg === 0) {
    log('\n=== P4 网格扫描（红标在准星上，再偏移采样）===');
    log('  约定：offY>0 = 红标在准星下方（= 瞄在红标上方）');
    const rows = [];
    const DYS = [0, 0.02, 0.04, 0.06, 0.09, 0.12, 0.15, 0.18];
    for (const dy of DYS) {
      const m = await lock(0, dy, `dy${dy}`);
      if (!m) { log(`  dy=${dy} 红标丢失`); continue; }
      const r = await shoot();
      rows.push({ dx: 0, dy, m, r });
      line(`dy=${dy.toFixed(3)}`, r);
      if (r.dmg > 0 || r.kill > 0) { log(`\n  ✔✔ dy=${dy} 命中活体，停止纵向扫描`); break; }
    }
    const hitRow = rows.find((x) => x.r.dmg > 0 || x.r.kill > 0);
    if (!hitRow) {
      log('\n  纵向全负 → 改扫横向（保持 dy=0.06）');
      for (const dx of [-0.06, -0.04, -0.02, 0.02, 0.04, 0.06]) {
        const m = await lock(dx, 0.06, `dx${dx}`);
        if (!m) { log(`  dx=${dx} 红标丢失`); continue; }
        const r = await shoot();
        rows.push({ dx, dy: 0.06, m, r });
        line(`dx=${dx.toFixed(3)}`, r);
        if (r.dmg > 0 || r.kill > 0) { log(`\n  ✔✔ dx=${dx} 命中活体`); break; }
      }
    }
    writeFileSync(join(OUT, 'aimgrid.json'), JSON.stringify({ b0, b1, b2, b3, rows, GX, GY }, null, 1));
    log('\n结果 → ' + join(OUT, 'aimgrid.json'));
  }

  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
