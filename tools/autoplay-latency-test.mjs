/**
 * autoplay-latency-test.mjs —— 靶子运动速度 + 最小延迟开火
 *
 * 已排除：
 *   ✗ 按下点即瞄准点（改按下点，射线方向完全不变）
 *   ✗ 瞄准源错（射线朝准星，俯仰与「准星压在靶上」一致）
 * 已确证：
 *   ✓ 球形投射命中地面，命中处无 HealthComponent（筛除原因 noHealth=1）
 *
 * 本轮要证的是：靶子沿 spline 跑动，而「截图 → 拖动 → 再截图 → 开火」有 1~2s 延迟，
 * 导致射线始终落在靶子 1s 前的位置（差半个身位就只打到脚下地面）。
 *
 * 两段测量：
 *   1. 连续截图（~250ms 间隔）测靶心屏幕位移 → 换算成角速度
 *   2. 用「同一张截图」既算瞄准又立刻开火（延迟压到 ~200ms），逐发记录残差与伤害
 *
 * 用法: node tools/autoplay-latency-test.mjs [url] [shots]
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const SHOTS = Number(process.argv[3] || 6);
const ROOT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun';
const OUT = ROOT + '/.workbuddy/probe-out';
const PY = 'C:/Users/11313/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9411;
const profile = mkdtempSync(join(tmpdir(), 'cdp-lat-'));
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
window.__resetAll = function () {
  var n = 0;
  function zero(o) { if (!o) return; for (var k in o) { try { var v = o[k]; if (v && typeof v === 'object' && typeof v.value === 'number') { v.value = 0; n++; } } catch (e) {} } }
  zero(window.__wasmMainExports);
  try { zero(GameGlobal.__wasmCode1Instance && GameGlobal.__wasmCode1Instance.exports); } catch (e) {}
  return n;
};
/* 快速拖动：steps 小、间隔短，尽量少占延迟 */
window.__nudgeFast = function (dx, dy) {
  var I = window.AutoplayInput;
  return new Promise(function (res) {
    var cl = function (v) { return Math.max(0.02, Math.min(0.98, v)); };
    I.press(0.5, 0.66);
    var n = 0;
    var iv = setInterval(function () {
      n++; var f = n / 5;
      I.moveTo(cl(0.5 + dx * f), cl(0.66 + dy * f));
      if (n >= 5) { clearInterval(iv); I.release(cl(0.5 + dx), cl(0.66 + dy)); res(1); }
    }, 16);
  });
};
/* 让开火方向不再被上一次拖动的余韵影响：轻点一下确认视角稳定（不移动） */
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
const KEY = (k) => /_in$|_BR_SIM_|_VAL_/.test(k);
function pick(o) { const r = {}; for (const k of Object.keys(o || {})) if (KEY(k)) r[k] = o[k]; return r; }

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
    if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description || '').slice(0, 300) };
    return r.result.value;
  };

  let n = 0;
  const snap = async (tag) => {
    const t0 = Date.now();
    const sh = await S('Page.captureScreenshot', { format: 'png' });
    const p = join(OUT, `${tag}-${String(++n).padStart(2, '0')}.png`);
    writeFileSync(p, Buffer.from(sh.data, 'base64'));
    let r = null;
    try {
      const o = execFileSync(PY, [ROOT + '/tools/target_scan.py', p, '--json'], { encoding: 'utf8', maxBuffer: 4 << 20 });
      r = JSON.parse(o.trim().split('\n').pop());
    } catch (e) {}
    return { r, ms: Date.now() - t0 };
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
    if (i % 8 === 0) log(`  t=${(i + 1) * 3}s luma=${l}`);
    if (i % 2 === 0) await ev('window.__wxInjectTouch("start",0.5,0.5), window.__wxInjectTouch("end",0.5,0.5)');
  }
  if (!ok) { log('✘ 未进入战斗'); try { child.kill(); } catch (e) {} process.exit(2); }
  await ev('(function(){var b=document.getElementById("ap-fold"); if(b) b.click(); return 1})()');
  await ev(HELPERS);

  // 等靶子
  let base = null;
  for (let i = 0; i < 18; i++) {
    const s = await snap('wait');
    if (s.r && s.r.enemies && s.r.enemies.length) { base = s.r; break; }
    log(`  t+${i * 2}s 敌人 ${s.r && s.r.enemies ? s.r.enemies.length : '?'}  截图+识别耗时 ${s.ms}ms`);
    await sleep(1500);
  }
  if (!base) { log('✘ 无敌人'); try { child.kill(); } catch (e) {} process.exit(3); }
  log(`  → 敌人数 ${base.enemies.length}  准星 (${base.reticle.x},${base.reticle.y})`);

  log('\n=== 1) 靶心运动速度（连拍 4 张）===');
  const seq = [];
  for (let i = 0; i < 4; i++) {
    const s = await snap('vel');
    let best = null, bd = 1;
    for (const t of (s.r && s.r.enemies) || []) {
      const dd = Math.hypot(t.x - base.enemies[0].x, t.y - base.enemies[0].y);
      if (dd < bd) { bd = dd; best = t; }
    }
    seq.push({ t: Date.now(), pos: best, ms: s.ms, n: s.r ? s.r.enemies.length : 0 });
    log(`  第${i + 1}张 敌人数=${seq[i].n} 位置=${best ? `(${best.x.toFixed(4)},${best.y.toFixed(4)})` : '未检出'} 截图+识别=${s.ms}ms`);
    if (best) base.enemies[0] = best;
    await sleep(220);
  }
  let vel = null;
  for (let i = 1; i < seq.length; i++) {
    if (!seq[i].pos || !seq[i - 1].pos) continue;
    const dt = (seq[i].t - seq[i - 1].t) / 1000;
    const d = Math.hypot(seq[i].pos.x - seq[i - 1].pos.x, seq[i].pos.y - seq[i - 1].pos.y);
    log(`  帧间 ${dt.toFixed(2)}s 位移 ${d.toFixed(4)} → ${(d / dt).toFixed(4)}/s`);
    if (vel === null || d / dt > vel) vel = d / dt;
  }
  log(`  最大屏幕速度 ≈ ${vel === null ? 'n/a' : vel.toFixed(4) + ' /s'}`);

  log('\n=== 2) 最小延迟开火（同一张截图既算瞄准又立刻开火）===');
  let gx = 0.40, gy = 0.60;
  const rows = [];
  for (let k = 1; k <= SHOTS; k++) {
    const s = await snap('lowlat');
    if (!s.r || !s.r.enemies || !s.r.enemies.length) { log(`  第${k}发：目标未检出，跳过`); await sleep(800); continue; }
    let tgt = null, bd = 1;
    for (const t of s.r.enemies) {
      const dd = Math.hypot(t.x - s.r.reticle.x, t.y - s.r.reticle.y);
      if (dd < bd) { bd = dd; tgt = t; }
    }
    const ex = tgt.x - s.r.reticle.x, ey = tgt.y - s.r.reticle.y;
    const tf = Date.now();
    let dx = ex / gx, dy = ey / gy;
    if (Math.abs(dx) > 0.06) dx = Math.sign(dx) * 0.06;
    if (Math.abs(dy) > 0.06) dy = Math.sign(dy) * 0.06;
    await ev('window.__resetAll()');
    if (Math.abs(dx) > 0.002 || Math.abs(dy) > 0.002) {
      await ev(`window.__nudgeFast(${dx.toFixed(4)},${dy.toFixed(4)})`);
    }
    await sleep(80);
    await ev('window.__press(0.5, 0.72)');
    await sleep(70);
    await ev('window.__release(0.5, 0.72)');
    const lat = Date.now() - tf;
    await sleep(2000);
    const d = pick(await ev('window.__dbg()'));
    // 更新增益：再拍一张看靶子实际移动了多少
    const s2 = await snap('after');
    let after = null;
    if (s2.r && s2.r.enemies && s2.r.enemies.length) {
      let bb = null, bdd = 1;
      for (const t of s2.r.enemies) {
        const dd = Math.hypot(t.x - (tgt.x - gx * dx), t.y - (tgt.y - gy * dy));
        if (dd < bdd) { bdd = dd; bb = t; }
      }
      after = bb;
      if (bb && Math.abs(dx) > 0.01) { const gm = (tgt.x - bb.x) / dx; if (Math.abs(gm) > 0.1 && Math.abs(gm) < 2) gx = gx * 0.4 + gm * 0.6; }
      if (bb && Math.abs(dy) > 0.01) { const gm = (tgt.y - bb.y) / dy; if (Math.abs(gm) > 0.1 && Math.abs(gm) < 2.5) gy = gy * 0.4 + gm * 0.6; }
    }
    const hits = d.main_VAL_sphereHits || 0;
    const noH = d.main_BR_SIM_rej_noHealth || 0, f76 = d.main_BR_SIM_rej_flag76 || 0, nA = d.main_BR_SIM_rej_notAlive || 0;
    const dmg = d.main_TakeDamage_in || 0;
    const sim = d.main_SimulatorSimulateShot_in || 0;
    log(`\n  ── 第 ${k} 发（测量→开火延迟 ${lat}ms）──`);
    log(`    开火前残差 (${ex.toFixed(4)},${ey.toFixed(4)}) |r|=${bd.toFixed(4)}  拖动 (${dx.toFixed(4)},${dy.toFixed(4)})`);
    log(`    SimulateShot=${sim} sphereHits=${hits} 筛除(f76=${f76},noH=${noH},nA=${nA}) ${sim && !noH && !f76 && !nA ? '★命中活体' : ''}`);
    log(`    伤害 TakeDamage=${dmg} Kill=${d.main_HealthKill_in || 0} 教程存活=${d.main_VAL_tutAliveCount}`);
    rows.push({ k, lat, ex, ey, bd, dx, dy, hits, noH, f76, nA, dmg, sim });
    if (dmg > 0) { log('\n  ✔✔✔ 打出伤害了！'); break; }
  }

  log('\n=== 汇总 ===');
  for (const r of rows) {
    log(`  第${r.k}发 延迟=${r.lat}ms 残差=${r.bd.toFixed(3)} hits=${r.hits} noH=${r.noH} sim=${r.sim} dmg=${r.dmg}`);
  }
  writeFileSync(join(OUT, 'latency.json'), JSON.stringify({ vel, seq, rows }, null, 1));
  log('\n结果 → ' + join(OUT, 'latency.json'));
  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
