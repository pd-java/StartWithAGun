/**
 * autoplay-target-enum.mjs —— 枚举场景里「所有」HealthComponent，看教程监视的 2 个是不是全部
 *
 * 动机：`HasHealthComponentWithinRadiusOfShot` 在「未瞄准」时 r=30 返回 1，精确瞄准 95m 外
 *      的活靶后 r=30 返回 0。这个组合用「玩家到靶距离」和「射线到靶距离」都解释不通，
 *      但有个更简单的可能：场景里还存在**更近的活体**，半径门判的是它，而我们一直在瞄远处两个。
 *
 * 做法：拿一个已知 HealthComponent 的 Il2CppClass，调
 *      UnityEngine.Resources::FindObjectsOfTypeAll(slot 95940)
 *      逐个读 Transform 世界坐标 / IsAlive / CurrentHealth / 与相机的距离。
 *
 * 用法: node tools/autoplay-target-enum.mjs [url]
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
const PORT = 9431;
const profile = mkdtempSync(join(tmpdir(), 'cdp-enum-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1000,1000', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  `http://127.0.0.1:${PORT}/json/version`
], { stdio: 'ignore' });
process.on('exit', () => { try { child.kill(); } catch (e) {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const R2D = 180 / Math.PI;

const SLOT = {
  cam: 7701, xf: 4877, posInj: 96638, fwd: 6797,
  alive: 7052, hp: 7223, maxHp: 15410,
  go: 4403, name: 677,
  findAll: 95940,
};

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
window.__alloc = function () {
  window.__S = window.__wasmMainExports.malloc(2048);
  var d = new DataView(window.__wasmMemory.buffer);
  for (var i = 0; i < 2048; i += 4) d.setUint32(window.__S + i, 0, true);
  return window.__S;
};
window.__vec = function (off) { var b = window.__S + (off || 0); return [window.__f32at(b), window.__f32at(b + 4), window.__f32at(b + 8)]; };
window.__call = function (slot, args) {
  var f; try { f = window.__T.get(slot); } catch (e) { return 'get-err'; }
  if (typeof f !== 'function') return 'null-fn';
  try { return f.apply(null, args || []); } catch (e) { return 'CALL_ERR:' + String(e && e.message || e).slice(0, 60); }
};
window.__cam = function () { return window.__call(${SLOT.cam}, [0]); };
window.__xf = function (o) { return window.__call(${SLOT.xf}, [o, 0]); };
window.__pos = function (tr, off) { return window.__call(${SLOT.posInj}, [tr, window.__S + (off || 0), 0]); };
window.__alive = function (hc) { return window.__call(${SLOT.alive}, [hc, 0]); };
window.__hp = function (hc) { return window.__call(${SLOT.hp}, [hc, 0]); };
window.__maxhp = function (hc) { return window.__call(${SLOT.maxHp}, [hc, 0]); };
window.__go = function (c) { return window.__call(${SLOT.go}, [c, 0]); };
window.__name = function (o) { return window.__call(${SLOT.name}, [o, 0]); };
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
/* 读 Il2CppArray：分别按 data@16 / data@20 两种约定试，返回看起来合法的那个 */
window.__arr = function (a) {
  var res = { arr: a, maxLen: window.__u32(a + 12), l16: window.__u32(a + 16), l20: window.__u32(a + 20), tries: [] };
  if (!a) return res;
  [16, 20].forEach(function (base) {
    var n = res.maxLen | 0;
    if (n < 0 || n > 4096) n = 0;
    var ptrs = [];
    for (var i = 0; i < n; i++) ptrs.push(window.__u32(a + base + i * 4));
    var good = ptrs.filter(function (p) { return p > 1024 && p < 2000000000; }).length;
    res.tries.push({ base: base, n: n, good: good, ptrs: ptrs.slice(0, 64) });
  });
  return res;
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
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

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
  await ev(`window.__pos(${camT},0)`);
  const camP = await ev('window.__vec(0)');
  log(`  相机 pos=(${camP.map((v) => v.toFixed(2)).join(', ')})`);

  log('\n=== 1) 等教程对象出现（拿到一个 HealthComponent 指针）===');
  let tut = null;
  for (let i = 0; i < 50; i++) {
    tut = await ev('window.__tutElems()');
    if (tut && tut.elems && tut.elems.length) break;
    if (i % 10 === 0) log(`  t≈${(i + 1) * 3}s 还没有 tutSeqEvent`);
    await sleep(3000);
  }
  if (!tut || !tut.elems.length) { log('✘ 拿不到 HealthComponent'); try { child.kill(); } catch (e) {} process.exit(3); }
  log(`  教程监视 ${tut.elems.length} 个: ${tut.elems.map((e) => e.ptr).join(', ')}`);

  const seed = tut.elems[0].ptr;
  const klass = await ev(`window.__u32(${seed})`);
  log(`  seed=${seed}  类型=${JSON.stringify(await ev(`window.__typeName(${seed})`))}  klass=${klass}`);

  log('\n=== 2) FindObjectsOfTypeAll 调用约定 ===');
  const variants = [
    ['A fn(klass, 0)', `window.__call(${SLOT.findAll},[${klass},0])`],
    ['B fn(klass)', `window.__call(${SLOT.findAll},[${klass}])`],
    ['C fn(0, klass)', `window.__call(${SLOT.findAll},[0,${klass}])`],
    ['D fn(klass,0,0)', `window.__call(${SLOT.findAll},[${klass},0,0])`],
  ];
  let arr = 0;
  for (const [tag, expr] of variants) {
    const r = await ev(expr);
    const tn = typeof r === 'number' && r > 1024 ? await ev(`window.__typeName(${r})`) : null;
    log(`  ${tag.padEnd(18)} → ${JSON.stringify(r)}  类型=${JSON.stringify(tn)}`);
    if (!arr && typeof r === 'number' && r > 1024 && tn && /Array|\[\]/.test(tn)) arr = r;
  }
  if (!arr) {
    // 退一步：任一数值返回都试试
    const r = await ev(`window.__call(${SLOT.findAll},[${klass},0])`);
    if (typeof r === 'number' && r > 1024) arr = r;
  }
  if (!arr) { log('✘ 枚举失败'); try { child.kill(); } catch (e) {} process.exit(4); }
  log(`  采用数组 ${arr}`);

  log('\n=== 3) 数组布局探测 ===');
  const meta = await ev(`window.__arr(${arr})`);
  log(`  maxLen=${meta.maxLen} u32@16=${meta.l16} u32@20=${meta.l20}`);
  let base = 16;
  for (const t of meta.tries) log(`  data@${t.base}: n=${t.n} 合法指针=${t.good}  前几个=${JSON.stringify(t.ptrs.slice(0, 6))}`);
  const best = meta.tries.slice().sort((a, b) => b.good - a.good)[0];
  if (!best || best.good === 0) { log('✘ 两种布局都不合法'); try { child.kill(); } catch (e) {} process.exit(5); }
  base = best.base;
  log(`  → 用 data@${base}，共 ${best.n} 个`);

  log('\n=== 4) 逐个对象 ===');
  const rows = [];
  for (let i = 0; i < Math.min(best.n, 64); i++) {
    const o = best.ptrs[i];
    if (!o || o < 1024) continue;
    const tn = await ev(`window.__typeName(${o})`);
    const tr = await ev(`window.__xf(${o})`);
    if (!tr || typeof tr !== 'number' || tr < 1024) { log(`  #${i} ${tn} → no transform`); continue; }
    await ev(`window.__pos(${tr},32)`);
    const p = await ev('window.__vec(32)');
    const go = await ev(`window.__go(${o})`);
    const nmPtr = go && typeof go === 'number' && go > 1024 ? await ev(`window.__name(${go})`) : 0;
    let nm = null;
    if (nmPtr && typeof nmPtr === 'number' && nmPtr > 1024) {
      nm = await ev(`(function(){var s=${nmPtr};var n=window.__u32(s+8);return window.__cstr(n)||window.__cstr(window.__u32(s+16));})()`);
    }
    const hp = await ev(`window.__hp(${o})`);
    const mhp = await ev(`window.__maxhp(${o})`);
    const alive = await ev(`window.__alive(${o})`);
    const d = dist3(p, camP);
    rows.push({ i, o, type: tn, name: nm, pos: p, dist: d, hp, mhp, alive });
    log(`  #${String(i).padStart(2)} ${String(tn).padEnd(18)} name=${JSON.stringify(nm)} pos=(${p.map((v) => v.toFixed(2)).join(', ')}) dist=${d.toFixed(1).padStart(6)}m hp=${hp}/${mhp} alive=${alive}`);
  }

  rows.sort((a, b) => a.dist - b.dist);
  log('\n=== 5) 按距离排序 ===');
  for (const r of rows) log(`  ${r.dist.toFixed(1).padStart(6)}m  ${String(r.type).padEnd(18)} alive=${r.alive} hp=${r.hp}/${r.mhp} name=${JSON.stringify(r.name)}`);

  const tutSet = new Set(tut.elems.map((e) => e.ptr));
  log('\n=== 6) 教程监视的两个是否在枚举结果里 ===');
  for (const e of tut.elems) {
    const hit = rows.find((r) => r.o === e.ptr);
    log(`  ${e.ptr} → ${hit ? `在列表 #${hit.i} dist=${hit.dist.toFixed(1)}m` : '不在列表（可能是未激活对象）'}`);
  }
  const near = rows.filter((r) => !tutSet.has(r.o) && r.alive);
  log(`  非教程监视且存活的: ${near.length} 个 ${near.length ? '→ ' + near.slice(0, 5).map((r) => `${r.dist.toFixed(1)}m/${r.type}`).join(', ') : ''}`);

  writeFileSync(join(OUT, 'target-enum.json'), JSON.stringify({ camP, tut, arr, base, rows }, (k, v) => (typeof v === 'number' && !isFinite(v) ? null : v), 1));
  log('\n已写 .workbuddy/probe-out/target-enum.json');
  try { child.kill(); } catch (e) {}
  process.exit(0);
}

main().catch((e) => { log('FATAL', e && e.message); try { child.kill(); } catch (x) {} process.exit(1); });
