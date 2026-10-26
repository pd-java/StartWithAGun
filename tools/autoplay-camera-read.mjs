/**
 * autoplay-camera-read.mjs —— 用导出的函数表直接调用 IL2CPP 方法，读出靶子的真实屏幕坐标
 *
 * 页面实测：`window.__wasmMainExports.__indirect_function_table` 是导出的。
 * `tools/probe_slots.py` 已把方法名翻成槽位：
 *      Component::get_transform              main slot 4877
 *      Camera::get_main                      main slot 7701
 *      Transform::get_position_Injected      split slot 96638
 *      Camera::WorldToScreenPoint_Injected   split slot 93377
 *
 * 一旦这条链路打通，瞄准就不再是视觉问题：
 *   HealthComponent* → Transform* → worldPos → WorldToScreenPoint → 像素坐标
 * 直接和我们探针里读到的射线方向对齐即可。
 *
 * 用法: node tools/autoplay-camera-read.mjs [url]
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
const PORT = 9413;
const profile = mkdtempSync(join(tmpdir(), 'cdp-cam-'));
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
window.__u32 = function (a) {
  var m = window.__wasmMemory; if (!m) return 0;
  try { return new DataView(m.buffer).getUint32(a >>> 0, true); } catch (e) { return 0; }
};
window.__f32at = function (a) {
  var m = window.__wasmMemory; if (!m) return NaN;
  try { return new DataView(m.buffer).getFloat32(a >>> 0, true); } catch (e) { return NaN; }
};
window.__cstr = function (a) {
  var m = window.__wasmMemory; if (!m || !a) return null;
  var u8; try { u8 = new Uint8Array(m.buffer); } catch (e) { return null; }
  var s = '';
  for (var i = 0; i < 100; i++) {
    var b = u8[(a + i) >>> 0]; if (!b) break;
    if (b < 0x20 || b > 0x7e) return null;
    s += String.fromCharCode(b);
  }
  return s.length >= 2 ? s : null;
};
window.__typeName = function (o) {
  if (!o) return null;
  var k = window.__u32(o); if (!k) return null;
  return window.__cstr(window.__u32(k + 8)) || window.__cstr(window.__u32(k + 16));
};
/* 教程监视的 List<HealthComponent> 元素指针 */
window.__tutElems = function () {
  var g = window.__dbg();
  var self = g.main_CAP_tutSeqEvent || 0;
  var out = { self: self, type: window.__typeName(self), elems: [] };
  if (!self) return out;
  var list = window.__u32(self + 32);
  out.list = list;
  if (!list) return out;
  out.size = window.__u32(list + 12);
  var items = window.__u32(list + 8);
  out.items = items;
  var n = Math.min(out.size | 0, 8);
  for (var i = 0; i < n; i++) {
    var e = window.__u32(items + 16 + i * 4);
    out.elems.push({ i: i, ptr: e, type: window.__typeName(e) });
  }
  return out;
};
/* 函数表 */
window.__tbl = function () {
  var ex = window.__wasmMainExports || {};
  var T = ex.__indirect_function_table;
  if (!T) return { err: 'no-table', keys: Object.keys(ex).filter(function (k) { return /table|Table/.test(k); }) };
  window.__T = T;
  return { ok: 1, len: T.length, malloc: Object.keys(ex).filter(function (k) { return /malloc|alloc/i.test(k); }).slice(0, 6) };
};
/* 拿一块干净的可写内存：优先 malloc，否则 memory.grow 一个新页 */
window.__scratch = function () {
  var ex = window.__wasmMainExports || {};
  var m = window.__wasmMemory;
  if (typeof ex.malloc === 'function') { window.__S = ex.malloc(512); return { how: 'malloc', at: window.__S }; }
  if (typeof ex._malloc === 'function') { window.__S = ex._malloc(512); return { how: '_malloc', at: window.__S }; }
  var pages = m.buffer.byteLength / 65536;
  var r = m.grow(2);
  window.__S = (r + 1) * 65536;
  return { how: 'grow', at: window.__S, oldPages: r, pages: pages };
};
window.__S0 = function () { return window.__S || 0; };
/* 调用：返回结果或错误字符串 */
window.__call = function (slot, args) {
  var T = window.__T;
  if (!T) return 'no-table';
  var f;
  try { f = T.get(slot); } catch (e) { return 'get-err:' + e.message; }
  if (typeof f !== 'function') return 'null-fn';
  try { return f.apply(null, args || []); } catch (e) { return 'CALL_ERR:' + String(e && e.message || e).slice(0, 80); }
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
    if (r.exceptionDetails) { const t = String(r.exceptionDetails.exception?.description || '').slice(0, 300); return { __err: t }; }
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
    if (i % 8 === 0) log(`  t=${(i + 1) * 3}s luma=${l}`);
    if (i % 2 === 0) await ev('window.__wxInjectTouch("start",0.5,0.5), window.__wxInjectTouch("end",0.5,0.5)');
  }
  if (!ok) { log('✘ 未进入战斗'); try { child.kill(); } catch (e) {} process.exit(2); }

  await ev('(function(){var b=document.getElementById("ap-fold"); if(b) b.click(); return 1})()');
  await ev(HELPERS);

  log('\n=== 1) 函数表 ===');
  log('  ' + JSON.stringify(await ev('window.__tbl()')));

  log('\n=== 2) scratch 内存 ===');
  log('  ' + JSON.stringify(await ev('window.__scratch()')));
  log('  S=' + JSON.stringify(await ev('window.__S0()')));

  log('\n=== 3) Camera::get_main（slot 7701，静态）===');
  log('  fn(0)  = ' + JSON.stringify(await ev('window.__call(7701,[0])')));
  log('  fn()   = ' + JSON.stringify(await ev('window.__call(7701,[])')));
  const camM = await ev('window.__call(7701,[0])');
  const camS = await ev('window.__call(7701,[])');
  const cam = (typeof camM === 'number' && camM > 1024) ? camM : ((typeof camS === 'number' && camS > 1024) ? camS : 0);
  log(`  → cam = ${cam}  type=${JSON.stringify(await ev(`window.__typeName(${cam})`))}`);

  log('\n=== 4) 等教程序列（CAP_tutSeqEvent 非 0）===');
  let tut = null;
  for (let i = 0; i < 45; i++) {
    const cap = await ev('(window.__dbg().main_CAP_tutSeqEvent||0)');
    if (cap) { log(`  抓到 seqEvent @ +${i * 2}s ptr=${cap}`); break; }
    if (i % 5 === 0) log(`  t+${i * 2}s 还没抓到…`);
    await sleep(2000);
  }
  tut = await ev('window.__tutElems()');
  log('  ' + JSON.stringify(tut));
  if (!tut || !tut.elems || !tut.elems.length) log('  ✘ 仍然没有元素');

  log('\n=== 5) 相机自身坐标（对照射线原点）===');
  {
    const S0 = await ev('window.__S0()');
    const ctr = await ev(`window.__call(4877,[${cam},0])`);   // Camera 也是 Component
    log(`  camera->transform = ${JSON.stringify(ctr)}`);
    if (typeof ctr === 'number' && ctr > 1024) {
      const r = await ev(`window.__call(96638,[${ctr},0,${S0}])`);
      const pos = await ev(`[window.__f32at(${S0}), window.__f32at(${S0}+4), window.__f32at(${S0}+8)]`);
      log(`  get_position_Injected ret=${JSON.stringify(r)} pos=${JSON.stringify(pos)}`);
    }
  }

  log('\n=== 6) HealthComponent → Transform → worldPos → 屏幕坐标 ===');
  const S0 = await ev('window.__S0()');
  const rows = [];
  if (tut && tut.elems) {
    for (const e of tut.elems) {
      const tr = await ev(`window.__call(4877,[${e.ptr},0])`);           // Component::get_transform
      const tr2 = await ev(`window.__call(4877,[${e.ptr}])`);
      const trv = (typeof tr === 'number' && tr > 1024) ? tr : (typeof tr2 === 'number' ? tr2 : 0);
      log(`  elem#${e.i} hc=${e.ptr} (${e.type}) → transform=${JSON.stringify(tr)} / noMI=${JSON.stringify(tr2)} → 用 ${trv}`);
      if (!trv || typeof trv !== 'number' || trv < 1024) continue;
      const r1 = await ev(`window.__call(96638,[${trv},0,${S0}])`);      // Transform::get_position_Injected
      const pos = await ev(`[window.__f32at(${S0}), window.__f32at(${S0}+4), window.__f32at(${S0}+8)]`);
      log(`    get_position_Injected → ret=${JSON.stringify(r1)} pos=${JSON.stringify(pos)}`);
      let scr = null;
      if (cam) {
        // 先把 pos 写到 S0+32，再 WorldToScreenPoint_Injected(cam, mi, posPtr, retPtr)
        await ev(`(function(){var m=window.__wasmMemory;var d=new DataView(m.buffer);d.setFloat32(${S0}+32,${pos && pos[0] || 0},true);d.setFloat32(${S0}+36,${pos && pos[1] || 0},true);d.setFloat32(${S0}+40,${pos && pos[2] || 0},true);return 1})()`);
        const r2 = await ev(`window.__call(93377,[${cam},0,${S0}+32,${S0}+64])`);
        scr = await ev(`[window.__f32at(${S0}+64), window.__f32at(${S0}+68), window.__f32at(${S0}+72)]`);
        log(`    WorldToScreenPoint_Injected → ret=${JSON.stringify(r2)} screen=${JSON.stringify(scr)}`);
      }
      rows.push({ e, trv, pos, scr });
    }
  }

  log('\n=== 7) 射线原点对照 ===');
  const geo = await ev('(function(){var g=window.__dbg();var f=function(v){var b=new ArrayBuffer(4);var d=new DataView(b);d.setInt32(0,v|0,true);return d.getFloat32(0,true)};return [f(g.main_LD_rayOx),f(g.main_LD_rayOy),f(g.main_LD_rayOz),f(g.main_LD_rayDx),f(g.main_LD_rayDy),f(g.main_LD_rayDz)]})()');
  log('  ' + JSON.stringify(geo));

  writeFileSync(join(OUT, 'camera-read.json'), JSON.stringify({ tut, rows, cam, S0, geo }, null, 1));
  log('\n结果 → ' + join(OUT, 'camera-read.json'));
  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
