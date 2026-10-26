/**
 * autoplay-gate-probe.mjs —— 直接调用「射界半径」这道门，扫描它到底在判什么
 *
 * 已知（反汇编 main:10883 0x5d）：
 *   Shoot 里第一道门是 RangedWeaponPlayer::HasHealthComponentWithinRadiusOfShot(w, this.f32@180, 0)
 *   返回 false → 直接 return，连 SimulateShot 都不跑。
 *
 * 实测：把准星精确压在靶子上（残差 0.01°）、两个靶子 IsAlive=1、CurrentHealth=1，
 *       这道门**依然返回 false**。所以它判的不是"瞄得准不准"。
 *       最可能是「靶子在不在武器周围 radius 米内」——靶子在 95m / 122m 外。
 *
 * 本脚本直接打电话问它：给不同的 radius，看返回值怎么变。
 *   槽位：CharacterWeapons::GetActiveRangedWeaponPlayer      main 5696
 *         RangedWeaponPlayer::HasHealthComponentWithinRadiusOfShot  main 6749
 *
 * 用法: node tools/autoplay-gate-probe.mjs [url]
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
const PORT = 9425;
const profile = mkdtempSync(join(tmpdir(), 'cdp-gate-'));
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
  for (var i = 0; i < 90; i++) { var b = u8[(a + i) >>> 0]; if (!b) break; if (b < 0x20 || b > 0x7e) return null; s += String.fromCharCode(b); }
  return s.length >= 2 ? s : null;
};
window.__typeName = function (o) { if (!o) return null; var k = window.__u32(o); return k ? (window.__cstr(window.__u32(k + 8)) || window.__cstr(window.__u32(k + 16))) : null; };
window.__T = (window.__wasmMainExports || {}).__indirect_function_table;
window.__S = 0;
window.__alloc = function () { window.__S = window.__wasmMainExports.malloc(1024); return window.__S; };
window.__vec = function (off) { var b = window.__S + (off || 0); return [window.__f32at(b), window.__f32at(b + 4), window.__f32at(b + 8)]; };
window.__call = function (slot, args) {
  var f; try { f = window.__T.get(slot); } catch (e) { return 'get-err'; }
  if (typeof f !== 'function') return 'null-fn';
  try { return f.apply(null, args || []); } catch (e) { return 'CALL_ERR:' + String(e && e.message || e).slice(0, 60); }
};
window.__tutElems = function () {
  var g = window.__dbg();
  var self = g.main_CAP_tutSeqEvent || 0;
  var out = { self: self, elems: [] };
  if (!self) return out;
  var list = window.__u32(self + 32);
  if (!list) return out;
  out.size = window.__u32(list + 12);
  var items = window.__u32(list + 8);
  for (var i = 0; i < Math.min(out.size | 0, 8); i++) out.elems.push(window.__u32(items + 16 + i * 4));
  return out;
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
    if (typeof l === 'number' && l > 178) { log(`  可玩 @ ${(i + 1) * 3}s`); ok = true; break; }
    if (i % 10 === 0) log(`  t=${(i + 1) * 3}s luma=${l}`);
    if (i % 2 === 0) await ev('window.__wxInjectTouch("start",0.5,0.5), window.__wxInjectTouch("end",0.5,0.5)');
  }
  if (!ok) { log('✘ 未进入战斗'); try { child.kill(); } catch (e) {} process.exit(2); }
  await ev('(function(){var b=document.getElementById("ap-fold"); if(b) b.click(); return 1})()');
  await ev(HELPERS);
  await ev('window.__alloc()');

  log('\n=== 等教程 ===');
  let tut = null;
  for (let i = 0; i < 45; i++) {
    tut = await ev('window.__tutElems()');
    if (tut && tut.elems && tut.elems.length) break;
    await sleep(2000);
  }
  log('  元素 = ' + (tut && tut.elems ? tut.elems.length : 0));

  log('\n=== 拿武器 w ===');
  const w1 = await ev('window.__call(5696,[0])');
  const w2 = await ev('window.__call(5696,[0,0])');
  log(`  fn(0)=${JSON.stringify(w1)} (${JSON.stringify(await ev(`window.__typeName(${w1})`))})`);
  log(`  fn(0,0)=${JSON.stringify(w2)} (${JSON.stringify(await ev(`window.__typeName(${w2})`))})`);
  const w = (typeof w1 === 'number' && w1 > 1024) ? w1 : w2;

  log('\n=== 武器到靶子的距离 ===');
  const wT = await ev(`window.__call(4877,[${w},0])`);
  const S0 = await ev('window.__S');
  await ev(`window.__call(96638,[${wT},${S0},0])`);
  const wpos = await ev('window.__vec(0)');
  log(`  w=${w} transform=${wT} pos=${JSON.stringify(wpos)}`);
  for (let i = 0; i < (tut && tut.elems ? tut.elems.length : 0); i++) {
    const hc = tut.elems[i];
    const tr = await ev(`window.__call(4877,[${hc},0])`);
    await ev(`window.__call(96638,[${tr},${S0 + 32},0])`);
    const p = await ev('window.__vec(32)');
    const d = Math.hypot(p[0] - wpos[0], p[1] - wpos[1], p[2] - wpos[2]);
    log(`  #${i} hc=${hc} pos=${JSON.stringify(p.map((v) => +v.toFixed(2)))} 距武器=${d.toFixed(1)}m`);
  }

  log('\n=== 直接调用 HasHealthComponentWithinRadiusOfShot(w, radius, 0) ===');
  const rows = [];
  for (const r of [0.2, 1, 3, 10, 30, 60, 90, 95, 100, 130, 200, 1000]) {
    const v = await ev(`window.__call(6749,[${w},${r},0])`);
    rows.push({ r, v });
    log(`  radius=${String(r).padStart(6)}  →  ${JSON.stringify(v)}`);
  }

  writeFileSync(join(OUT, 'gate-probe.json'), JSON.stringify({ w, wpos, rows, tut }, null, 1));
  log('\n结果 → ' + join(OUT, 'gate-probe.json'));
  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
