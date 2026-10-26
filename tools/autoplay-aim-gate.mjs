/**
 * autoplay-geo-aim2.mjs —— 纯几何瞄准 v2（坐标轴已修正为 z-up）
 *
 * v1 的错误：用「forward 里绝对值最大的分量」猜上轴，这里 y 分量 0.569 > z 分量 0.253，
 *            于是误判成 y-up，整个闭环发散。
 * 正解：**z 是上轴**。证据：两个靶子的世界坐标 z=0.35（正好是脚踩地面的高度），
 *      而相机 z=26.88；同时 |target-camera| 与 WorldToScreenPoint 返回的深度 94.2/121.6 完全吻合。
 *
 * 真实误差（v1 日志里已经量到了）：
 *   #0  95.1m   Δyaw = +8.3°   Δpitch = -1.5°
 *   #1 122.1m   Δyaw = -4.7°   Δpitch = +2.1°
 * → 横向差 8°，而此前所有扫描只扫竖直方向，所以永远 `noHealth=1`。
 *
 * 用法: node tools/autoplay-geo-aim2.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const ROOT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun';
const OUT = ROOT + '/.workbuddy/probe-out';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9423;
const profile = mkdtempSync(join(tmpdir(), 'cdp-geo4-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1000,1000', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  'http://127.0.0.1:8848/robots.txt'
], { stdio: 'ignore' });
process.on('exit', () => { try { child.kill(); } catch (e) {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const R2D = 180 / Math.PI;

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
window.__u32 = function (a) { try { return new DataView(window.__wasmMemory.buffer).getUint32(a >>> 0, true); } catch (e) { return 0; } };
window.__f32at = function (a) { try { return new DataView(window.__wasmMemory.buffer).getFloat32(a >>> 0, true); } catch (e) { return NaN; } };
window.__cstr = function (a) {
  var m = window.__wasmMemory; if (!m || !a) return null;
  var u8; try { u8 = new Uint8Array(m.buffer); } catch (e) { return null; }
  var s = '';
  for (var i = 0; i < 90; i++) { var b = u8[(a + i) >>> 0]; if (!b) break; if (b < 0x20 || b > 0x7e) return null; s += String.fromCharCode(b); }
  return s.length >= 2 ? s : null;
};
window.__typeName = function (o) { if (!o) return null; var k = window.__u32(o); return k ? (window.__cstr(window.__u32(k + 8)) || window.__cstr(window.__u32(k + 16))) : null; };
window.__T = (window.__wasmMainExports || {}).__indirect_function_table;
window.__S = 0;
window.__alloc = function () {
  window.__S = window.__wasmMainExports.malloc(1024);
  var d = new DataView(window.__wasmMemory.buffer);
  for (var i = 0; i < 1024; i += 4) d.setUint32(window.__S + i, 0, true);
  return window.__S;
};
window.__vec = function (off) { var b = window.__S + (off || 0); return [window.__f32at(b), window.__f32at(b + 4), window.__f32at(b + 8)]; };
window.__call = function (slot, args) {
  var f; try { f = window.__T.get(slot); } catch (e) { return 'get-err'; }
  if (typeof f !== 'function') return 'null-fn';
  try { return f.apply(null, args || []); } catch (e) { return 'CALL_ERR:' + String(e && e.message || e).slice(0, 60); }
};
window.__cam = function () { return window.__call(7701, [0]); };
window.__xf = function (o) { return window.__call(4877, [o, 0]); };
window.__pos = function (tr, off) { return window.__call(96638, [tr, window.__S + (off || 0), 0]); };
window.__fwd = function (tr, off) { return window.__call(6797, [window.__S + (off || 0), tr, 0]); };
window.__alive = function (hc) { return window.__call(7052, [hc, 0]); };
window.__hp = function (hc) { return window.__call(7223, [hc, 0]); };
window.__gate = function (w, r) { return window.__call(6749, [w, r, 0]); };
window.__weapon = function () {
  var g = window.__dbg();
  var st = g.main_CAP_shootThis || 0;
  if (!st) return { err: 'no-shootThis' };
  var ch = window.__u32(st + 16);
  var cw = ch ? window.__u32(ch + 52) : 0;
  var w = cw ? window.__call(5696, [cw, 0]) : 0;
  return { st: st, stType: window.__typeName(st), ch: ch, cw: cw, w: w, wType: window.__typeName(w), radius: window.__f32at(st + 180), spread: window.__f32at(st + 152) };
};
window.__tutElems = function () {
  var g = window.__dbg();
  var self = g.main_CAP_tutSeqEvent || 0;
  var out = { self: self, type: window.__typeName(self), elems: [] };
  if (!self) return out;
  var list = window.__u32(self + 32);
  if (!list) return out;
  out.size = window.__u32(list + 12);
  var items = window.__u32(list + 8);
  var n = Math.min(out.size | 0, 8);
  for (var i = 0; i < n; i++) out.elems.push({ i: i, ptr: window.__u32(items + 16 + i * 4) });
  return out;
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
  var cl = function (v) { return Math.max(0.04, Math.min(0.96, v)); };
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

/* z 向上：yaw 绕 z，pitch = asin(z) */
const yawZ = (v) => Math.atan2(v[1], v[0]) * R2D;
const pitchZ = (v) => Math.asin(Math.max(-1, Math.min(1, v[2] / (Math.hypot(v[0], v[1], v[2]) || 1)))) * R2D;
const wrap = (a) => { while (a > 180) a -= 360; while (a < -180) a += 360; return a; };

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
    if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description || '').slice(0, 200) };
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
    if (i % 10 === 0) log(`  t=${(i + 1) * 3}s luma=${l}`);
    if (i % 2 === 0) await ev('window.__wxInjectTouch("start",0.5,0.5), window.__wxInjectTouch("end",0.5,0.5)');
  }
  if (!ok) { log('✘ 未进入战斗'); try { child.kill(); } catch (e) {} process.exit(2); }

  await ev('(function(){var b=document.getElementById("ap-fold"); if(b) b.click(); return 1})()');
  await ev(HELPERS);
  await ev('window.__alloc()');

  const cam = await ev('window.__cam()');
  const camT = await ev(`window.__xf(${cam})`);
  log(`  camera=${cam} transform=${camT}`);

  const readCam = async () => {
    await ev(`window.__pos(${camT},0)`);
    const p = await ev('window.__vec(0)');
    await ev(`window.__fwd(${camT},16)`);
    const f = await ev('window.__vec(16)');
    return { p, f, yaw: yawZ(f), pitch: pitchZ(f) };
  };

  log('\n=== 1) 相机 ===');
  let c = await readCam();
  log(`  pos=(${c.p.map((v) => v.toFixed(2)).join(', ')})  fwd=(${c.f.map((v) => v.toFixed(4)).join(', ')})`);
  log(`  z-up: yaw=${c.yaw.toFixed(2)}° pitch=${c.pitch.toFixed(2)}°`);

  log('\n=== 2) 等靶子 ===');
  let tut = null;
  for (let i = 0; i < 45; i++) {
    tut = await ev('window.__tutElems()');
    if (tut && tut.elems && tut.elems.length) break;
    await sleep(2000);
  }
  const targets = [];
  for (const e of (tut && tut.elems) || []) {
    const tr = await ev(`window.__xf(${e.ptr})`);
    await ev(`window.__pos(${tr},32)`);
    const p = await ev('window.__vec(32)');
    const d = [p[0] - c.p[0], p[1] - c.p[1], p[2] - c.p[2]];
    targets.push({ i: e.i, hc: e.ptr, tr, pos: p, dist: Math.hypot(d[0], d[1], d[2]), yaw: yawZ(d), pitch: pitchZ(d) });
    const t = targets[targets.length - 1];
    log(`  #${e.i} pos=(${p.map((v) => v.toFixed(2)).join(', ')}) dist=${t.dist.toFixed(1)}m yaw=${t.yaw.toFixed(2)}° pitch=${t.pitch.toFixed(2)}°`);
    log(`      当前误差 Δyaw=${wrap(t.yaw - c.yaw).toFixed(2)}° Δpitch=${(t.pitch - c.pitch).toFixed(2)}°`);
  }
  if (!targets.length) { log('✘ 没有靶子'); try { child.kill(); } catch (e) {} process.exit(3); }

  log('\n=== 2.5) 每个靶子的真实血条状态 ===');
  for (const t of targets) {
    t.alive = await ev(`window.__alive(${t.hc})`);
    t.hp = await ev(`window.__hp(${t.hc})`);
    log(`  #${t.i} IsAlive=${JSON.stringify(t.alive)} CurrentHealth=${JSON.stringify(t.hp)}`);
  }
  targets.sort((a, b) => (b.hp || 0) - (a.hp || 0));
  const T0 = targets[0];
  log(`  → 选 #${T0.i}（hp=${T0.hp}）作为射击对象`);

  log('\n=== 3) 增益标定（z-up，读 forward 变化）===');
  let base = await readCam();
  await ev('window.__drag(0.5,0.70,0.05,0,12,30)');
  await sleep(450);
  let a1 = await readCam();
  const gYaw = wrap(a1.yaw - base.yaw) / 0.05;
  const cross1 = (a1.pitch - base.pitch) / 0.05;
  await ev('window.__drag(0.5,0.70,0,0.05,12,30)');
  await sleep(450);
  let a2 = await readCam();
  const gPitch = (a2.pitch - a1.pitch) / 0.05;
  const cross2 = wrap(a2.yaw - a1.yaw) / 0.05;
  log(`  拖 +x0.05: Δyaw=${(a1.yaw - base.yaw).toFixed(2)}° Δpitch=${(a1.pitch - base.pitch).toFixed(2)}°  → gYaw=${gYaw.toFixed(2)}°/单位 交叉=${cross1.toFixed(2)}`);
  log(`  拖 +y0.05: Δyaw=${(a2.yaw - a1.yaw).toFixed(2)}° Δpitch=${(a2.pitch - a1.pitch).toFixed(2)}°  → gPitch=${gPitch.toFixed(2)}°/单位 交叉=${cross2.toFixed(2)}`);

  if (Math.abs(gYaw) < 1 || Math.abs(gPitch) < 1) {
    log('\n✘ 增益异常，放弃（拖动可能不控相机）');
    writeFileSync(join(OUT, 'geo-aim4.json'), JSON.stringify({ c, targets, gYaw, gPitch }, null, 1));
    try { child.kill(); } catch (e) {} process.exit(4);
  }

  log('\n=== 4) 按「脚底 + 高度偏移」扫描命中带 ===');
  const result = [];
  const OFFZ = [0.6, 1.0, 1.4];
  for (const offZ of OFFZ) {
    log(`  ── 瞄 z+${offZ.toFixed(1)}m ──`);
    for (let it = 1; it <= 8; it++) {
      const cur = await readCam();
      await ev(`window.__pos(${T0.tr},32)`);
      const p = await ev('window.__vec(32)');
      const d = [p[0] - cur.p[0], p[1] - cur.p[1], p[2] + offZ - cur.p[2]];
      let eY = wrap(yawZ(d) - cur.yaw), eP = pitchZ(d) - cur.pitch;
      if (it === 1) log(`    起始 Δyaw=${eY.toFixed(3)}° Δpitch=${eP.toFixed(3)}°`);
      if (Math.abs(eY) < 0.25 && Math.abs(eP) < 0.25) { if (it > 1) log(`    ✔ 对准（迭代${it}）`); break; }
      let dx = eY / gYaw, dy = eP / gPitch;
      dx -= cross2 * dy / gYaw;
      dy -= cross1 * dx / gPitch;
      dx = Math.max(-0.05, Math.min(0.05, dx * 0.9));
      dy = Math.max(-0.05, Math.min(0.05, dy * 0.9));
      await ev(`window.__drag(0.5,0.70,${dx.toFixed(4)},${dy.toFixed(4)},14,30)`);
      await sleep(400);
    }
    // 先看看这道门在「瞄准后」是什么态度
    if (!globalThis.__wGot) {
      await ev('window.AutoplayInput.click(0.5,0.72,300)');
      await sleep(1800);
      const wInfo = await ev('window.__weapon()');
      log('    武器链: ' + JSON.stringify(wInfo));
      globalThis.__wInfo = wInfo;
      globalThis.__wGot = true;
    }
    const W = (globalThis.__wInfo && globalThis.__wInfo.w) || 0;
    if (W) {
      const gs = [];
      for (const r of [2, 3, 5, 10, 30]) gs.push(r + ':' + (await ev(`window.__gate(${W},${r})`)));
      log('    gate(w, r) → ' + gs.join('  '));
    }
    await ev('window.__resetAll()');
    await sleep(120);
    await ev('window.__fire(0.5,0.72,380)');
    await sleep(2300);
    const d = await ev('window.__dbg()');
    const r = {
      offZ,
      shoot: d.main_Shoot_in || 0, radiusRej: d.main_BR_rej_cover_hit || 0, barrelsRej: d.main_BR_rej_barrels || 0,
      blockRej: d.main_BR_rej_blockflag || 0, sim: d.main_SimulatorSimulateShot_in || 0,
      hits: d.main_VAL_sphereHits || 0, f76: d.main_BR_SIM_rej_flag76 || 0,
      noH: d.main_BR_SIM_rej_noHealth || 0, nA: d.main_BR_SIM_rej_notAlive || 0,
      dmg: d.main_TakeDamage_in || 0, kill: d.main_HealthKill_in || 0,
      rangeKill: d.main_RangeTargetOnKill_in || 0, tut: d.main_VAL_tutAliveCount || 0,
    };
    result.push(r);
    log(`    Shoot=${r.shoot} 半径拒=${r.radiusRej} 弹匣拒=${r.barrelsRej} block拒=${r.blockRej} ` +
        `Sim=${r.sim} hits=${r.hits} 筛除(f76=${r.f76},noH=${r.noH},nA=${r.nA}) 伤害=${r.dmg} 击杀=${r.kill} RangeKill=${r.rangeKill} 教程存活=${r.tut}`);
    if (r.dmg > 0 || r.kill > 0 || r.rangeKill > 0) { log('    ★★★ 命中！停止扫描'); break; }
  }


  writeFileSync(join(OUT, 'geo-aim4.json'), JSON.stringify({ cam: c, targets, gYaw, gPitch, cross1, cross2, result }, null, 1));
  log('\n结果 → ' + join(OUT, 'geo-aim4.json'));
  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
