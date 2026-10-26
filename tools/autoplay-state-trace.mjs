/**
 * autoplay-state-trace.mjs —— 协程状态位掩码追踪（P0.2 第五轮）
 *
 * 上一轮结论：ShootRoutineMN 推进了 44 步，但 HitHealthRoutineMN / MadeHitMoveNext
 * 一次都没进入 → 伤害分支根本没起。本轮回答「ShootRoutine 自己走到哪个 case 就退出了」。
 *
 * 新增探针：
 *   split_BM_ShootRoutineMN   <ShootRoutine>d__64::MoveNext 入口累积 (this[8] & 31) 的位掩码
 *   split_BM_ShootAsyncMN     同上
 *   main_BM_HitHealthMN / main_BM_MadeHitMN
 *   main_Shoot_end / main_SimulateShot_end / main_ShootWeapon_{r1,end}
 *      —— 「跑到函数末尾」 vs 「从第 1 个 return 提前退出」
 *
 * 关键技巧：WebAssembly 导出的可变 i32 全局在 JS 侧可写，
 * 所以每发之前可以把所有计数器清零，得到干净的单发增量。
 *
 * 用法: node tools/autoplay-state-trace.mjs [url] [maxIter] [shots]
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
const PORT = 9403;
const profile = mkdtempSync(join(tmpdir(), 'cdp-state-'));
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
const KEY = (k) => /_in$|_end$|_r\d+$|_BR_|_PT_/.test(k);
function pick(o) { const r = {}; for (const k of Object.keys(o || {})) if (KEY(k)) r[k] = o[k]; return r; }
function diff(a, b) { const r = {}; for (const k of Object.keys(b)) { const d = (b[k] || 0) - (a[k] || 0); if (d) r[k] = d; } return r; }
function show(d) { const ks = Object.keys(d); if (!ks.length) return '  (全 0)'; return ks.map((k) => `  ${k.padEnd(30)} +${d[k]}`).join('\n'); }

/** 位掩码 → 走过的 state 列表。负数状态落在高位：-1→bit31, -2→bit30, -3→bit29 */
function decodeBits(v) {
  if (!v) return '(空)';
  const pos = [], neg = [];
  for (let i = 0; i < 32; i++) {
    if (!(v & (1 << i))) continue;
    if (i >= 20) neg.push(i - 32); else pos.push(i);
  }
  const p = pos.length ? pos.join(',') : '-';
  const n = neg.length ? neg.join(',') : '-';
  return `state{${p}}  (高位置→负数状态: ${n})`;
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
    if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description || '').slice(0, 200) };
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

  // 探针自检：确认位掩码全局可读可写
  log('\n=== 探针自检 ===');
  const zeroed = await ev('window.__resetAll()');
  const probeNames = await ev('Object.keys(window.__dbg()).filter(function(k){return /_BM_|_end$|_r1$/.test(k)})');
  log('  可写全局数 =', zeroed);
  log('  关键探针存在 =', JSON.stringify(probeNames));

  log('\n=== 等靶子 ===');
  let s = null;
  for (let i = 0; i < 14; i++) {
    s = await scan('st', 3);
    const c = s ? s.enemies.length : 0;
    log(`  t+${i * 2}s 红标敌人 ${c}`);
    if (c) break;
  }
  if (!s || !s.enemies.length) { log('✘ 无敌人'); try { child.kill(); } catch (e) {} process.exit(3); }
  let tgt = s.enemies[0];
  log(`  → 锁定 (${tgt.x},${tgt.y}) dist=${tgt.dist}`);

  log('\n=== 对准（拖动释放本身也会开一枪）===');
  let gx = 0.40, gy = 0.60;
  for (let it = 1; it <= MAX_ITER; it++) {
    const ex = tgt.x - s.reticle.x, ey = tgt.y - s.reticle.y;
    log(`  迭代 ${it}: 误差 (${ex.toFixed(4)},${ey.toFixed(4)}) dist=${Math.hypot(ex, ey).toFixed(4)}`);
    if (Math.abs(ex) < 0.012 && Math.abs(ey) < 0.016) { log('  ✔ 对准'); break; }
    let dx = ex / gx, dy = ey / gy;
    if (Math.abs(dx) > 0.14) dx = Math.sign(dx) * 0.14;
    if (Math.abs(dy) > 0.14) dy = Math.sign(dy) * 0.14;
    const sx = Math.max(0.06, Math.min(0.94, 0.5 - dx / 2));
    const sy = Math.max(0.58, Math.min(0.80, 0.70 - dy / 2));
    await ev(`window.__gesture(${sx.toFixed(4)},${sy.toFixed(4)},${dx.toFixed(4)},${dy.toFixed(4)},20,45,260)`);
    await sleep(2400);
    const s1 = await scan('st', 3);
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
    log(`    新位置 (${best.x},${best.y}) dist=${Math.hypot(best.x - s.reticle.x, best.y - s.reticle.y).toFixed(4)}`);
  }

  log('\n=== 单发对照（每发前清零）===');
  const rounds = [];
  for (let k = 1; k <= SHOTS; k++) {
    await ev('window.__resetAll()');
    await sleep(120);
    await ev('window.__fire(0.5, 0.72, 420)');
    await sleep(2600);
    const d = pick(await ev('window.__dbg()'));
    const bits = {
      ShootRoutineMN: decodeBits(d.split_BM_ShootRoutineMN),
      ShootAsyncMN: decodeBits(d.split_BM_ShootAsyncMN),
      HitHealthMN: decodeBits(d.main_BM_HitHealthMN),
      MadeHitMN: decodeBits(d.main_BM_MadeHitMN),
    };
    log(`\n  ── 第 ${k} 发 ──`);
    log(show(d));
    log('    状态机走过的 state：');
    for (const [kk, vv] of Object.entries(bits)) log(`      ${kk.padEnd(15)} ${vv}`);
    rounds.push({ k, d, bits });
  }

  log('\n=== 最后一发后静置 8s（看迟到推进）===');
  const cMid = pick(await ev('window.__dbg()'));
  await sleep(8000);
  const cLate = pick(await ev('window.__dbg()'));
  log(show(diff(cMid, cLate)));

  log('\n教程日志：\n  ' + (tutLog.slice(-8).join('\n  ') || '(none)'));
  writeFileSync(join(OUT, 'state-trace.json'), JSON.stringify({ rounds, tutLog }, null, 1));
  log('\n结果 → ' + join(OUT, 'state-trace.json'));
  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
