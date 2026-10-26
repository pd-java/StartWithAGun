/**
 * autoplay-projectile-trace.mjs —— 弹道层追踪（P0.3 第三轮）
 *
 * 前两轮实测：Shoot 全链路执行（SimulateShot→ShootWeapon→枪声→震动→弹道相机），
 * 但 HealthComponent::TakeDamage 始终为 0；四种按下位置（正中/下方/靶心/长按）
 * 结果完全一致 → 射击方向由摄像机决定，与手指位置无关。
 *
 * 本轮看弹体：HS_ProjectileMover 是否生成、是否发生碰撞、HS_HittedObject 是否收到伤害。
 * 对照组：先朝远处敌人打 2 发，再把视角一路压低朝近处地面打 3 发
 *         （地面几米内，若弹体正常工作必然碰撞）。
 *
 * 用法: node tools/autoplay-projectile-trace.mjs [url]
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const ROOT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun';
const OUT = ROOT + '/.workbuddy/probe-out';
const PY = 'C:/Users/11313/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9399;
const profile = mkdtempSync(join(tmpdir(), 'cdp-proj-'));
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
const SKIP = new Set(['main_Update_in', 'main_LateUpdate_in', 'main_CountAliveHealth_in',
  'main_ClampAimingDirection_in', 'main_CalculateSwayOffset_in', 'main_AllowAimingCheck_in',
  'main_GetMouseButtonUp_in', 'main_BR_upd_mouseup', 'main_BR_upd_f36', 'main_BR_upd_f24',
  'main_BR_upd_settings', 'main_BR_upd_canfire', 'main_BR_upd_f56', 'main_TouchPosition_in']);
const KEY = (k) => /_in$|_end$|_r\d+$|_BR_|_PT_/.test(k) && !SKIP.has(k);
function pick(o) { const r = {}; for (const k of Object.keys(o || {})) if (KEY(k)) r[k] = o[k]; return r; }
function diff(a, b) { const r = {}; for (const k of Object.keys(b)) { const d = (b[k] || 0) - (a[k] || 0); if (d) r[k] = d; } return r; }
function show(d) { const ks = Object.keys(d); if (!ks.length) return '    (全 0)'; return ks.map((k) => `    ${k.padEnd(28)} +${d[k]}`).join('\n'); }

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
    if (/TUTORIAL_SEQUENCE|HealthComponents|GotoNextLevel/i.test(s)) {
      const line = `+${Math.round((Date.now() - t0c) / 1000)}s ${s.slice(0, 160)}`;
      tutLog.push(line); log('   [log]', line);
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
    if (typeof l === 'number' && l > 178) { log(`  可玩 @ ${(i + 1) * 3}s`); ok = true; break; }
    if (i % 6 === 0) log(`  t=${(i + 1) * 3}s luma=${l}`);
    if (i % 2 === 0) await ev('window.__wxInjectTouch("start",0.5,0.5), window.__wxInjectTouch("end",0.5,0.5)');
  }
  if (!ok) { log('✘ 未进入战斗'); try { child.kill(); } catch (e) {} process.exit(2); }
  await ev('(function(){var b=document.getElementById("ap-fold"); if(b) b.click(); return 1})()');
  await ev(HELPERS);

  log('\n=== 等靶子 ===');
  let s = null;
  for (let i = 0; i < 14; i++) {
    s = await scan('mode', 3);
    const c = s ? s.enemies.length : 0;
    log(`  t+${i * 2}s 敌人 ${c}`);
    if (c) break;
  }
  if (!s || !s.enemies.length) { log('✘ 无敌人'); try { child.kill(); } catch (e) {} process.exit(3); }
  let tgt = s.enemies[0];
  log(`  → 锁定 (${tgt.x},${tgt.y}) dist=${tgt.dist}  准星 (${s.reticle.x},${s.reticle.y})`);

  log('\n=== 对准 ===');
  let gx = 0.40, gy = 0.60;
  for (let it = 1; it <= 5; it++) {
    const ex = tgt.x - s.reticle.x, ey = tgt.y - s.reticle.y;
    const d = Math.hypot(ex, ey);
    log(`  迭代 ${it}: dist=${d.toFixed(4)}`);
    if (Math.abs(ex) < 0.012 && Math.abs(ey) < 0.016) { log('  ✔ 对准'); break; }
    let dx = ex / gx, dy = ey / gy;
    if (Math.abs(dx) > 0.14) dx = Math.sign(dx) * 0.14;
    if (Math.abs(dy) > 0.14) dy = Math.sign(dy) * 0.14;
    const sx = Math.max(0.06, Math.min(0.94, 0.5 - dx / 2));
    const sy = Math.max(0.58, Math.min(0.80, 0.70 - dy / 2));
    await ev(`window.__gesture(${sx.toFixed(4)},${sy.toFixed(4)},${dx.toFixed(4)},${dy.toFixed(4)},20,45,260)`);
    await sleep(2400);
    const s1 = await scan('mode', 3);
    if (!s1) break;
    let best = null, bd = 0.10;
    for (const t of s1.enemies) {
      const dd = Math.hypot(t.x - (tgt.x - gx * dx), t.y - (tgt.y - gy * dy));
      if (dd < bd) { bd = dd; best = t; }
    }
    if (!best) best = s1.enemies[0] || null;
    if (!best) { log('  ✘ 敌人消失'); break; }
    if (Math.abs(dx) > 0.03) { const gm = (tgt.x - best.x) / dx; if (Math.abs(gm) > 0.1 && Math.abs(gm) < 2) gx = gx * 0.35 + gm * 0.65; }
    if (Math.abs(dy) > 0.03) { const gm = (tgt.y - best.y) / dy; if (Math.abs(gm) > 0.1 && Math.abs(gm) < 2.5) gy = gy * 0.35 + gm * 0.65; }
    tgt = best; s = s1;
    log(`    → (${best.x},${best.y}) dist=${Math.hypot(best.x - s1.reticle.x, best.y - s1.reticle.y).toFixed(4)}`);
  }

  const rx = s.reticle.x, ry = s.reticle.y;
  const results = [];
  const snap = async (label) => {
    const c1 = pick(await ev('window.__dbg()'));
    const d = diff(cBase, c1);
    log(`\n  【${label}】 累计增量：`);
    log(show(d));
    results.push({ v: label, d });
  };
  let cBase = pick(await ev('window.__dbg()'));

  log('\n=== D1：朝远处敌人开 2 发 ===');
  for (let k = 0; k < 2; k++) { await ev(`window.__fire(${rx.toFixed(4)}, ${ry.toFixed(4)}, 420)`); await sleep(2200); }
  await snap('D1_远处敌人');
  cBase = pick(await ev('window.__dbg()'));

  log('\n=== D2：视角一路压低，朝近处地面开 3 发 ===');
  for (let k = 1; k <= 3; k++) {
    // 竖直：世界移动方向与手指相同，增益约 0.82 → 想往下看，手指往下拖
    await ev(`window.__gesture(0.5, 0.62, 0, 0.16, 14, 40, 200)`);
    await sleep(1800);
    await ev(`window.__fire(${rx.toFixed(4)}, ${ry.toFixed(4)}, 420)`);
    await sleep(2000);
    log(`    第 ${k} 次压低后已开火`);
  }
  await snap('D2_近处地面');
  log('\n教程日志：\n  ' + (tutLog.slice(-6).join('\n  ') || '(none)'));
  writeFileSync(join(OUT, 'fire-modes.json'), JSON.stringify(results, null, 1));
  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
