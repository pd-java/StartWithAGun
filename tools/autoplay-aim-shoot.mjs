/**
 * autoplay-aim-shoot.mjs —— 闭环瞄准 → 开火（v5）
 *
 * 版本演进（每一步都是被实测逼出来的，不是重构爱好）：
 *   v3  "深色连通域 + 离准星最近"            → 挑到混凝土隔离墩，白打
 *   v4  改用头顶纯红标记做锚点                → 但只扫单帧，而红标记会闪；
 *                                              而且扫描发生在靶子生成之前
 *   v5  ← 本文件，三处修正：
 *       1. **多帧并集**：连拍 3 帧（间隔 350ms）取并集。红标记是闪烁的，
 *          单帧命中率只有一半左右，实测同一局里敌人数在 2/0/1/0/2 之间跳。
 *       2. **等靶子真的出现再动手**：进入战斗不等于靶子已生成，
 *          实测 +173s 教程开始、+217s 才打印 "Waiting for targets ... total=2"。
 *          所以轮询到至少一个红标记才开火，而不是靠固定 sleep。
 *       3. **增益符号自适应**：横向实测"手指左拖 → 场景右移"（增益 +0.40），
 *          竖直方向实测符号相反。与其猜，不如每步测量后自检：
 *          误差变大就翻转符号。同时用滑动平均持续校准增益大小。
 *
 * 一次手势 = press → N 个 move → 保持 → release；对准后补一次原地 press-hold-release 开火。
 *
 * 用法: node tools/autoplay-aim-shoot.mjs [url] [maxIter]
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const MAX_ITER = Number(process.argv[3] || 8);
const ROOT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun';
const OUT = ROOT + '/.workbuddy/probe-out';
const PY = 'C:/Users/11313/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9389;
const profile = mkdtempSync(join(tmpdir(), 'cdp-aim5-'));
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

const GEST = `
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
      if (/TUTORIAL_SEQUENCE|HealthComponents|GotoNextLevel|Level activated|TrackTutorial/i.test(s)) {
        const line = `+${Math.round((Date.now() - t0c) / 1000)}s ${s.slice(0, 170)}`;
        tutLog.push(line); console.log('   [tut]', line);
      }
    }
  });

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 120000 });
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
      r.png = p;
      return r;
    } catch (e) {
      log('  ⚠ 识靶失败: ' + String(e.message).slice(0, 180));
      return null;
    }
  };
  /** 连拍 n 帧取敌人并集（红标记会闪，单帧只有一半命中率） */
  const scanUnion = async (tag, n = 3, gapMs = 380) => {
    let base = null;
    const all = [];
    const marks = new Set();
    for (let i = 0; i < n; i++) {
      const r = await scanOne(tag);
      if (!r) { await sleep(gapMs); continue; }
      if (!base) base = r;
      else if (r.reticle.source !== 'default') base.reticle = r.reticle;
      for (const e of r.enemies) {
        const key = `${Math.round(e.x / 0.02)}:${Math.round(e.y / 0.02)}`;
        if (marks.has(key)) continue;
        marks.add(key);
        all.push(e);
      }
      for (const m of r.marks) marks.add(`m${Math.round(m.x / 0.02)}:${Math.round(m.y / 0.02)}`);
      if (i < n - 1) await sleep(gapMs);
    }
    if (!base) return null;
    const rx = base.reticle.x, ry = base.reticle.y;
    for (const e of all) {
      e.errX = Math.round((e.x - rx) * 10000) / 10000;
      e.errY = Math.round((e.y - ry) * 10000) / 10000;
      e.dist = Math.round(((e.x - rx) ** 2 + (e.y - ry) ** 2) ** 0.5 * 10000) / 10000;
    }
    all.sort((a, b) => a.dist - b.dist);
    base.enemies = all;
    base.png = base.png;
    return base;
  };

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
  await evalJs(GEST);
  log('  ⚠ 进入战斗 ≠ 靶子已生成，轮询等第一个红标记出现…');

  log('');
  log('=== 阶段 1：等待靶子生成 ===');
  let s = null;
  for (let i = 0; i < 16; i++) {
    s = await scanUnion('v5', 3, 380);
    const n = s ? s.enemies.length : 0;
    log(`  t+${i * 2}s 红标记并集敌人 = ${n}  准星 (${s ? s.reticle.x : '?'}, ${s ? s.reticle.y : '?'})`);
    if (n > 0) break;
  }
  if (!s || !s.enemies.length) { log('  ✘ 始终没有红标记，放弃（靶子可能没生成）'); try { child.kill(); } catch (e) {} process.exit(3); }
  s.enemies.forEach((e, i) => log(`    #${i} (${e.x},${e.y}) err=(${e.errX},${e.errY}) dist=${e.dist} ${e.source} bodyPx=${e.bodyPx}`));

  let tgt = s.enemies[0];
  log(`  → 锁定 (${tgt.x}, ${tgt.y})`);

  let gx = 0.40, gy = 0.60;   // 横向实测 +0.40（指右拖→场景左移）；竖直符号由自检纠正
  let fires = 0, lastErr = null;

  for (let iter = 1; iter <= MAX_ITER; iter++) {
    const rx = s.reticle.x, ry = s.reticle.y;
    const ex = tgt.x - rx, ey = tgt.y - ry;
    const dist = Math.hypot(ex, ey);
    log('');
    log(`=== 迭代 ${iter}：误差 (${ex.toFixed(4)}, ${ey.toFixed(4)}) dist=${dist.toFixed(4)}  gx=${gx.toFixed(3)} gy=${gy.toFixed(3)}`);

    if (Math.abs(ex) < 0.012 && Math.abs(ey) < 0.016) {
      log('  ✔ 已对准，开火');
      await evalJs('window.__fire(0.5, 0.72, 420)');
      await sleep(700);
      await evalJs('window.__fire(0.5, 0.72, 420)');
      fires += 2;
      await sleep(3000);
      const s2 = await scanUnion('v5-fire', 3, 380);
      const near = s2 ? s2.enemies.filter((e) => Math.abs(e.x - tgt.x) < 0.045 && Math.abs(e.y - tgt.y) < 0.045) : [];
      log(`  开火后：敌人并集 ${s2 ? s2.enemies.length : '?'} 个，原位置附近还剩 ${near.length} 个`);
      log('  教程日志：' + (tutLog.slice(-2).join(' | ') || '(none)'));
      if (s2 && !near.length) {
        log('  ✔✔ 该敌人消失 —— 判定为击杀');
        if (!s2.enemies.length) { log('  ✔ 全部红标记消失'); s = s2; break; }
        s = s2; tgt = s2.enemies[0];
        log(`  → 下一个敌人 (${tgt.x}, ${tgt.y})`);
        lastErr = null;
        continue;
      }
      if (s2) { s = s2; tgt = near[0] || tgt; }
      log('  ✘ 敌人仍在，微调后继续');
      lastErr = null;
      continue;
    }

    let dx = ex / gx, dy = ey / gy;
    const cap = 0.14;
    if (Math.abs(dx) > cap) dx = Math.sign(dx) * cap;
    if (Math.abs(dy) > cap) dy = Math.sign(dy) * cap;
    const sx = Math.max(0.06, Math.min(0.94, 0.5 - dx / 2));
    const sy = Math.max(0.58, Math.min(0.80, 0.70 - dy / 2));
    log(`  拖动：起点 (${sx.toFixed(3)},${sy.toFixed(3)}) 位移 (${dx.toFixed(3)}, ${dy.toFixed(3)})`);

    const gRaw = await evalJs(`window.__gesture(${sx.toFixed(4)},${sy.toFixed(4)},${dx.toFixed(4)},${dy.toFixed(4)},22,45,300)`);
    let g = null; try { g = JSON.parse(gRaw); } catch (e) {}
    if (!g) log('  ⚠ 手势返回异常: ' + String(gRaw).slice(0, 160));
    await sleep(2400);

    const s1 = await scanUnion('v5', 3, 380);
    if (!s1) break;

    const adx = g ? g.actualDx : dx;
    const ady = g ? g.actualDy : dy;
    const predX = tgt.x - gx * adx, predY = tgt.y - gy * ady;

    // 身份追踪：只在红标记敌人里找，绝不退回隔离墩
    let best = null, bd = 0.09;
    for (const t of s1.enemies) {
      const d = Math.hypot(t.x - predX, t.y - predY);
      if (d < bd) { bd = d; best = t; }
    }
    if (!best) {
      log(`  ⚠ 预测 (${predX.toFixed(3)},${predY.toFixed(3)}) 附近无敌人（现有 ${s1.enemies.length} 个），取最近的`);
      best = s1.enemies[0] || null;
    }
    s = s1;
    if (!best) { log('  ✘ 敌人全部消失，结束'); break; }

    const shiftX = tgt.x - best.x, shiftY = tgt.y - best.y;
    // shiftX 定义是「旧位置 − 新位置」，而模型是 新位置 = 旧位置 − g·d，
    // 所以 g = (新−旧)/(−d) = shiftX/d。符号写错会让自校准越跑越偏（v5 踩过）。
    if (Math.abs(adx) > 0.03) {
      const gm = shiftX / adx;
      if (Math.abs(gm) > 0.12 && Math.abs(gm) < 2.0) { gx = gx * 0.35 + gm * 0.65; log(`  实测 gx=${gm.toFixed(3)} → ${gx.toFixed(3)}`); }
    }
    if (Math.abs(ady) > 0.03) {
      const gmy = shiftY / ady;
      if (Math.abs(gmy) > 0.12 && Math.abs(gmy) < 2.5) { gy = gy * 0.35 + gmy * 0.65; log(`  实测 gy=${gmy.toFixed(3)} → ${gy.toFixed(3)}`); }
    }
    const newErr = Math.hypot(best.x - s1.reticle.x, best.y - s1.reticle.y);
    log(`  目标 (${tgt.x},${tgt.y}) → (${best.x},${best.y})  新距离 ${newErr.toFixed(4)}  敌人 ${s1.enemies.length}`);
    if (lastErr !== null && newErr > lastErr * 1.25) {
      gx = -gx; gy = -gy;
      log(`  ↺ 距离变大（${lastErr.toFixed(4)} → ${newErr.toFixed(4)}），翻转增益符号 → gx=${gx.toFixed(3)} gy=${gy.toFixed(3)}`);
    }
    lastErr = newErr;
    tgt = best;
  }

  log('');
  log('=== 收尾 ===');
  await scanUnion('v5-final', 3, 380);
  log('  开火次数: ' + fires);
  log('  教程日志尾部: ' + (tutLog.slice(-3).join('  |  ') || '(none)'));

  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
