/**
 * autoplay-aimprecise-test.mjs —— 开火瞬间的瞄准精度实测
 *
 * 已排除的假设：
 *   ✗ 按下点即瞄准点 —— y 从 0.72 改到 0.56，射线方向完全不变（俯仰恒定 -31.5°）
 *   ✓ 射线朝准星方向；命中点落在地面，命中处无 HealthComponent（筛除原因 noHealth=1）
 *
 * 剩余最可能原因：瞄准精度不足。靶子是沿 spline 跑动的 NPC
 * （启动日志有 FSM-RunningFollowSplineFailOnEnd），而我们的闭环瞄准
 * 容差是 0.012/0.016 屏高，在 15m 距离上约合 0.3~0.5m —— 与胶囊半径同量级。
 *
 * 本脚本做三件事：
 *   1. 用更紧的容差收敛瞄准，并记录每次迭代的残差
 *   2. **在按住到抬起之间截图**，测出「真正开火那一刻」靶心相对准星的偏差
 *   3. 连续若干发，逐发记录残差与伤害计数
 *
 * 用法: node tools/autoplay-aimprecise-test.mjs [url] [maxIter] [shots]
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const MAX_ITER = Number(process.argv[3] || 12);
const SHOTS = Number(process.argv[4] || 4);
const ROOT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun';
const OUT = ROOT + '/.workbuddy/probe-out';
const PY = 'C:/Users/11313/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9409;
const profile = mkdtempSync(join(tmpdir(), 'cdp-prec-'));
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
window.__press = function (x, y) { window.AutoplayInput.press(x, y); return 1; };
window.__release = function (x, y) { window.AutoplayInput.release(x, y); return 1; };
window.__nudge = function (dx, dy, steps, stepMs) {
  var I = window.AutoplayInput;
  var cl = function (v) { return Math.max(0.02, Math.min(0.98, v)); };
  return new Promise(function (res) {
    I.press(0.5, 0.66);
    var n = 0;
    var iv = setInterval(function () {
      n++; var f = n / steps;
      I.moveTo(cl(0.5 + dx * f), cl(0.66 + dy * f));
      if (n >= steps) { clearInterval(iv); I.release(cl(0.5 + dx), cl(0.66 + dy)); res('ok'); }
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

  const t0c = Date.now();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method !== 'Runtime.consoleAPICalled') return;
    const a = (m.params.args || []).map((x) => (x.value !== undefined ? x.value : x.description)).join(' ');
    const s = String(a || '');
    if (!s || NOISE.test(s)) return;
    const type = m.params.type || '';
    if (type === 'error' || /TUTORIAL_SEQUENCE|GotoNextLevel/i.test(s)) log(`   [log] +${Math.round((Date.now() - t0c) / 1000)}s [${type}] ${s.slice(0, 200)}`);
  });

  const ev = async (e) => {
    const r = await S('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, timeout: 180000 });
    if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description || '').slice(0, 300) };
    return r.result.value;
  };

  let n = 0;
  const shot = async (tag) => {
    const sh = await S('Page.captureScreenshot', { format: 'png' });
    const p = join(OUT, `${tag}-${String(++n).padStart(2, '0')}.png`);
    writeFileSync(p, Buffer.from(sh.data, 'base64'));
    try {
      const o = execFileSync(PY, [ROOT + '/tools/target_scan.py', p, '--json'], { encoding: 'utf8', maxBuffer: 4 << 20 });
      return JSON.parse(o.trim().split('\n').pop());
    } catch (e) { return null; }
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

  log('\n=== 等靶子 ===');
  let s = null;
  for (let i = 0; i < 16; i++) {
    s = await shot('pre');
    if (s && s.enemies && s.enemies.length) break;
    log(`  t+${i * 2}s 敌人 ${s && s.enemies ? s.enemies.length : '?'}`);
    await sleep(1800);
  }
  if (!s || !s.enemies.length) { log('✘ 无敌人'); try { child.kill(); } catch (e) {} process.exit(3); }

  log('\n=== 瞄准高度偏置扫描（每档都重新闭环对准）===');
  let gx = 0.40, gy = 0.60;
  let tgt = s.enemies[0];
  let reticle = s.reticle;

  /* 把「靶心 - 准星」的残差驱动到 (0, -bias)：bias>0 = 瞄得更高 */
  async function aimLoop(bias, iters) {
    for (let it = 0; it < iters; it++) {
      const ex = tgt.x - reticle.x;
      const ey = (tgt.y - reticle.y) + bias;
      if (Math.abs(ex) < 0.004 && Math.abs(ey) < 0.005) return { ex, ey, settled: true };
      let dx = ex / gx, dy = ey / gy;
      if (Math.abs(dx) > 0.09) dx = Math.sign(dx) * 0.09;
      if (Math.abs(dy) > 0.09) dy = Math.sign(dy) * 0.09;
      await ev(`window.__nudge(${dx.toFixed(4)},${dy.toFixed(4)},12,32)`);
      await sleep(900);
      const s1 = await shot('aim');
      if (!s1 || !s1.enemies.length) return { ex: null, ey: null, settled: false };
      let best = null, bd = 0.05;
      for (const t of s1.enemies) {
        const dd = Math.hypot(t.x - (tgt.x - gx * dx), t.y - (tgt.y - gy * dy));
        if (dd < bd) { bd = dd; best = t; }
      }
      if (!best) best = s1.enemies[0];
      if (Math.abs(dx) > 0.015) { const gm = (tgt.x - best.x) / dx; if (Math.abs(gm) > 0.1 && Math.abs(gm) < 2) gx = gx * 0.4 + gm * 0.6; }
      if (Math.abs(dy) > 0.015) { const gm = (tgt.y - best.y) / dy; if (Math.abs(gm) > 0.1 && Math.abs(gm) < 2.5) gy = gy * 0.4 + gm * 0.6; }
      tgt = best; reticle = s1.reticle;
    }
    return { ex: tgt.x - reticle.x, ey: tgt.y - reticle.y, settled: false };
  }

  const BIASES = [0, 0.008, 0.016, 0.026, 0.040, 0.058];
  const rows = [];
  for (const bias of BIASES) {
    const r = await aimLoop(bias, 7);
    await ev('window.__resetAll()');
    await ev('window.__press(0.5, 0.72)');
    await sleep(90);
    const sFire = await shot('fire');
    await ev('window.__release(0.5, 0.72)');
    await sleep(2200);
    const d = pick(await ev('window.__dbg()'));

    let fe = null;
    if (sFire && sFire.enemies && sFire.enemies.length) {
      let best = null, bd = 1;
      for (const t of sFire.enemies) {
        const dd = Math.hypot(t.x - sFire.reticle.x, t.y - sFire.reticle.y);
        if (dd < bd) { bd = dd; best = t; }
      }
      if (best) fe = { ex: best.x - sFire.reticle.x, ey: best.y - sFire.reticle.y, d: bd };
    }
    const hits = d.main_VAL_sphereHits || 0;
    const rej = { f76: d.main_BR_SIM_rej_flag76 || 0, noH: d.main_BR_SIM_rej_noHealth || 0, nA: d.main_BR_SIM_rej_notAlive || 0 };
    const dmg = d.main_TakeDamage_in || 0;
    const hitOk = (d.main_SimulatorSimulateShot_in || 0) > 0 && rej.f76 === 0 && rej.noH === 0 && rej.nA === 0;
    log(`\n  ── bias=${bias} ──`);
    log(`    开火瞬间「靶心-准星」= ${fe ? `(${fe.ex.toFixed(4)}, ${fe.ey.toFixed(4)})` : '未检出'}  目标残差=${r.ex === null ? 'n/a' : `(${r.ex.toFixed(4)},${r.ey.toFixed(4)})`}`);
    log(`    SimulateShot=${d.main_SimulatorSimulateShot_in || 0} sphereHits=${hits} 筛除(f76=${rej.f76},noH=${rej.noH},nA=${rej.nA}) ${hitOk ? '★命中活体' : ''}`);
    log(`    伤害 TakeDamage=${dmg} Kill=${d.main_HealthKill_in || 0} HitMultiplier=${d.main_HitMultiplierBodyPart_in || 0} 教程存活=${d.main_VAL_tutAliveCount}`);
    rows.push({ bias, fe, r, hits, rej, dmg, hitOk });
    await sleep(500);
    if (dmg > 0) { log('\n  ✔✔✔ 打出伤害了，停止扫描'); break; }
  }

  log('\n=== 汇总 ===');
  for (const x of rows) {
    log(`  bias=${String(x.bias).padEnd(6)} 偏差=${x.fe ? x.fe.d.toFixed(4) : 'n/a'} hits=${x.hits} ` +
        `rej(${x.rej.f76},${x.rej.noH},${x.rej.nA}) dmg=${x.dmg} ${x.hitOk ? '★' : ''}`);
  }
  log(`  命中活体的 bias = ${JSON.stringify(rows.filter((x) => x.hitOk).map((x) => x.bias))}`);

  writeFileSync(join(OUT, 'aimprecise.json'), JSON.stringify(rows, null, 1));
  log('\n结果 → ' + join(OUT, 'aimprecise.json'));
  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
