/**
 * autoplay-scene.mjs —— 只读查询：当前活动场景、已加载场景列表、场景名/路径
 *
 * 目的（ChatGPT turn-10 裁定的实验 A 第一步）：
 *   查清 hordechapterscene(groundzero) 到底能不能通过游戏自身流程进入。
 *   在此之前必须先回答一个更基础的问题：**我们现在在哪个场景里？**
 *
 * 槽位（tools/probe_slots.py 查得）：
 *   96909  SceneManager::get_sceneCount          main   static  fn(0)
 *   96939  SceneManager::GetActiveScene_Injected split  static  fn(retPtr)
 *   96943  SceneManager::GetSceneAt_Injected    split  static  fn(index, retPtr)
 *   10738  Scene::get_name                      main   fn(scenePtr, 0)   -> String*
 *   96887  Scene::get_path                      main   fn(scenePtr, 0)   -> String*
 *
 * Il2CppString 布局（wasm32）：+0 klass, +4 monitor, +8 length(int32), +12 chars(UTF-16LE)
 * Il2CppObject 头是 8 字节，所以 Il2CppClass.name 在 klass+8。
 *
 * 用法: node tools/autoplay-scene.mjs [url]
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
const profile = mkdtempSync(join(tmpdir(), 'cdp-scene-'));
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
window.__i32 = function (a) { try { return new DataView(window.__wasmMemory.buffer).getInt32(a >>> 0, true); } catch (e) { return 0; } };
window.__cstr = function (a) {
  var m = window.__wasmMemory; if (!m || !a) return null;
  var u8; try { u8 = new Uint8Array(m.buffer); } catch (e) { return null; }
  var s = '';
  for (var i = 0; i < 120; i++) { var b = u8[(a + i) >>> 0]; if (!b) break; if (b < 0x20 || b > 0x7e) return null; s += String.fromCharCode(b); }
  return s.length >= 2 ? s : null;
};
window.__typeName = function (o) { if (!o) return null; var k = window.__u32(o); return k ? (window.__cstr(window.__u32(k + 8)) || window.__cstr(window.__u32(k + 16))) : null; };
/* Il2CppString* -> JS string */
window.__str = function (p) {
  if (!p) return null;
  var len = window.__i32(p + 8);
  if (len < 0 || len > 512) return '<bad-len:' + len + '>';
  var u8 = new Uint8Array(window.__wasmMemory.buffer);
  var s = '';
  for (var i = 0; i < len; i++) {
    var lo = u8[(p + 12 + i * 2) >>> 0], hi = u8[(p + 12 + i * 2 + 1) >>> 0];
    var cp = lo | (hi << 8);
    s += cp < 128 ? String.fromCharCode(cp) : '?';
  }
  return s;
};
window.__T = (window.__wasmMainExports || {}).__indirect_function_table;
window.__T2 = (function () { try { return GameGlobal.__wasmCode1Instance.exports.__indirect_function_table; } catch (e) { return null; } })();
window.__S = 0;
window.__alloc = function () {
  window.__S = window.__wasmMainExports.malloc(1024);
  var d = new DataView(window.__wasmMemory.buffer);
  for (var i = 0; i < 1024; i += 4) d.setUint32(window.__S + i, 0, true);
  return window.__S;
};
window.__call = function (slot, args) {
  var f; try { f = window.__T.get(slot); } catch (e) { return 'get-err'; }
  if (typeof f !== 'function') return 'null-fn';
  try { return f.apply(null, args || []); } catch (e) { return 'CALL_ERR:' + String(e && e.message || e).slice(0, 60); }
};
/* 第二包（wasm-split）的槽位必须走 __T2，且索引是 table_map2 里的局部号 */
window.__call2 = function (slot, args) {
  var f; try { f = window.__T2.get(slot); } catch (e) { return 'get2-err'; }
  if (typeof f !== 'function') return 'null2-fn';
  try { return f.apply(null, args || []); } catch (e) { return 'CALL2_ERR:' + String(e && e.message || e).slice(0, 60); }
};
/* 只用主表槽位：跨包调用需要 table_map2，风险大且本次不需要 */
window.__scene = function () {
  var S = window.__S;
  var out = { steps: [] };
  function step(k, v) { out.steps.push(k + '=' + JSON.stringify(v)); }

  /* 1) sceneCount（静态，无返回结构体） */
  try { out.sceneCount = window.__call(96909, [0]); } catch (e) { out.sceneCount = 'ERR:' + e; }
  step('sceneCount', out.sceneCount);

  /* 2) GetActiveScene 非 _Injected 版本：结构体返回 sret 在前，静态方法无 this
        签名 = fn(retPtr, methodInfo) —— methodInfo 必须显式传，否则读到垃圾 */
  try {
    out.activeCall = window.__call(20097, [S, 0]);
  } catch (e) { out.activeCall = 'ERR:' + e; }
  out.activeHandle = window.__i32(S);
  step('activeHandle', out.activeHandle);

  /* handle 合理性检查：Activity 场景 handle 通常是小正整数（0..64）。
     不在范围内说明 sret 约定不对，此时不再调用 get_name，避免把垃圾指针传进去。 */
  var sane = (typeof out.activeHandle === 'number') && out.activeHandle >= 0 && out.activeHandle < 64;
  out.handleSane = sane;
  if (sane) {
    out.activeName = window.__str(window.__call(10738, [S, 0]));
    out.activePath = window.__str(window.__call(96887, [S, 0]));
    step('activeName', out.activeName);
    step('activePath', out.activePath);
  }

  /* 3) 遍历已加载场景 */
  out.scenes = [];
  var n = (typeof out.sceneCount === 'number') ? Math.min(out.sceneCount, 12) : 0;
  for (var i = 0; i < n; i++) {
    var o = { i: i };
    try { window.__call(20099, [S + 64, i, 0]); } catch (e) { o.err = String(e).slice(0, 40); }
    o.handle = window.__i32(S + 64);
    if (o.handle >= 0 && o.handle < 64) {
      o.name = window.__str(window.__call(10738, [S + 64, 0]));
      o.path = window.__str(window.__call(96887, [S + 64, 0]));
    }
    out.scenes.push(o);
  }
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
    const l = await ev('window.AutoplayPerception && window.AutoplayPerception.observe().metrics.avgLuma');
    if (typeof l === 'number' && l > 178) { log(`  可玩 @ ${(i + 1) * 3}s luma=${l}`); ok = true; break; }
    if (i % 10 === 0) log(`  t=${(i + 1) * 3}s luma=${l}`);
    if (i % 2 === 0) await ev('window.__wxInjectTouch("start",0.5,0.5), window.__wxInjectTouch("end",0.5,0.5)');
  }
  if (!ok) { log('✘ 未进入战斗'); try { child.kill(); } catch (e) {} process.exit(2); }

  await ev('(function(){var b=document.getElementById("ap-fold"); if(b) b.click(); return 1})()');
  await ev(HELPERS);
  await ev('window.__alloc()');

  log('\n=== 场景状态 ===');
  let r = await ev('window.__scene()');
  log('  ' + JSON.stringify(r, null, 2));

  log('\n=== 15s 后复测（排除首帧假象） ===');
  await sleep(15000);
  r = await ev('window.__scene()');
  log('  active=' + JSON.stringify(r.activeName) + ' path=' + JSON.stringify(r.activePath) + ' count=' + r.sceneCount);
  (r.scenes || []).forEach((s) => log(`    [${s.i}] ${JSON.stringify(s.name)}  ${JSON.stringify(s.path)}`));

  writeFileSync(join(OUT, 'scene.json'), JSON.stringify(r, null, 2));
  log('\n已写入 .workbuddy/probe-out/scene.json');
  try { child.kill(); } catch (e) {}
}

main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
