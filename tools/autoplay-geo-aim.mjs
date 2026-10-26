/**
 * autoplay-geo-aim.mjs —— 纯几何瞄准：读相机位置/朝向与靶子位置，算出要转多少度，再转过去
 *
 * 已钉死的调用约定（实测）：
 *   非 Injected 的结构体返回 → sret 在最前：  fn(retPtr, this, methodInfo)
 *   `_Injected` 的结构体返回  → sret 在第二：  fn(this, retPtr, methodInfo)
 *
 * 槽位（tools/probe_slots.py 生成）：
 *   7701  Camera::get_main              (静态, fn(0) → Camera*)
 *   4877  Component::get_transform      (fn(comp, mi) → Transform*)
 *   96638 Transform::get_position_Injected   fn(tr, ret, mi)
 *   6797  Transform::get_forward             fn(ret, tr, mi)   (sret-first)
 *
 * 流程：
 *   1. 读 camera.position / camera.forward
 *   2. 读每个靶子的 world position
 *   3. 算「相机当前朝向 → 靶子方向」的 yaw/pitch 差
 *   4. 拖一次已知量，读回 forward 变化 → 得到「拖动单位 → 角度」的增益
 *   5. 用增益反解拖动量，闭环逼近，最后开火
 *
 * 用法: node tools/autoplay-geo-aim.mjs [url]
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
const PORT = 9417;
const profile = mkdtempSync(join(tmpdir(), 'cdp-geo-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1000,1000', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  'http://127.0.0.1:8848/robots.txt'
], { stdio: 'ignore' });
process.on('exit', () => { try { child.kill(); } catch (e) {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

const HELPERS = `
window.__dbg = function () {
  var out = {};
  function take(o) { if (!o) return; for (var k in o) { try { var v = o[k]; if (v && typeof v === 'object' && typeof v.value === 'number') out[k] = v.value; } catch (e) {} } }
  take(window.__wasmMainExports);
  try { take(GameGlobal.__wasmCode1Instance && GameGlobal.__wasmCode1Instance.exports); } catch (e) {}
  return out;
};
window.__u32 = function (a) { try { return new DataView(window.__wasmMemory.buffer).getUint32(a >>> 0, true); } catch (e) { return 0; } };
window.__cstr = function (a) {
  var m = window.__wasmMemory; if (!m || !a) return null;
  var u8; try { u8 = new Uint8Array(m.buffer); } catch (e) { return null; }
  var s = '';
  for (var i = 0; i < 90; i++) { var b = u8[(a + i) >>> 0]; if (!b) break; if (b < 0x20 || b > 0x7e) return null; s += String.fromCharCode(b); }
  return s.length >= 2 ? s : null;
};
window.__typeName = function (o) { if (!o) return null; var k = window.__u32(o); return k ? (window.__cstr(window.__u32(k + 8)) || window.__cstr(window.__u32(k + 16))) : null; };
window.__T = (window.__wasmMainExports || {}).__indirect_function_table;
window.__resetAll = function () {
  var n = 0;
  function zero(o) { if (!o) return; for (var k in o) { try { var v = o[k]; if (v && typeof v === 'object' && typeof v.value === 'number') { v.value = 0; n++; } } catch (e) {} } }
  zero(window.__wasmMainExports);
  try { zero(GameGlobal.__wasmCode1Instance && GameGlobal.__wasmCode1Instance.exports); } catch (e) {}
  return n;
};
window.__S = 0;
window.__alloc = function () {
  window.__S = window.__wasmMainExports.malloc(1024);
  var d = new DataView(window.__wasmMemory.buffer);
  for (var i = 0; i < 1024; i += 4) d.setUint32(window.__S + i, 0, true);
  return window.__S;
};
window.__f32at = function (a) { try { return new DataView(window.__wasmMemory.buffer).getFloat32(a >>> 0, true); } catch (e) { return NaN; } };
window.__vec = function (off) { var b = window.__S + (off || 0); return [window.__f32at(b), window.__f32at(b + 4), window.__f32at(b + 8)]; };
window.__call = function (slot, args) {
  var f; try { f = window.__T.get(slot); } catch (e) { return 'get-err'; }
  if (typeof f !== 'function') return 'null-fn';
  try { return f.apply(null, args || []); } catch (e) { return 'CALL_ERR:' + String(e && e.message || e).slice(0, 60); }
};
/* 非 Injected：fn(ret, this, mi) */
window.__posN = function (tr, off) { return window.__call(96638, [tr, window.__S + (off || 0), 0]); };
/* 相机 */
window.__cam = function () { return window.__call(7701, [0]); };
window.__xf = function (o) { return window.__call(4877, [o, 0]); };
window.__pos = function (tr, off) { return window.__call(96638, [tr, window.__S + (off || 0), 0]); };
/* 非 Injected get_forward：fn(ret, this, mi) */
window.__fwd = function (tr, off) { return window.__call(6797, [window.__S + (off || 0), tr, 0]); };
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
  for (var i = 0; i < n; i++) {
    var e = window.__u32(items + 16 + i * 4);
    out.elems.push({ i: i, ptr: e, type: window.__typeName(e) });
  }
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

/* 角度：约定 y 轴向上（下面会用 forward 的实际数值验证，必要时自动切换） */
function yawPitchYup(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return { yaw: Math.atan2(v[2], v[0]) * R2D, pitch: Math.asin(Math.max(-1, Math.min(1, v[1] / l))) * R2D };
}
function yawPitchZup(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return { yaw: Math.atan2(v[1], v[0]) * R2D, pitch: Math.asin(Math.max(-1, Math.min(1, v[2] / l))) * R2D };
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
  const S0 = await ev('window.__alloc()');
  log(`  scratch=${S0}`);

  const cam = await ev('window.__cam()');
  const camT = await ev(`window.__xf(${cam})`);
  log(`  camera=${cam} transform=${camT} type=${await ev(`window.__typeName(${cam})`)}`);

  log('\n=== 1) 相机位置 / 朝向 ===');
  await ev(`window.__pos(${camT},0)`);
  const camPos = await ev('window.__vec(0)');
  await ev(`window.__fwd(${camT},16)`);
  const camFwd = await ev('window.__vec(16)');
  log(`  position = ${JSON.stringify(camPos)}`);
  log(`  forward  = ${JSON.stringify(camFwd)}`);
  const yUp = yawPitchYup(camFwd), zUp = yawPitchZup(camFwd);
  log(`  y 向上解释: yaw=${yUp.yaw.toFixed(2)}° pitch=${yUp.pitch.toFixed(2)}°`);
  log(`  z 向上解释: yaw=${zUp.yaw.toFixed(2)}° pitch=${zUp.pitch.toFixed(2)}°`);
  const UP = Math.abs(camFwd[1]) > Math.abs(camFwd[2]) ? 'y' : 'z';
  log(`  → 判断向上轴 = ${UP}（forward 里绝对值更大的那个分量）`);

  log('\n=== 2) 靶子世界坐标 ===');
  let tut = null;
  for (let i = 0; i < 45; i++) {
    tut = await ev('window.__tutElems()');
    if (tut && tut.elems && tut.elems.length) break;
    await sleep(2000);
  }
  log(`  教程=${JSON.stringify(tut && tut.type)} 元素=${tut && tut.elems && tut.elems.length}`);
  const tgt = [];
  if (tut && tut.elems) {
    for (const e of tut.elems) {
      const tr = await ev(`window.__xf(${e.ptr})`);
      await ev(`window.__pos(${tr},32)`);
      const p = await ev('window.__vec(32)');
      const dx = p[0] - camPos[0], dy = p[1] - camPos[1], dz = p[2] - camPos[2];
      const dist = Math.hypot(dx, dy, dz);
      const ap = UP === 'y' ? yawPitchYup([dx, dy, dz]) : yawPitchZup([dx, dy, dz]);
      const cf = UP === 'y' ? yawPitchYup(camFwd) : yawPitchZup(camFwd);
      tgt.push({ i: e.i, ptr: e.ptr, tr, pos: p, dist, yaw: ap.yaw, pitch: ap.pitch, dYaw: ap.yaw - cf.yaw, dPitch: ap.pitch - cf.pitch });
      log(`  #${e.i} pos=(${p.map((v) => v.toFixed(2)).join(', ')}) dist=${dist.toFixed(1)}m ` +
          `yaw=${ap.yaw.toFixed(2)}° pitch=${ap.pitch.toFixed(2)}°  Δ偏航=${(ap.yaw - cf.yaw).toFixed(2)}° Δ俯仰=${(ap.pitch - cf.pitch).toFixed(2)}°`);
    }
  }

  log('\n=== 3) 拖动增益标定（读 forward 变化，不用开枪）===');
  await ev('window.__drag(0.5,0.70,0,0.04,10,30)');
  await sleep(400);
  await ev(`window.__fwd(${camT},16)`);
  const f1 = await ev('window.__vec(16)');
  const c0 = UP === 'y' ? yawPitchYup(camFwd) : yawPitchZup(camFwd);
  const c1 = UP === 'y' ? yawPitchYup(f1) : yawPitchZup(f1);
  log(`  拖 (0,+0.04) → forward=${JSON.stringify(f1.map((v) => +v.toFixed(4)))}  Δpitch=${(c1.pitch - c0.pitch).toFixed(3)}°`);
  const dPitchPerUnit = (c1.pitch - c0.pitch) / 0.04;

  await ev('window.__drag(0.5,0.70,0.04,0,10,30)');
  await sleep(400);
  await ev(`window.__fwd(${camT},16)`);
  const f2 = await ev('window.__vec(16)');
  const c2 = UP === 'y' ? yawPitchYup(f2) : yawPitchZup(f2);
  log(`  拖 (+0.04,0) → forward=${JSON.stringify(f2.map((v) => +v.toFixed(4)))}  Δyaw=${(c2.yaw - c1.yaw).toFixed(3)}°`);
  const dYawPerUnit = (c2.yaw - c1.yaw) / 0.04;

  log(`  → 每单位拖动: Δyaw=${dYawPerUnit.toFixed(2)}°  Δpitch=${dPitchPerUnit.toFixed(2)}°`);

  if (!tgt.length) { log('\n✘ 没有靶子，结束（标定数据已拿到）'); }
  else if (Math.abs(dYawPerUnit) < 0.5 || Math.abs(dPitchPerUnit) < 0.5) {
    log('\n✘ 拖动几乎不改变 forward —— 相机可能不是被拖动控制的（或者用别的控制量），结束');
  } else {
    log('\n=== 4) 几何闭环瞄准 ===');
    for (const t of tgt) {
      log(`  ── 目标 #${t.i}（${t.dist.toFixed(1)}m）`);
      for (let it = 1; it <= 6; it++) {
        await ev(`window.__fwd(${camT},16)`);
        const cf = await ev('window.__vec(16)');
        const c = UP === 'y' ? yawPitchYup(cf) : yawPitchZup(cf);
        // 目标现在可能已经被打掉，所以每次都重新读一次位置
        await ev(`window.__pos(${t.tr},32)`);
        const p = await ev('window.__vec(32)');
        const d = [p[0] - camPos[0], p[1] - camPos[1], p[2] - camPos[2]];
        const ap = UP === 'y' ? yawPitchYup(d) : yawPitchZup(d);
        let eY = ap.yaw - c.yaw, eP = ap.pitch - c.pitch;
        while (eY > 180) eY -= 360; while (eY < -180) eY += 360;
        log(`    迭代${it}: Δyaw=${eY.toFixed(3)}° Δpitch=${eP.toFixed(3)}°  当前 yaw=${c.yaw.toFixed(2)} pitch=${c.pitch.toFixed(2)}`);
        if (Math.abs(eY) < 0.12 && Math.abs(eP) < 0.12) { log('    ✔ 对准'); break; }
        const dragX = Math.max(-0.2, Math.min(0.2, eY / dYawPerUnit));
        const dragY = Math.max(-0.2, Math.min(0.2, eP / dPitchPerUnit));
        await ev(`window.__drag(0.5,0.70,${dragX.toFixed(4)},${dragY.toFixed(4)},14,30)`);
        await sleep(420);
      }
      await ev('window.__resetAll()');
      await sleep(100);
      await ev('window.__fire(0.5,0.72,380)');
      await sleep(2200);
      const d = await ev('window.__dbg()');
      log(`    开火结果: Shoot=${d.main_Shoot_in || 0} 半径拒绝=${d.main_BR_rej_cover_hit || 0} ` +
          `Sim=${d.main_SimulatorSimulateShot_in || 0} hits=${d.main_VAL_sphereHits || 0} ` +
          `筛除(f76=${d.main_BR_SIM_rej_flag76 || 0},noH=${d.main_BR_SIM_rej_noHealth || 0},nA=${d.main_BR_SIM_rej_notAlive || 0}) ` +
          `伤害=${d.main_TakeDamage_in || 0} 击杀=${d.main_HealthKill_in || 0} 教程存活=${d.main_VAL_tutAliveCount}`);
      if ((d.main_TakeDamage_in || 0) > 0 || (d.main_HealthKill_in || 0) > 0) { log('    ★★★ 命中！'); break; }
    }
  }

  writeFileSync(join(OUT, 'geo-aim.json'), JSON.stringify({ camPos, camFwd, UP, tgt, dYawPerUnit, dPitchPerUnit }, null, 1));
  log('\n结果 → ' + join(OUT, 'geo-aim.json'));
  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
