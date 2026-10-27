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
const PORT = 9437;
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
  // ═══════════════════════════════════════════════════════════════
  // 回归测试套件 —— 对应 ChatGPT turn-11 回复里列的 7 项
  // 判定策略用「合成观测」测，不依赖场景里恰好存在 30 m 外的碰撞体。
  // ═══════════════════════════════════════════════════════════════
  const R = [];
  function check(name, ok, detail) {
    R.push({ name, ok: !!ok, detail });
    log(`  ${ok ? '✔ PASS' : '✘ FAIL'}  ${name}${detail ? '  | ' + detail : ''}`);
  }

  // ── 输入调用计数器：用来证明暂停/停止后不再发输入 ──
  const wrapped = await ev(`(function(){
    if (window.__inputCount) return 'already';
    var I = window.AutoplayInput;
    if (!I) return 'no-input-layer';
    window.__inputCount = { press: 0, moveTo: 0, release: 0, click: 0, releaseAll: 0 };
    ['press','moveTo','release','click','releaseAll'].forEach(function (k) {
      if (typeof I[k] !== 'function') return;
      var orig = I[k];
      I[k] = function () { window.__inputCount[k]++; return orig.apply(I, arguments); };
    });
    return 'wrapped';
  })()`);
  const resetCount = () => ev('(function(){var c=window.__inputCount||{};for(var k in c)c[k]=0;return 1})()');
  const readCount = async () => JSON.parse(await ev('JSON.stringify(window.__inputCount||{})'));
  const sumCount = (c) => Object.keys(c).reduce((a, k) => a + (c[k] || 0), 0);
  log(`\n=== 回归测试（输入计数器: ${typeof wrapped === 'string' ? wrapped : 'n/a'}）===`);

  // ── 1) 引擎不可读时，诊断失败不会永久锁死 ──
  const t1 = JSON.parse(await ev(`(function(){
    var R = window.AutoplayRange;
    var before = R.available();
    var saved = window.__wasmMainExports;
    var out = { before: before };
    try {
      window.__wasmMainExports = null;            // 模拟引擎不可读
      out.during = R.available();
      out.probeVerdict = R.probe({ force: true }).verdict;
      out.allowedDuring = R.allowShotAt(0.5, 0.5).allowed;
      out.threw = false;
    } catch (e) { out.threw = String(e).slice(0, 60); }
    window.__wasmMainExports = saved;             // 恢复
    out.after = R.available();
    return JSON.stringify(out);
  })()`));
  check('1 引擎不可读不会永久锁死',
    t1.before === true && t1.during === false && t1.after === true && !t1.threw &&
    t1.probeVerdict === 'UNAVAILABLE' && t1.allowedDuring === true,
    `before=${t1.before} during=${t1.during} after=${t1.after} verdict=${t1.probeVerdict} allowed=${t1.allowedDuring} threw=${t1.threw}`);

  // ── 2) 相机射线无接触点时不判定为超距 ──
  const t2a = JSON.parse(await ev(`JSON.stringify(window.AutoplayRange.decideFromObservation(
    { available: true, weaponRangeCheck: 'unknown', cameraRayContact: false }))`));
  const t2b = JSON.parse(await ev(`JSON.stringify(window.AutoplayRange.allowShot())`));
  check('2a 合成: 无接触 → 放行且不报超距',
    t2a.allowed === true && t2a.reason === 'camera-ray-no-contact' && t2a.weaponRangeCheck === 'unknown',
    `allowed=${t2a.allowed} reason=${t2a.reason} rangeCheck=${t2a.weaponRangeCheck}`);
  check('2b 实测: allowShot() 不返回 beyond-range',
    t2b.reason !== 'beyond-range',
    `reason=${t2b.reason} via=${t2b.via} rangeCheck=${t2b.weaponRangeCheck}`);

  // ── 3) 明确测得的超距接触点会触发阻塞（合成输入，不依赖场景） ──
  const t3 = JSON.parse(await ev(`(function(){
    var D = window.AutoplayRange.decideFromObservation.bind(window.AutoplayRange);
    return JSON.stringify({
      far:  D({ available: true, weaponRangeCheck: 'beyond-range', cameraRayContact: true, hitDistance: 94.8 }),
      near: D({ available: true, weaponRangeCheck: 'in-range',    cameraRayContact: true, hitDistance: 7.2 }),
      none: D({ available: true, weaponRangeCheck: 'unknown',     cameraRayContact: false }),
      dead: D({ available: false })
    });
  })()`));
  check('3 合成超距接触点触发阻塞',
    t3.far.allowed === false && t3.far.reason === 'beyond-range' && t3.far.hitDistance === 94.8,
    `far.allowed=${t3.far.allowed} reason=${t3.far.reason} hit=${t3.far.hitDistance}`);
  check('3b 合成射程内不被阻塞',
    t3.near.allowed === true && t3.near.reason === 'in-range',
    `near.allowed=${t3.near.allowed} reason=${t3.near.reason}`);
  check('3c 合成不可用不被阻塞',
    t3.dead.allowed === true && t3.dead.reason === 'guard-unavailable',
    `allowed=${t3.dead.allowed} reason=${t3.dead.reason}`);

  // ── 4) 暂停期间不继续发送射击输入 ──
  log('\n  --- 4/5/6 需要跑控制器 ---');
  await ev('window.Autoplay.start()');
  await sleep(6000);
  const sRun = JSON.parse(await ev('JSON.stringify(window.Autoplay.getStatus())'));
  await resetCount();
  await ev('window.Autoplay.pause()');
  const sPause = JSON.parse(await ev('JSON.stringify(window.Autoplay.getStatus())'));
  await resetCount();
  await sleep(4000);
  const cIdle = await readCount();
  const sPause2 = JSON.parse(await ev('JSON.stringify(window.Autoplay.getStatus())'));
  check('4 暂停期间不再发送输入',
    sumCount(cIdle) === 0 && sPause2.stats.shots === sPause.stats.shots,
    `state=${sPause.state}->${sPause2.state} inputCalls=${sumCount(cIdle)} shots=${sPause.stats.shots}->${sPause2.stats.shots}`);

  // ── 5) 恢复后能重新读取场景状态 ──
  await ev('window.Autoplay.resume()');
  await sleep(4000);
  const sResume = JSON.parse(await ev('JSON.stringify(window.Autoplay.getStatus())'));
  const probeAfter = JSON.parse(await ev('JSON.stringify(window.AutoplayRange.probe({force:true}))'));
  check('5 恢复后重新读取场景状态',
    sResume.state === 'RUNNING' && sResume.stats.ticks > 0 && probeAfter.camera && probeAfter.camera.position && probeAfter.camera.position.length === 3,
    `state=${sResume.state} ticks=${sResume.stats.ticks} cam=${probeAfter.camera ? probeAfter.camera.position.map(v => v.toFixed(1)).join(',') : 'null'} verdict=${probeAfter.verdict}`);

  // ── 6) 停止后没有过期异步任务继续发送输入 ──
  await ev('window.Autoplay.stop()');
  const sStop = JSON.parse(await ev('JSON.stringify(window.Autoplay.getStatus())'));
  await resetCount();
  await sleep(4000);
  const cStop = await readCount();
  const sStop2 = JSON.parse(await ev('JSON.stringify(window.Autoplay.getStatus())'));
  check('6 停止后无过期任务发输入',
    sStop2.state === 'IDLE' && sumCount(cStop) === 0 && sStop2.stats.shots === sStop.stats.shots,
    `state=${sStop2.state} inputCalls=${sumCount(cStop)} shots=${sStop.stats.shots}->${sStop2.stats.shots}`);

  // ── 7) 场景对象缺失时，控制器能报告前置条件不满足 ──
  const tut = await ev('window.__tutElems()');
  const sIdle = JSON.parse(await ev('JSON.stringify(window.Autoplay.getStatus())'));
  const per = await ev('(function(){try{return window.AutoplayPerception.observe().targets.length}catch(e){return -1}})()');
  const missing = !(tut && tut.self);
  check('7 场景对象缺失时如实报告前置条件',
    missing ? (typeof sIdle.targets === 'number' && sIdle.state === 'IDLE' && !sIdle.error)
            : (typeof sIdle.targets === 'number'),
    `tutSeqEvent=${missing ? 'null(缺失)' : 'present'} status.targets=${sIdle.targets} vision.targets=${per} state=${sIdle.state} error=${sIdle.error || 'none'}`);

  // ── 汇总 ──
  const pass = R.filter((x) => x.ok).length;
  log(`\n=== 汇总: ${pass}/${R.length} 通过 ===`);
  R.forEach((x) => log(`  ${x.ok ? 'PASS' : 'FAIL'}  ${x.name}`));
  writeFileSync(join(OUT, 'regression.json'), JSON.stringify({ at: new Date().toISOString(), pass, total: R.length, results: R, snapshot: { sRun, sPause, sPause2, sResume, sStop, sStop2, t1, t2a, t2b, t3 } }, null, 1));
  log('已写 .workbuddy/probe-out/regression.json');
  try { child.kill(); } catch (e) {}
  process.exit(pass === R.length ? 0 : 1);
}

main().catch((e) => { log('FATAL', e && e.message); try { child.kill(); } catch (x) {} process.exit(2); });
