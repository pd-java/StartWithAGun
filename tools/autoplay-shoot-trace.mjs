/**
 * autoplay-shoot-trace.mjs —— P0.1 + P0.3 一轮跑完：
 *
 *   P0.1  开火前后连续采样帧哈希 + rAF 计数，确认渲染循环是否还在推进
 *         （否则「4 帧像素一致」不能当「没开枪」的证据）
 *   P0.2  读取 tools/wasm_probe_marker.py 装好的 wasm 计数器
 *   P0.3  准星压住红标敌人 → 开火 → 读计数器，判断到底断在哪一步
 *
 * 用法: node tools/autoplay-shoot-trace.mjs [url] [maxIter] [shots]
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const MAX_ITER = Number(process.argv[3] || 7);
const SHOTS = Number(process.argv[4] || 3);
const ROOT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun';
const OUT = ROOT + '/.workbuddy/probe-out';
const PY = 'C:/Users/11313/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9391;
const profile = mkdtempSync(join(tmpdir(), 'cdp-trace-'));
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
  function take(o) {
    if (!o) return;
    for (var k in o) {
      try {
        var v = o[k];
        if (v && typeof v === 'object' && typeof v.value === 'number') out[k] = v.value;
      } catch (e) {}
    }
  }
  take(window.__wasmMainExports);
  try { take(GameGlobal.__wasmCode1Instance && GameGlobal.__wasmCode1Instance.exports); } catch (e) {}
  return out;
};
window.__gesture = function (x0, y0, dx, dy, steps, stepMs, holdMs) {
  var I = window.AutoplayInput;
  var cl = function (v) { return Math.max(0.02, Math.min(0.98, v)); };
  return new Promise(function (res) {
    I.press(cl(x0), cl(y0));
    var n = 0;
    var iv = setInterval(function () {
      n++;
      var f = n / steps;
      I.moveTo(cl(x0 + dx * f), cl(y0 + dy * f));
      if (n >= steps) {
        clearInterval(iv);
        var h = 0;
        var hv = setInterval(function () {
          h++;
          I.moveTo(cl(x0 + dx), cl(y0 + dy));
          if (h * 120 >= holdMs) {
            clearInterval(hv);
            I.release(cl(x0 + dx), cl(y0 + dy));
            res(JSON.stringify({ actualDx: cl(x0 + dx) - cl(x0), actualDy: cl(y0 + dy) - cl(y0) }));
          }
        }, 120);
      }
    }, stepMs);
  });
};
window.__fire = function (x, y, holdMs) {
  var I = window.AutoplayInput;
  return new Promise(function (res) {
    I.press(x, y);
    var h = 0;
    var hv = setInterval(function () {
      h++;
      I.moveTo(x, y);
      if (h * 120 >= holdMs) { clearInterval(hv); I.release(x, y); res('fired'); }
    }, 120);
  });
};
/** 连续采集 n 个「感知帧」的快照：rAF 序号 + 画面哈希 */
window.__frames = function (n, gapMs) {
  var P = window.AutoplayPerception;
  var out = [];
  return new Promise(function (res) {
    var i = 0;
    var iv = setInterval(function () {
      var st = P.stats();
      var s = P.observe();
      out.push({ t: Date.now(), frameNo: st.frameNo, hash: (s.metrics || {}).hash, luma: (s.metrics || {}).avgLuma, scene: s.scene });
      if (++i >= n) { clearInterval(iv); res(JSON.stringify(out)); }
    }, gapMs);
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
function send(method, params = {}, sessionId) {
  const msg = { id: ++id, method, params }; if (sessionId) msg.sessionId = sessionId;
  return new Promise((res, rej) => { pending.set(msg.id, { resolve: res, reject: rej }); ws.send(JSON.stringify(msg)); });
}

const KEY = (k) => /_in$|_end$|_r\d+$|_BR_|_PT_/.test(k);
function pick(o) { const r = {}; for (const k of Object.keys(o || {})) if (KEY(k)) r[k] = o[k]; return r; }
function diff(a, b) { const r = {}; for (const k of Object.keys(b)) { const d = (b[k] || 0) - (a[k] || 0); if (d) r[k] = d; } return r; }
function show(d) { const ks = Object.keys(d); if (!ks.length) return '  (全部为 0 —— 一个计数器都没动)'; return ks.map((k) => `  ${k.padEnd(30)} +${d[k]}`).join('\n'); }

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
    if (m.method === 'Runtime.consoleAPICalled') {
      const a = (m.params.args || []).map((x) => (x.value !== undefined ? x.value : x.description)).join(' ');
      const s = String(a || '');
      if (!s || NOISE.test(s)) return;
      if (/TUTORIAL_SEQUENCE|HealthComponents|GotoNextLevel|Level activated|TrackTutorial|wasm 实例化失败|CompileError/i.test(s)) {
        const line = `+${Math.round((Date.now() - t0c) / 1000)}s ${s.slice(0, 170)}`;
        tutLog.push(line); log('   [log]', line);
      }
    }
  });

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 180000 });
    if (r.exceptionDetails) return { __err: String((r.exceptionDetails.exception || {}).description || '').slice(0, 250) };
    return r.result.value;
  };

  let shotN = 0;
  const grab = async (tag) => {
    const name = `${tag}-${String(++shotN).padStart(2, '0')}`;
    const sh = await S('Page.captureScreenshot', { format: 'png' });
    const p = join(OUT, name + '.png');
    writeFileSync(p, Buffer.from(sh.data, 'base64'));
    return p;
  };
  const scanOne = async (tag) => {
    const p = await grab(tag);
    try {
      const out = execFileSync(PY, [ROOT + '/tools/target_scan.py', p, '--json'], { encoding: 'utf8', maxBuffer: 4 << 20 });
      const r = JSON.parse(out.trim().split('\n').pop());
      r.png = p; return r;
    } catch (e) { log('  ⚠ 识靶失败: ' + String(e.message).slice(0, 160)); return null; }
  };
  const scanUnion = async (tag, n = 3, gapMs = 380) => {
    let base = null; const all = [];
    for (let i = 0; i < n; i++) {
      const r = await scanOne(tag);
      if (!r) { await sleep(gapMs); continue; }
      if (!base) base = r;
      for (const e of r.enemies) {
        if (all.some((o) => Math.abs(o.x - e.x) < 0.02 && Math.abs(o.y - e.y) < 0.02)) continue;
        all.push(e);
      }
      if (i < n - 1) await sleep(gapMs);
    }
    if (!base) return null;
    for (const e of all) {
      e.errX = Math.round((e.x - base.reticle.x) * 1e4) / 1e4;
      e.errY = Math.round((e.y - base.reticle.y) * 1e4) / 1e4;
      e.dist = Math.round(Math.hypot(e.x - base.reticle.x, e.y - base.reticle.y) * 1e4) / 1e4;
    }
    all.sort((a, b) => a.dist - b.dist);
    base.enemies = all;
    return base;
  };

  // ───────────────────────────── 阶段 0：启动
  await S('Page.navigate', { url: URL_ });
  await sleep(2500);
  await evalJs('document.getElementById("start-btn").click()');

  log('=== 阶段 0：启动到可玩 ===');
  let entered = false;
  for (let i = 0; i < 80; i++) {
    await sleep(3000);
    const l = await evalJs('window.AutoplayPerception.observe().metrics.avgLuma');
    if (i % 5 === 0) log(`  t=${(i + 1) * 3}s luma=${l}`);
    if (l > 178) { log(`  进入战斗 @ ${(i + 1) * 3}s luma=${l}`); entered = true; break; }
    if (i % 2 === 0) await evalJs('window.__wxInjectTouch("start",0.5,0.5), window.__wxInjectTouch("end",0.5,0.5)');
  }
  if (!entered) { log('  ✘ 未进入战斗'); try { child.kill(); } catch (e) {} process.exit(2); }

  await evalJs('(function(){var b=document.getElementById("ap-fold"); if(b) b.click(); return 1})()');
  await evalJs(HELPERS);

  const hasMain = await evalJs('!!window.__wasmMainExports');
  const hasSplit = await evalJs('!!(window.GameGlobal && GameGlobal.__wasmCode1Instance)');
  log(`  诊断桩挂载：main=${hasMain}  split=${hasSplit}`);
  if (!hasMain) log('  ⚠ 主 wasm exports 未捕获，计数器读不到（打桩后需重启页面）');

  // ───────────────────────────── 阶段 1：等靶子
  log('\n=== 阶段 1：等待靶子生成 ===');
  let s = null;
  for (let i = 0; i < 16; i++) {
    s = await scanUnion('trace', 3, 380);
    const n = s ? s.enemies.length : 0;
    log(`  t+${i * 2}s 红标敌人 = ${n}  准星 (${s ? s.reticle.x : '?'}, ${s ? s.reticle.y : '?'})`);
    if (n > 0) break;
  }
  if (!s || !s.enemies.length) { log('  ✘ 无红标敌人，退出'); try { child.kill(); } catch (e) {} process.exit(3); }
  let tgt = s.enemies[0];
  log(`  → 锁定 (${tgt.x}, ${tgt.y})  dist=${tgt.dist}`);

  // ───────────────────────────── 阶段 2：P0.1 帧流活性
  log('\n=== 阶段 2（P0.1）：渲染循环是否在推进 ===');
  const fa = await evalJs('window.AutoplayPerception.stats().frameNo');
  const fr = JSON.parse(await evalJs('window.__frames(16, 160)') || '[]');
  const fb = await evalJs('window.AutoplayPerception.stats().frameNo');
  const span = fr.length > 1 ? (fr[fr.length - 1].t - fr[0].t) / 1000 : 0;
  const fps = span > 0 ? (fb - fa) / span : 0;
  const uniq = new Set(fr.map((x) => x.hash)).size;
  log(`  rAF 帧号 ${fa} → ${fb}，${span.toFixed(2)}s 内 ${fb - fa} 帧 ≈ ${fps.toFixed(1)} fps`);
  log(`  ${fr.length} 次采样中不同画面哈希 ${uniq} 个  (luma ${fr.length ? fr[0].luma : '?'} → ${fr.length ? fr[fr.length - 1].luma : '?'})`);

  // ───────────────────────────── 阶段 3：闭环对准（纯拖动，不开火 = 对照组）
  log('\n=== 阶段 3：闭环对准（只拖动，不开火）===');
  const cBefore = pick(await evalJs('window.__dbg()'));
  let gx = 0.40, gy = 0.60;
  let aligned = false;
  let drags = 0;

  for (let iter = 1; iter <= MAX_ITER && !aligned; iter++) {
    const rx = s.reticle.x, ry = s.reticle.y;
    const ex = tgt.x - rx, ey = tgt.y - ry;
    const dist = Math.hypot(ex, ey);
    log(`  迭代 ${iter}：误差 (${ex.toFixed(4)}, ${ey.toFixed(4)}) dist=${dist.toFixed(4)}`);
    if (Math.abs(ex) < 0.012 && Math.abs(ey) < 0.016) { aligned = true; break; }

    let dx = ex / gx, dy = ey / gy;
    const cap = 0.14;
    if (Math.abs(dx) > cap) dx = Math.sign(dx) * cap;
    if (Math.abs(dy) > cap) dy = Math.sign(dy) * cap;
    const sx = Math.max(0.06, Math.min(0.94, 0.5 - dx / 2));
    const sy = Math.max(0.58, Math.min(0.80, 0.70 - dy / 2));
    const gRaw = await evalJs(`window.__gesture(${sx.toFixed(4)},${sy.toFixed(4)},${dx.toFixed(4)},${dy.toFixed(4)},22,45,300)`);
    drags++;
    let g = null; try { g = JSON.parse(gRaw); } catch (e) {}
    await sleep(2400);

    const s1 = await scanUnion('trace', 3, 380);
    if (!s1) break;
    const adx = g ? g.actualDx : dx, ady = g ? g.actualDy : dy;
    const predX = tgt.x - gx * adx, predY = tgt.y - gy * ady;
    let best = null, bd = 0.09;
    for (const t of s1.enemies) { const d = Math.hypot(t.x - predX, t.y - predY); if (d < bd) { bd = d; best = t; } }
    if (!best) best = s1.enemies[0] || null;
    if (!best) { log('  ✘ 敌人消失'); break; }
    if (Math.abs(adx) > 0.03) { const gm = (tgt.x - best.x) / adx; if (Math.abs(gm) > 0.12 && Math.abs(gm) < 2.0) gx = gx * 0.35 + gm * 0.65; }
    if (Math.abs(ady) > 0.03) { const gm = (tgt.y - best.y) / ady; if (Math.abs(gm) > 0.12 && Math.abs(gm) < 2.5) gy = gy * 0.35 + gm * 0.65; }
    tgt = best; s = s1;
    log(`    目标 → (${best.x},${best.y}) 新距离 ${Math.hypot(best.x - s1.reticle.x, best.y - s1.reticle.y).toFixed(4)}`);
  }

  const cAfterDrag = pick(await evalJs('window.__dbg()'));
  log('\n  拖动对照组的计数器增量（应当只有 Update/LateUpdate/TouchPosition，没有 Shoot）：');
  log(show(diff(cBefore, cAfterDrag)));

  if (!aligned) {
    const d0 = Math.hypot(tgt.x - s.reticle.x, tgt.y - s.reticle.y);
    if (d0 < 0.03) { aligned = true; log(`  收敛到 ${d0.toFixed(4)}，视为对准`); }
  }
  log(`  对准状态：${aligned}（拖动 ${drags} 次，最终误差 ${Math.hypot(tgt.x - s.reticle.x, tgt.y - s.reticle.y).toFixed(4)}）`);

  // ───────────────────────────── 阶段 4：P0.3 开火 + 读计数器
  log('\n=== 阶段 4（P0.3）：开火并读取诊断计数器 ===');
  const cPre = pick(await evalJs('window.__dbg()'));
  for (let k = 1; k <= SHOTS; k++) {
    log(`\n  ── 第 ${k} 发 ──`);
    // 开火瞬间的帧流采样（P0.1 关键：连开火都冻结就说明渲染停了）
    const before = await evalJs('window.AutoplayPerception.stats().frameNo');
    const fireP = evalJs('window.__fire(0.5, 0.72, 420)');
    const framesP = evalJs('window.__frames(10, 110)');
    await fireP;
    const frFire = JSON.parse((await framesP) || '[]');
    const after = await evalJs('window.AutoplayPerception.stats().frameNo');
    const du = new Set(frFire.map((x) => x.hash)).size;
    log(`   开火窗口：rAF ${before} → ${after}（${after - before} 帧），${frFire.length} 次采样不同哈希 ${du} 个`);
    await sleep(1200);
    const cNow = pick(await evalJs('window.__dbg()'));
    log('   本发计数器增量：');
    log(show(diff(cPre, cNow)));
    // 记录累计
    if (k === SHOTS) {
      log('\n  全部开火后累计增量（相对开火前）：');
      log(show(diff(cPre, cNow)));
    }
  }

  await sleep(2000);
  const cEnd = pick(await evalJs('window.__dbg()'));

  log('\n=== 阶段 5：开火后画面 ===');
  const s2 = await scanUnion('trace-after', 3, 380);
  const near = s2 ? s2.enemies.filter((e) => Math.abs(e.x - tgt.x) < 0.05 && Math.abs(e.y - tgt.y) < 0.05) : [];
  log(`  敌人并集 ${s2 ? s2.enemies.length : '?'} 个，原位置附近 ${near.length} 个`);
  log('  教程日志尾部：\n    ' + (tutLog.slice(-6).join('\n    ') || '(none)'));

  const finalDiff = diff(cPre, cEnd);
  log('\n=== 汇总：开火触发的计数器（P0.2 判据）===');
  log(show(finalDiff));
  const verdict = [];
  const g = (k) => finalDiff[k] || 0;
  if (!g('main_Shoot_in')) verdict.push('Shoot 从未被调用 → 输入没送到射击逻辑（应查 InputBlocked / 触摸手势识别）');
  else {
    verdict.push(`Shoot 被调用 ${g('main_Shoot_in')} 次`);
    if (g('main_BR_rej_barrels')) verdict.push(`被 AreBarrelsReadyToFire 拒绝 ${g('main_BR_rej_barrels')} 次`);
    if (g('main_BR_rej_cover_hit')) verdict.push(`被掩体命中判定拒绝 ${g('main_BR_rej_cover_hit')} 次`);
    if (g('main_BR_rej_blockflag')) verdict.push(`被 player.blockFlag 拒绝 ${g('main_BR_rej_blockflag')} 次`);
    if (g('main_PT_guards_passed')) verdict.push(`三道守卫放行 ${g('main_PT_guards_passed')} 次`);
    if (g('main_SimulateShot_in')) verdict.push(`SimulateShot ${g('main_SimulateShot_in')} 次`);
    if (g('main_ShootWeapon_in')) verdict.push(`ShootWeapon ${g('main_ShootWeapon_in')} 次`);
    if (g('main_PlayProjectileSniper_in')) verdict.push(`枪声 ${g('main_PlayProjectileSniper_in')} 次`);
  }
  verdict.forEach((v) => log('  · ' + v));
  writeFileSync(join(OUT, 'shoot-trace.json'), JSON.stringify({ finalDiff, tutLog, fps, hasMain, hasSplit }, null, 1));

  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
