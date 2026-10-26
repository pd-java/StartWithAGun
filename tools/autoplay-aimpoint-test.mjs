/**
 * autoplay-aimpoint-test.mjs —— 验证「开火方向跟的是按下点，不是准星中心」
 *
 * 上一轮实测：射线俯仰恒定 -30°，命中点落在地面（y=-72.6），命中处无 HealthComponent。
 * 而按下点一直是 (0.5, 0.72)，比准星中心 (0.5, 0.4994) 低 22% 屏高 —— 恰好约 30°。
 *
 * 本脚本只改按下点、不改视角，看命中距离/俯仰/命中点是否随之变化，从而判定射线的瞄准源。
 *
 * 以下为原 hit-trace 说明（探针与解引用逻辑相同）：
 *
 * 静态分析已确认 RangedWeaponShotSimulator::SimulateShot 的骨架：
 *
 *     n = Physics.SphereCastNonAlloc(...)     // local12
 *     if (n <= 0) 跳过整个命中解析循环        // 0x4b2 br_if
 *     cnt = n & 255
 *     if (cnt <= 15) for (i<cnt) { ... HealthComponent::IsAlive ... GetHitMultiplierForBodyPart ... }
 *
 * 所以「开火却打不出伤害」只有两种可能：
 *   (A) n == 0 —— 射线什么都没扫到（几何/朝向问题）
 *   (B) n > 0  —— 扫到了，但循环里被筛掉（对象类别不对 / 不是教程监视的那批）
 *
 * 本脚本一次测量同时回答两问：
 *   1. main_VAL_sphereHits     每次 SimulateShot 的命中数
 *   2. main_CAP_tutSeqEvent    教程 SequenceEvent 实例指针 → 解引用出它监视的
 *                              List<HealthComponent> 里每个元素的真实类型名
 *
 * 用法: node tools/autoplay-hit-trace.mjs [url] [maxIter] [shots]
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const MAX_ITER = Number(process.argv[3] || 5);
const SHOTS = Number(process.argv[4] || 3);
const ROOT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun';
const OUT = ROOT + '/.workbuddy/probe-out';
const PY = 'C:/Users/11313/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9407;
const profile = mkdtempSync(join(tmpdir(), 'cdp-hit-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1000,1000', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  'http://127.0.0.1:8848/robots.txt'
], { stdio: 'ignore' });
process.on('exit', () => { try { child.kill(); } catch (e) {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const NOISE = /ASTC6X6|decompressing texture|本地 bundle|Odin Serializer|report_fail|storage-probe|命中映射|dn-sdk|glCreateShader|SoftMask|referenced script|Shader |Convex Mesh|kinematic body|RectTransform is being set|memorysetup|RemoteConfig|DeserializedConfiguration|Time set to|cloud-store|CloudStorage|PLUGIN|GameSessionTimeReporter|npc data impl/i;

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
window.__u32 = function (a) {
  var m = window.__wasmMemory; if (!m) return 0;
  try { return new DataView(m.buffer).getUint32(a >>> 0, true); } catch (e) { return 0; }
};
/* IL2CPP 对象头：[0]=Il2CppClass*。wasm32 下指针 4 字节，
   Il2CppClass 布局 image(0) gc_desc(4) name(8) namespaze(12) —— name 在 +8。
   老的 64 位假设是 +16，在 wasm 上会读出乱码。这里 +8/+16 都试，取像标识符的那个。 */
window.__cstr = function (a) {
  var m = window.__wasmMemory; if (!m || !a) return null;
  var u8; try { u8 = new Uint8Array(m.buffer); } catch (e) { return null; }
  var s = '';
  for (var i = 0; i < 120; i++) {
    var b = u8[(a + i) >>> 0]; if (!b) break;
    if (b < 0x20 || b > 0x7e) return null;      // 含不可打印字符 → 判为无效指针
    s += String.fromCharCode(b);
  }
  return s.length >= 2 ? s : null;
};
window.__typeName = function (o) {
  if (!o) return null;
  var k = window.__u32(o); if (!k) return null;
  return window.__cstr(window.__u32(k + 8)) || window.__cstr(window.__u32(k + 16));
};
/* 静态字段 addr 处存的是 Il2CppClass*，直接解出它代表的类型名 */
window.__classOfStatic = function (addr) {
  var k = window.__u32(addr); if (!k) return 'null';
  return window.__cstr(window.__u32(k + 8)) || window.__cstr(window.__u32(k + 16)) || ('?' + k);
};
window.__dumpTut = function () {
  var g = window.__dbg();
  var self = g.main_CAP_tutSeqEvent || 0;
  var r = { seqEventPtr: self, seqEventType: window.__typeName(self), aliveCount: g.main_VAL_tutAliveCount };
  if (!self) return r;
  var list = window.__u32(self + 32);
  r.listPtr = list; r.listType = window.__typeName(list);
  if (!list) return r;
  r.size = window.__u32(list + 12);
  var items = window.__u32(list + 8);
  r.itemsPtr = items; r.itemsType = window.__typeName(items);
  r.elems = [];
  var n = Math.min(r.size | 0, 20);
  for (var i = 0; i < n; i++) {
    var e = window.__u32(items + 16 + i * 4);
    r.elems.push({ i: i, ptr: e, type: window.__typeName(e) });
  }
  return r;
};
/* 读出 SphereCastNonAlloc 装进来的 RaycastHit[]，逐条解出碰撞体类型。
   RaycastHit 结构（32 位）：Point(0) Normal(12) FaceID(24) Distance(28) UV(32) Collider(40)，步长 44
   T[] 数组：klass(0) monitor(4) bounds(8) max_length(12) length(16) 数据(20)?? 
   结构体数组元素内联在 +16 之后，步长 44。 */
window.__dumpHits = function () {
  var g = window.__dbg();
  var arr = g.main_CAP_hitResults || 0;
  var out = { resultsPtr: arr, hits: [] };
  if (!arr) return out;
  out.arrType = window.__typeName(arr);
  out.len = window.__u32(arr + 12);
  out.len16 = window.__u32(arr + 16);
  var base = arr + 16;
  var n = Math.min(out.len | 0, 8);
  for (var i = 0; i < n; i++) {
    var p = base + i * 44;
    var col = window.__u32(p + 40);
    var go = col ? window.__u32(col + 8) : 0;
    out.hits.push({
      i: i, collider: col, colliderType: window.__typeName(col),
      gameObject: go,
      goType: window.__typeName(go),
      layer: go ? window.__u32(go + 12) : null,
      dist: (function () { try { return new DataView(window.__wasmMemory.buffer).getFloat32(p + 28, true); } catch (e) { return null; } })(),
    });
  }
  return out;
};
/* 8906 里四次 GetComponent<T> 用的 RuntimeClass 静态地址 —— 解出各自目标类型 */
window.__dumpGetComponents = function () {
  var A = [5599316, 5598152, 5598768, 5597836, 5562684, 5506244];
  var o = {};
  for (var i = 0; i < A.length; i++) o['@' + A[i]] = window.__classOfStatic(A[i]);
  return o;
};
window.__f32 = function (v) {
  var b = new ArrayBuffer(4); var dv = new DataView(b);
  dv.setInt32(0, v | 0, true); return dv.getFloat32(0, true);
};
/* 射线几何：原点 / 方向 / 命中点 / 命中距离 / 命中碰撞体 */
window.__geo = function () {
  var g = window.__dbg(), f = window.__f32;
  var o = {
    sphereHits: g.main_VAL_sphereHits,
    hitDist: f(g.main_LD_hitDist),
    hitPt: [f(g.main_LD_hitPointX), f(g.main_LD_hitPointY), f(g.main_LD_hitPointZ)],
    origin: [f(g.main_LD_rayOx), f(g.main_LD_rayOy), f(g.main_LD_rayOz)],
    dir: [f(g.main_LD_rayDx), f(g.main_LD_rayDy), f(g.main_LD_rayDz)],
    collider: g.main_LD_hitCollider,
  };
  o.colliderType = window.__typeName(o.collider);
  o.goLayer = o.collider ? window.__u32(window.__u32(o.collider + 8) + 12) : null;
  return o;
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
window.__gesture = function (x0, y0, dx, dy, steps, stepMs, holdMs) {
  var I = window.AutoplayInput;
  var cl = function (v) { return Math.max(0.02, Math.min(0.98, v)); };
  return new Promise(function (res) {
    I.press(cl(x0), cl(y0));
    var n = 0;
    var iv = setInterval(function () {
      n++; var f = n / steps;
      I.moveTo(cl(x0 + dx * f), cl(y0 + dy * f));
      if (n >= steps) {
        clearInterval(iv);
        var h = 0;
        var hv = setInterval(function () {
          h++; I.moveTo(cl(x0 + dx), cl(y0 + dy));
          if (h * 100 >= holdMs) { clearInterval(hv); I.release(cl(x0 + dx), cl(y0 + dy)); res('ok'); }
        }, 100);
      }
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
const KEY = (k) => /_in$|_end$|_r\d+$|_BR_|_PT_|_VAL_/.test(k);
function pick(o) { const r = {}; for (const k of Object.keys(o || {})) if (KEY(k)) r[k] = o[k]; return r; }
function diff(a, b) { const r = {}; for (const k of Object.keys(b)) { const d = (b[k] || 0) - (a[k] || 0); if (d) r[k] = d; } return r; }
function show(d) { const ks = Object.keys(d); if (!ks.length) return '  (全 0)'; return ks.map((k) => `  ${k.padEnd(32)} ${d[k] > 0 ? '+' + d[k] : d[k]}`).join('\n'); }

/** bias=8 的位掩码 → 走过的 state 列表 */
function decodeBits(v) {
  if (!v) return '(空)';
  const out = [];
  for (let i = 0; i < 32; i++) if (v & (1 << i)) out.push(i - 8);
  return `state{${out.join(',')}}`;
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

  const t0c = Date.now();
  const tutLog = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method !== 'Runtime.consoleAPICalled') return;
    const a = (m.params.args || []).map((x) => (x.value !== undefined ? x.value : x.description)).join(' ');
    const s = String(a || '');
    if (!s || NOISE.test(s)) return;
    const type = m.params.type || '';
    if (type === 'error' || type === 'warning' || /TUTORIAL_SEQUENCE|HealthComponents|GotoNextLevel/i.test(s)) {
      const line = `+${Math.round((Date.now() - t0c) / 1000)}s [${type}] ${s.slice(0, 220)}`;
      tutLog.push(line);
      log('   [log]', line);
    }
  });

  const ev = async (e) => {
    const r = await S('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, timeout: 180000 });
    if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description || '').slice(0, 300) };
    return r.result.value;
  };

  let n = 0;
  const scan = async (tag, frames = 3) => {
    let base = null; const all = [];
    for (let i = 0; i < frames; i++) {
      const sh = await S('Page.captureScreenshot', { format: 'png' });
      const p = join(OUT, `${tag}-${String(++n).padStart(2, '0')}.png`);
      writeFileSync(p, Buffer.from(sh.data, 'base64'));
      try {
        const o = execFileSync(PY, [ROOT + '/tools/target_scan.py', p, '--json'], { encoding: 'utf8', maxBuffer: 4 << 20 });
        const r = JSON.parse(o.trim().split('\n').pop());
        if (!base) base = r;
        for (const e of r.enemies) if (!all.some((x) => Math.abs(x.x - e.x) < 0.02 && Math.abs(x.y - e.y) < 0.02)) all.push(e);
      } catch (e) {}
      if (i < frames - 1) await sleep(360);
    }
    if (!base) return null;
    for (const e of all) e.dist = Math.round(Math.hypot(e.x - base.reticle.x, e.y - base.reticle.y) * 1e4) / 1e4;
    all.sort((a, b) => a.dist - b.dist);
    base.enemies = all;
    return base;
  };

  await S('Page.navigate', { url: URL_ });
  await sleep(2500);
  await ev('(function(){var b=document.getElementById("start-btn"); if(b) b.click(); return 1})()');
  log('=== 启动 ===');
  let ok = false;
  for (let i = 0; i < 80; i++) {
    await sleep(3000);
    const l = await ev('window.AutoplayPerception.observe().metrics.avgLuma');
    if (typeof l === 'number' && l > 178) { log(`  可玩 @ ${(i + 1) * 3}s luma=${l}`); ok = true; break; }
    if (i % 6 === 0) log(`  t=${(i + 1) * 3}s luma=${l}`);
    if (i % 2 === 0) await ev('window.__wxInjectTouch("start",0.5,0.5), window.__wxInjectTouch("end",0.5,0.5)');
  }
  if (!ok) { log('✘ 未进入战斗'); try { child.kill(); } catch (e) {} process.exit(2); }

  await ev('(function(){var b=document.getElementById("ap-fold"); if(b) b.click(); return 1})()');
  await ev(HELPERS);

  log('\n=== 探针自检 ===');
  log('  可写全局数 =', await ev('window.__resetAll()'));
  log('  wasm 内存可读 =', await ev('!!window.__wasmMemory'));
  const keys = await ev('Object.keys(window.__dbg()).filter(function(k){return /_VAL_|_CAP_|_BM_/.test(k)})');
  log('  新探针 =', JSON.stringify(keys));

  log('\n=== 等靶子 ===');
  let s = null;
  for (let i = 0; i < 14; i++) {
    s = await scan('hit', 3);
    log(`  t+${i * 2}s 红标敌人 ${s ? s.enemies.length : '?'}`);
    if (s && s.enemies.length) break;
  }
  if (!s || !s.enemies.length) { log('✘ 无敌人'); try { child.kill(); } catch (e) {} process.exit(3); }
  let tgt = s.enemies[0];
  log(`  → 锁定 (${tgt.x},${tgt.y}) dist=${tgt.dist}`);

  log('\n=== 对准 ===');
  let gx = 0.40, gy = 0.60;
  for (let it = 1; it <= MAX_ITER; it++) {
    const ex = tgt.x - s.reticle.x, ey = tgt.y - s.reticle.y;
    log(`  迭代 ${it}: 误差 (${ex.toFixed(4)},${ey.toFixed(4)})`);
    if (Math.abs(ex) < 0.012 && Math.abs(ey) < 0.016) { log('  ✔ 对准'); break; }
    let dx = ex / gx, dy = ey / gy;
    if (Math.abs(dx) > 0.14) dx = Math.sign(dx) * 0.14;
    if (Math.abs(dy) > 0.14) dy = Math.sign(dy) * 0.14;
    const sx = Math.max(0.06, Math.min(0.94, 0.5 - dx / 2));
    const sy = Math.max(0.58, Math.min(0.80, 0.70 - dy / 2));
    await ev(`window.__gesture(${sx.toFixed(4)},${sy.toFixed(4)},${dx.toFixed(4)},${dy.toFixed(4)},20,45,260)`);
    await sleep(2400);
    const s1 = await scan('hit', 3);
    if (!s1) break;
    let best = null, bd = 0.10;
    for (const t of s1.enemies) {
      const dd = Math.hypot(t.x - (tgt.x - gx * dx), t.y - (tgt.y - gy * dy));
      if (dd < bd) { bd = dd; best = t; }
    }
    if (!best) best = s1.enemies[0] || null;
    if (!best) { log('  ✘ 敌人全消失'); break; }
    if (Math.abs(dx) > 0.03) { const gm = (tgt.x - best.x) / dx; if (Math.abs(gm) > 0.1 && Math.abs(gm) < 2) gx = gx * 0.35 + gm * 0.65; }
    if (Math.abs(dy) > 0.03) { const gm = (tgt.y - best.y) / dy; if (Math.abs(gm) > 0.1 && Math.abs(gm) < 2.5) gy = gy * 0.35 + gm * 0.65; }
    tgt = best; s = s1;
  }

  log('\n=== 教程到底在监视什么（P0.3）===');
  const tut0 = String(await ev('JSON.stringify(window.__dumpTut())'));
  log('  ' + tut0.slice(0, 1200));
  log('\n=== 8906 里 GetComponent<T> 的目标类型 ===');
  log('  ' + String(await ev('JSON.stringify(window.__dumpGetComponents())')).slice(0, 800));

  /* ★ 关键对照：只改「按下/抬起的屏幕点」，不改视角。
     若 8906 里的射线方向跟着按下点走，则按下点越靠近准星中心 (0.5,0.4994)，
     命中距离应越远（趋近水平）、hitPoint.y 应越接近敌人高度、noHealth 应消失。 */
  const PRESS_Y = [0.72, 0.62, 0.56, 0.52, 0.4994];
  log('\n=== 按下点扫描（视角不动，只改开火时手指位置）===');
  const rounds = [];
  for (const py of PRESS_Y) {
    await ev('window.__resetAll()');
    await sleep(150);
    await ev(`window.__fire(0.5, ${py}, 380)`);
    await sleep(2400);
    const d = pick(await ev('window.__dbg()'));
    const geo = JSON.parse(await ev('JSON.stringify(window.__geo())'));
    const rej = { flag76: d.main_BR_SIM_rej_flag76 || 0, noHealth: d.main_BR_SIM_rej_noHealth || 0, notAlive: d.main_BR_SIM_rej_notAlive || 0 };
    const simRan = (d.main_SimulatorSimulateShot_in || 0) > 0;
    const hitOk = simRan && rej.flag76 === 0 && rej.noHealth === 0 && rej.notAlive === 0;
    const pitch = geo.dir[1] === 0 ? 0 : Math.asin(Math.max(-1, Math.min(1, geo.dir[1]))) * 180 / Math.PI;
    log(`\n  ── 按下点 y=${py} ──`);
    log(`    SimulateShot 跑了=${simRan}  命中数=${geo.sphereHits}  距离=${geo.hitDist.toFixed(2)}m`);
    log(`    方向=(${geo.dir.map((v) => v.toFixed(3)).join(', ')})  俯仰=${pitch.toFixed(1)}°  命中点y=${geo.hitPt[1].toFixed(1)}`);
    log(`    筛除: flag76=${rej.flag76} noHealth=${rej.noHealth} notAlive=${rej.notAlive}  → ${hitOk ? '★ 命中活体！' : '被筛'}`);
    log(`    伤害: TakeDamage=${d.main_TakeDamage_in || 0}  HitMultiplier=${d.main_HitMultiplierBodyPart_in || 0}  教程存活=${d.main_VAL_tutAliveCount}`);
    rounds.push({ py, d, geo, rej, hitOk, pitch, simRan });
    if ((d.main_TakeDamage_in || 0) > 0) { log('\n    ✔✔ 打出伤害了'); break; }
  }

  log('\n=== 结论摘要 ===');
  log('  按下点y / SimulateShot / 命中数 / 距离 / 俯仰 / 命中点y / 筛除 / 伤害');
  for (const r of rounds) {
    log(`  ${String(r.py).padStart(7)}  ${r.simRan ? 'Y' : 'n'}  ${r.geo.sphereHits}  ` +
        `${String(r.geo.hitDist.toFixed(1)).padStart(6)}m  ${String(r.pitch.toFixed(1)).padStart(6)}°  ` +
        `${String(r.geo.hitPt[1].toFixed(1)).padStart(8)}  ` +
        `rej(${r.rej.flag76},${r.rej.noHealth},${r.rej.notAlive})  dmg=${r.d.main_TakeDamage_in || 0}  ${r.hitOk ? '★' : ''}`);
  }
  log(`\n  命中活体的按下点 = ${JSON.stringify(rounds.filter((r) => r.hitOk).map((r) => r.py))}`);

  writeFileSync(join(OUT, 'hit-trace.json'), JSON.stringify({ tut0, rounds, tutLog }, null, 1));
  log('\n结果 → ' + join(OUT, 'hit-trace.json'));
  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
