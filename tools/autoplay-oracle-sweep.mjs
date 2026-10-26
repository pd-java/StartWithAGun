/**
 * autoplay-oracle-sweep.mjs —— 不依赖视觉的「拖拽空间扫描」找命中角
 *
 * 为什么不用视觉：
 *   CDP 截图 3.7s + target_scan.py 子进程 ~21s；且红标经常整帧消失（参考图里 mark=[]）。
 *   而 `Shoot`(main:10883) 自带 1 bit 的「射界里有没有活体」判据：
 *       HasHealthComponentWithinRadiusOfShot(w, this@180) → 假则直接 return，连 SimulateShot 都不跑
 *   这个 bit 就是免费的瞄准 oracle，配合几何（命中点 z>0 说明打到了竖立物体）完全够用。
 *
 * 关卡（实测反汇编）：
 *   0x61 br_if → 半径内无活体        (rej_cover_hit)
 *   0x6c br_if → 弹匣没好           (rej_barrels)
 *   0x7b br_if → blockflag@161      (rej_blockflag)
 *   0x8d call 8905 SimulateShot     → 真做 SphereCast，才有 sphereHits / hitPt / 筛除原因
 *
 * 用法: node tools/autoplay-oracle-sweep.mjs [url]
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
const PORT = 9411;
const profile = mkdtempSync(join(tmpdir(), 'cdp-oracle-'));
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
window.__f32 = function (v) { var b = new ArrayBuffer(4); var dv = new DataView(b); dv.setInt32(0, v | 0, true); return dv.getFloat32(0, true); };
/* z 是「上」轴：origin z=2.9，地面 z=0 */
window.__geo = function () {
  var g = window.__dbg(), f = window.__f32;
  var d = [f(g.main_LD_rayDx), f(g.main_LD_rayDy), f(g.main_LD_rayDz)];
  var o = [f(g.main_LD_rayOx), f(g.main_LD_rayOy), f(g.main_LD_rayOz)];
  var p = [f(g.main_LD_hitPointX), f(g.main_LD_hitPointY), f(g.main_LD_hitPointZ)];
  var len = Math.hypot(d[0], d[1], d[2]) || 1;
  return {
    hits: g.main_VAL_sphereHits, dist: f(g.main_LD_hitDist),
    hitPt: p, origin: o, dir: d,
    yaw: +(Math.atan2(d[1], d[0]) * 180 / Math.PI).toFixed(2),        // 水平角（绕 z）
    pitch: +(Math.asin(Math.max(-1, Math.min(1, d[2] / len))) * 180 / Math.PI).toFixed(2)  // 俯仰（z 向上）
  };
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
window.__drag = function (x0, y0, dx, dy, steps, stepMs) {
  var I = window.AutoplayInput;
  var cl = function (v) { return Math.max(0.04, Math.min(0.96, v)); };
  return new Promise(function (res) {
    I.press(cl(x0), cl(y0));
    var n = 0;
    var iv = setInterval(function () {
      n++;
      I.moveTo(cl(x0 + dx * n / steps), cl(y0 + dy * n / steps));
      if (n >= steps) { clearInterval(iv); I.release(cl(x0 + dx), cl(y0 + dy)); res('ok'); }
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
    if (r.exceptionDetails) { log('   [ev-err]', String(r.exceptionDetails.exception?.description || '').slice(0, 200)); return null; }
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
  await ev('window.__resetAll()');

  const shoot = async () => {
    await ev('window.__resetAll()');
    await sleep(80);
    await ev('window.__fire(0.5, 0.72, 380)');
    await sleep(2000);
    const d = await ev('window.__dbg()');
    const g = await ev('window.__geo()');
    return {
      geo: g,
      gate: {
        radius: d.main_BR_rej_cover_hit || 0,
        barrels: d.main_BR_rej_barrels || 0,
        block: d.main_BR_rej_blockflag || 0,
        passed: d.main_PT_guards_passed || 0,
      },
      hh: d.main_HasHealthInShotRadius_r1 || 0,
      sim: d.main_SimulatorSimulateShot_in || 0,
      rej: { f76: d.main_BR_SIM_rej_flag76 || 0, noH: d.main_BR_SIM_rej_noHealth || 0, nA: d.main_BR_SIM_rej_notAlive || 0 },
      dmg: d.main_TakeDamage_in || 0,
      kill: d.main_HealthKill_in || 0,
      mult: d.main_HitMultiplierBodyPart_in || 0,
      tut: d.main_VAL_tutAliveCount || 0,
    };
  };
  const line = (tag, r) => {
    const g = r.geo;
    log(`  ${tag.padEnd(16)} gate(r${r.gate.radius}/b${r.gate.barrels}/k${r.gate.block}) hh=${r.hh} sim=${r.sim} ` +
        `hits=${String(g.hits).padStart(2)} dist=${g.dist.toFixed(1).padStart(5)} ` +
        `pt=(${g.hitPt.map((v) => v.toFixed(1)).join(',')}) ` +
        `yaw=${String(g.yaw).padStart(7)} pit=${String(g.pitch).padStart(6)} ` +
        `rej(${r.rej.f76},${r.rej.noH},${r.rej.nA}) dmg=${r.dmg} kill=${r.kill} tut=${r.tut}`);
  };

  log('\n=== 基线 ===');
  const b0 = await shoot();
  line('baseline', b0);
  const dir0 = b0.geo.dir;

  /* 拖拽方向标定：拖一次 +y，看 pitch 往哪边走、走多少 */
  log('\n=== 拖拽→俯仰标定 ===');
  await ev('window.__drag(0.5,0.70,0,0.03,10,30)');
  await sleep(400);
  const c1 = await shoot();
  line('drag +y0.03', c1);
  const dPitch = c1.geo.pitch - b0.geo.pitch;
  const gPitch = dPitch !== 0 ? -(dPitch / 0.03) : 0;   // 拖 +1 单位 → pitch 变 dPitch
  log(`  Δpitch=${dPitch.toFixed(3)}°  → 每单位拖动 ${dPitch.toFixed(3)}°  (G_pitch=${gPitch.toFixed(1)}°/单位)`);

  await ev('window.__drag(0.5,0.70,0.03,0,10,30)');
  await sleep(400);
  const c2 = await shoot();
  line('drag +x0.03', c2);
  log(`  Δyaw=${(c2.geo.yaw - c1.geo.yaw).toFixed(3)}°`);

  /* 纵向扫描：以 1.2° 为步长，往「往上」的方向走最多 14 步 */
  log('\n=== 纵向扫描（找「射界内有活体」）===');
  const upSign = dPitch > 0 ? 1 : -1;   // 拖 +y 让 pitch 变大 → 拖正方向就是"往上"
  const rows = [];
  let cur = 0;
  const STEP = 0.012;                   // 每次拖 0.012
  for (let k = 1; k <= 14; k++) {
    await ev(`window.__drag(0.5,0.70,0,${(STEP * upSign).toFixed(4)},8,25)`);
    await sleep(350);
    cur += STEP * upSign;
    const r = await shoot();
    r.dragY = cur;
    rows.push(r);
    line(`dy=${cur.toFixed(3)}`, r);
    if (r.dmg > 0 || r.kill > 0) { log('\n  ★★★ 打出伤害了！'); break; }
    if (r.gate.radius === 0 && r.sim > 0 && r.rej.noH === 0) { log('\n  ★ 命中活体（无筛除）'); break; }
  }

  const hit = rows.find((r) => r.dmg > 0 || r.kill > 0);
  const best = hit || rows.find((r) => r.sim > 0 && r.rej.noH === 0) || rows.find((r) => r.sim > 0);
  if (best && best.dmg === 0) {
    log('\n=== 横向微扫（在上一步纵向位置附近）===');
    const baseDragY = best.dragY - cur;   // 回到 best 位置
    await ev(`window.__drag(0.5,0.70,0,${baseDragY.toFixed(4)},8,25)`);
    await sleep(350);
    for (const ddx of [-0.02, -0.01, 0.01, 0.02, 0.03]) {
      await ev(`window.__drag(0.5,0.70,${ddx},0,8,25)`);
      await sleep(320);
      const r = await shoot();
      r.dragX = ddx;
      rows.push(r);
      line(`dx=${ddx}`, r);
      if (r.dmg > 0 || r.kill > 0) { log('\n  ★★★ 横向也命中！'); break; }
    }
  }

  const shots = await ev('(function(){var c=document.querySelector("canvas");var o=document.createElement("canvas");o.width=984;o.height=905;var x=o.getContext("2d");x.drawImage(c,0,0);return 1})()');
  void shots;

  writeFileSync(join(OUT, 'oracle-sweep.json'), JSON.stringify({ b0, c1, c2, dPitch, rows }, null, 1));
  log('\n结果 → ' + join(OUT, 'oracle-sweep.json'));
  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
