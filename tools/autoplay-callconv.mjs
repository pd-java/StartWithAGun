/**
 * autoplay-callconv.mjs —— 钉死「返回结构体」类方法的 wasm 调用约定
 *
 * 已知：`__indirect_function_table` 可用，`Camera::get_main` 调用成功（类型名解出 "Camera"）。
 * 未知：返回 Vector3 的方法（get_position / get_forward）、带结构体参数的
 *       WorldToScreenPoint_Injected，参数顺序到底是哪种。
 *
 * 自校验的黄金标准（不需要任何外部真值）：
 *   WorldToScreenPoint(camera.position) 必须 ≈ 屏幕正中 (W/2, H/2)，且 z ≈ 0。
 *   任何约定只要满足这一条，就是对的。
 *
 * 另一个独立真值：上一轮探针实测射线原点 = (13.6, -63.8, 2.9)，
 *   camera.transform.position 应当与之接近。
 *
 * 用法: node tools/autoplay-callconv.mjs [url]
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
const PORT = 9415;
const profile = mkdtempSync(join(tmpdir(), 'cdp-cv-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1000,1000', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  'http://127.0.0.1:8848/robots.txt'
], { stdio: 'ignore' });
process.on('exit', () => { try { child.kill(); } catch (e) {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const HELPERS = `
window.__dbg = function () {
  var out = {};
  function take(o) { if (!o) return; for (var k in o) { try { var v = o[k]; if (v && typeof v === 'object' && typeof v.value === 'number') out[k] = v.value; } catch (e) {} } }
  take(window.__wasmMainExports);
  try { take(GameGlobal.__wasmCode1Instance && GameGlobal.__wasmCode1Instance.exports); } catch (e) {}
  return out;
};
window.__u32 = function (a) { try { return new DataView(window.__wasmMemory.buffer).getUint32(a >>> 0, true); } catch (e) { return 0; } };
window.__f32at = function (a) { try { return new DataView(window.__wasmMemory.buffer).getFloat32(a >>> 0, true); } catch (e) { return NaN; } };
window.__cstr = function (a) {
  var m = window.__wasmMemory; if (!m || !a) return null;
  var u8; try { u8 = new Uint8Array(m.buffer); } catch (e) { return null; }
  var s = '';
  for (var i = 0; i < 100; i++) { var b = u8[(a + i) >>> 0]; if (!b) break; if (b < 0x20 || b > 0x7e) return null; s += String.fromCharCode(b); }
  return s.length >= 2 ? s : null;
};
window.__typeName = function (o) { if (!o) return null; var k = window.__u32(o); return k ? (window.__cstr(window.__u32(k + 8)) || window.__cstr(window.__u32(k + 16))) : null; };
window.__tbl = function () {
  var T = (window.__wasmMainExports || {}).__indirect_function_table;
  if (!T) return 'no-table';
  window.__T = T; return 'ok:' + T.length;
};
window.__S = 0;
window.__alloc = function () {
  var ex = window.__wasmMainExports;
  window.__S = ex.malloc(512);
  var d = new DataView(window.__wasmMemory.buffer);
  for (var i = 0; i < 512; i += 4) d.setUint32(window.__S + i, 0, true);
  return window.__S;
};
window.__vec = function (off) {
  return [window.__f32at(window.__S + (off || 0)), window.__f32at(window.__S + (off || 0) + 4), window.__f32at(window.__S + (off || 0) + 8)];
};
window.__put = function (off, x, y, z) {
  var d = new DataView(window.__wasmMemory.buffer);
  d.setFloat32(window.__S + off, x, true); d.setFloat32(window.__S + off + 4, y, true); d.setFloat32(window.__S + off + 8, z, true);
  return 1;
};
window.__zero = function (off, n) {
  var d = new DataView(window.__wasmMemory.buffer);
  for (var i = 0; i < (n || 16); i += 4) d.setUint32(window.__S + off + i, 0, true);
  return 1;
};
window.__call = function (slot, args) {
  var T = window.__T; if (!T) return 'no-table';
  var f; try { f = T.get(slot); } catch (e) { return 'get-err'; }
  if (typeof f !== 'function') return 'null-fn';
  try { return f.apply(null, args || []); } catch (e) { return 'CALL_ERR:' + String(e && e.message || e).slice(0, 60); }
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

const SLOT = { getMain: 7701, getTransform: 4877, getPosInj: 96638, getPos: 4979, getFwd: 6797, w2s: 93377 };

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
    if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description || '').slice(0, 240) };
    return r.result.value;
  };
  /* 单次调用限时版：把 wasm 打死时不要让整个脚本卡住 */
  const evT = async (e, ms = 6000) => {
    try {
      const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, timeout: ms }, sessionId);
      if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description || '').slice(0, 200) };
      return r.result.value;
    } catch (err) { return { __timeout: true }; }
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
  log('  table = ' + JSON.stringify(await ev('window.__tbl()')));
  const S0 = await ev('window.__alloc()');
  const dims = await ev('(function(){var c=document.querySelector("canvas");return {w:c.width,h:c.height}})()');
  log(`  scratch=${S0}  canvas=${JSON.stringify(dims)}`);

  const cam = await ev(`window.__call(${SLOT.getMain},[0])`);
  const camT = await ev(`window.__call(${SLOT.getTransform},[${cam},0])`);
  log(`  cam=${cam} (${await ev(`window.__typeName(${cam})`)})  cam->transform=${camT}`);

  /* ── 约定 A：fn(this, mi, ret) ── */
  /* 只试「retPtr 非 0」的安全变体：把 retPtr 传成 0 会写 NULL，可能直接把 wasm 打死 */
  log('\n=== get_position 约定对比（真值应接近射线原点 (13.6,-63.8,2.9)）===');
  const variants = [
    ['A fn(this,ret,mi)', `window.__zero(0,16), window.__call(${SLOT.getPosInj},[${camT},${S0},0])`],
    ['B fn(ret,this,mi)', `window.__zero(0,16), window.__call(${SLOT.getPosInj},[${S0},${camT},0])`],
    ['C getPos(this,ret,mi)', `window.__zero(0,16), window.__call(${SLOT.getPos},[${camT},${S0},0])`],
    ['D getPos(ret,this,mi)', `window.__zero(0,16), window.__call(${SLOT.getPos},[${S0},${camT},0])`],
  ];
  const res = {};
  for (const [tag, expr] of variants) {
    const r2 = await evT(expr, 6000);
    if (r2 && r2.__timeout) { log(`  ${tag.padEnd(22)} ✘ 超时（wasm 被打死），跳过后续`); res[tag] = { dead: true }; break; }
    const v = await evT('JSON.stringify(window.__vec(0))', 4000);
    const raw = await evT('(function(){var o=[];for(var i=0;i<16;i+=4)o.push(window.__u32(window.__S+i));return o})()', 4000);
    log(`  ${tag.padEnd(22)} ret=${JSON.stringify(r2)} vec=${v} rawU32=${JSON.stringify(raw)}`);
    res[tag] = { ret: r2, vec: v ? JSON.parse(v) : null, raw };
  }

  /* 取回一个能让 WorldToScreenPoint 自校验的位置：
     如果 A/B/C 里有一个给出合理位置，就用它；否则用射线原点真值手工写入 */
  let camPos = null;
  for (const k of Object.keys(res)) {
    const v = res[k].vec;
    if (v && v.length >= 3 && v.every((x) => typeof x === 'number' && isFinite(x)) && Math.abs(v[0]) < 500 && Math.abs(v[1]) < 500 && Math.abs(v[2]) < 200 && (Math.abs(v[0]) + Math.abs(v[1]) + Math.abs(v[2])) > 5) {
      camPos = v; log(`  采用 ${k} 的位置 ${JSON.stringify(v)}`); break;
    }
  }
  if (!camPos) { camPos = [13.6, -63.8, 2.9]; log('  ✘ 没有一个约定可用，用射线原点真值 ' + JSON.stringify(camPos)); }

  /* ── WorldToScreenPoint 约定 + 自校验 ── */
  log('\n=== WorldToScreenPoint 约定（自校验：投影相机自身位置 = 屏幕正中）===');
  const w2sVariants = [
    ['A fn(this,in,ret,mi)', [cam, S0 + 32, S0 + 64, 0]],
    ['B fn(in,ret,this,mi)', [S0 + 32, S0 + 64, cam, 0]],
    ['C fn(this,ret,in,mi)', [cam, S0 + 64, S0 + 32, 0]],
    ['D fn(this,mi,in,ret)', [cam, 0, S0 + 32, S0 + 64]],
  ];
  const w2sRes = {};
  for (const [tag, args] of w2sVariants) {
    await evT(`window.__zero(32,48)`, 4000);
    await evT(`window.__put(32,${camPos[0]},${camPos[1]},${camPos[2]})`, 4000);
    const r = await evT(`window.__call(${SLOT.w2s},[${args.join(',')}])`, 6000);
    if (r && r.__timeout) { log(`  ${tag.padEnd(22)} ✘ 超时`); break; }
    const a = await evT('JSON.stringify(window.__vec(32))', 4000);
    const b = await evT('JSON.stringify(window.__vec(64))', 4000);
    log(`  ${tag.padEnd(22)} ret=${JSON.stringify(r)} @32=${a} @64=${b}`);
    w2sRes[tag] = { ret: r, v32: a ? JSON.parse(a) : null, v64: b ? JSON.parse(b) : null };
  }

  /* 选最优：最接近屏幕正中且 z≈0 */
  const cx = dims.w / 2, cy = dims.h / 2;
  let bestTag = null, bestErr = 1e9;
  for (const tag of Object.keys(w2sRes)) {
    for (const key of ['v32', 'v64']) {
      const v = w2sRes[tag][key];
      if (!v || v.some((x) => !isFinite(x))) continue;
      const e = Math.hypot(v[0] - cx, v[1] - cy) + Math.abs(v[2]) * 2;
      if (e < bestErr) { bestErr = e; bestTag = tag + '/' + key; }
    }
  }
  log(`  → 最接近屏幕正中(${cx},${cy}) 的是 ${bestTag}，误差 ${bestErr.toFixed(1)}`);

  writeFileSync(join(OUT, 'callconv.json'), JSON.stringify({ res, w2sRes, camPos, dims, bestTag, bestErr }, null, 1));
  log('\n结果 → ' + join(OUT, 'callconv.json'));
  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
