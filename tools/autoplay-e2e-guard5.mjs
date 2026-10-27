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
const PORT = 9435;
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
  // 注意：靶子要等教学 Sequencer 建好才出现，启动时序会有几十秒抖动，
  // 所以这里轮询到 240s，并且同时打印感知链路的读数，便于区分「没靶子」和「读不到」。
  let tut = null;
  for (let i = 0; i < 120; i++) {
    tut = await ev('window.__tutElems()');
    if (tut && tut.elems && tut.elems.length) break;
    if (i % 15 === 0) {
      const per = await ev('(function(){try{var o=window.AutoplayPerception.observe();return JSON.stringify({n:(o.targets||[]).length,luma:o.metrics&&o.metrics.avgLuma})}catch(e){return "perr"}})()');
      log(`  t=${(i + 1) * 2}s self=${tut && tut.self} 感知=${per}`);
    }
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
  // 没有靶子不终止：闸门语义与生命周期验证不依赖靶子存在，
  // 反而「没有靶子的场景」正是本次要证明闸门不会错误阻断的环境。
  if (!targets.length) log('  ⚠ 没有靶子 —— 跳过瞄准标定，直接验证闸门与生命周期');
  else {
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
    writeFileSync(join(OUT, 'geo-aim5.json'), JSON.stringify({ c, targets, gYaw, gPitch }, null, 1));
    try { child.kill(); } catch (e) {} process.exit(4);
  }
  }

  // ── 第 4 段：闸门语义验证 ─────────────────────────────────────────
  // 目的：证明「诊断」与「决策」已分离 ——
  //   相机射线未接触 → 只记录 cameraRayContact=false，不拦截
  //   确实超出射程   → 才拦截，且 reason=beyond-range
  log('\n=== 4) 闸门语义 ===');
  log(`  available = ${JSON.stringify(await ev('window.AutoplayRange.available()'))}`);
  const p0 = JSON.parse(await ev('JSON.stringify(window.AutoplayRange.probe({force:true}))'));
  log(`  probe(): verdict=${p0.verdict} cameraRayContact=${JSON.stringify(p0.cameraRayContact)} ` +
      `cameraRayDistance=${JSON.stringify(p0.cameraRayDistance)} weaponRangeCheck=${p0.weaponRangeCheck} range=${p0.range}`);
  for (const [nx, ny] of [[0.5, 0.5], [0.42, 0.47], [0.48, 0.43]]) {
    const g = JSON.parse(await ev(`JSON.stringify(window.AutoplayRange.allowShotAt(${nx},${ny}))`));
    log(`  allowShotAt(${nx},${ny}) -> allowed=${g.allowed} reason=${g.reason} via=${g.via || '-'} ` +
        `weaponRangeCheck=${(g.diag && g.diag.weaponRangeCheck) || g.weaponRangeCheck} ` +
        `cameraRayContact=${JSON.stringify((g.diag && g.diag.cameraRayContact) !== undefined && g.diag ? g.diag.cameraRayContact : g.cameraRayContact)}`);
  }

  // ── 第 5 段：控制器生命周期 + 新语义下的行为 ──────────────────────
  log('\n=== 5) 控制器 20s（新语义：无接触不拦截）===');
  log(`  start() = ${JSON.stringify(await ev('window.Autoplay.start()'))}`);
  for (let i = 1; i <= 4; i++) {
    await sleep(5000);
    const st = JSON.parse(await ev('JSON.stringify(window.Autoplay.getStatus())'));
    const lg = st.lastGate || {};
    log(`  t=${i * 5}s state=${st.state} 射击=${st.stats.shots} 拦截=${st.stats.blocked} ` +
        `无接触放行=${st.stats.firedWithoutContact} verdict=${st.range && st.range.verdict} ` +
        `gate=${lg.allowed ? 'allow' : 'block'}/${lg.reason} contact=${JSON.stringify(st.range && st.range.cameraRayContact)}`);
  }

  // ── 第 6 段：暂停保持 / 恢复 / 停止 ───────────────────────────────
  log('\n=== 6) 暂停·恢复·停止 ===');
  await ev('window.Autoplay.pause()');
  const s1 = JSON.parse(await ev('JSON.stringify(window.Autoplay.getStatus())'));
  log(`  pause -> ${s1.state} 射击=${s1.stats.shots}`);
  await sleep(2500);
  const s2 = JSON.parse(await ev('JSON.stringify(window.Autoplay.getStatus())'));
  log(`  2.5s 后 -> ${s2.state} 射击=${s2.stats.shots} ${s2.stats.shots === s1.stats.shots ? '✔ 计数保持' : '✘ 计数仍在增长'}`);
  await ev('window.Autoplay.resume()');
  await sleep(3000);
  const s3 = JSON.parse(await ev('JSON.stringify(window.Autoplay.getStatus())'));
  log(`  resume -> ${s3.state} ticks=${s3.stats.ticks} ${s3.stats.ticks > s2.stats.ticks ? '✔ 在推进' : '✘ 未推进'}`);
  await ev('window.Autoplay.stop()');
  const s4 = JSON.parse(await ev('JSON.stringify(window.Autoplay.getStatus())'));
  log(`  stop -> ${s4.state}`);

  const fin = s4;
  writeFileSync(join(OUT, 'e2e-guard5.json'), JSON.stringify({ probe: p0, fin }, null, 1));
  log(`\n最终: 射击=${fin.stats.shots} 拦截=${fin.stats.blocked} 无接触放行=${fin.stats.firedWithoutContact}`);
  log('已写 .workbuddy/probe-out/e2e-guard5.json');
  try { child.kill(); } catch (e) {}
  process.exit(0);
}

main().catch((e) => { log('FATAL', e && e.message); try { child.kill(); } catch (x) {} process.exit(1); });
