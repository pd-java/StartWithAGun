/**
 * autoplay-aim-fire.mjs —— 闭环瞄准 + 释放开火（基于刚确认的输入模型）
 *
 * 已用山脊横移证明：拖动会转动视角（基线 dx=0，全宽拖动 dx=-111px/400）。
 * 所以正确操作不是「按在靶子坐标上」，而是：
 *     拖动把靶子移到中央准星 → 按住 → 释放开火
 *
 * 闭环控制：
 *   err = 靶子位置 - 准星位置
 *   每次拖动 (-err.x * K, -err.y * K)，直到 |err| 足够小（K 靠迭代自校正，不依赖精确增益）
 *   对准后 press → hold → release
 *
 * 判据：
 *   靶子包围盒平均亮度从 ~40-80 升到 150+ 且连续两轮保持 ⇒ 击杀；
 *   教程日志离开 total=2 ⇒ 教程推进（终极成功判据）
 *
 * 用法: node tools/autoplay-aim-fire.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const OUT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun/.workbuddy/probe-out';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9379;
const profile = mkdtempSync(join(tmpdir(), 'cdp-aim-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1000,1000', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  'http://127.0.0.1:8848/robots.txt'
], { stdio: 'ignore' });
process.on('exit', () => { try { child.kill(); } catch (e) {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const NOISE = /ASTC6X6|decompressing texture|本地 bundle|Odin Serializer|report_fail|storage-probe|命中映射|dn-sdk|glCreateShader|SoftMask|referenced script|Shader |Convex Mesh|kinematic body|RectTransform is being set|memorysetup|RemoteConfig|DeserializedConfiguration|Time set to|cloud-store|CloudStorage|PLUGIN|GameSessionTimeReporter/i;

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

const HOOK = `
window.__hi = null;
(function () {
  if (window.__hiHooked) return; window.__hiHooked = true;
  var _raf = window.requestAnimationFrame.bind(window);
  var W = 400, H = 0, b = document.createElement('canvas');
  var x = b.getContext('2d', { willReadFrequently: true });
  window.requestAnimationFrame = function (cb) {
    return _raf(function (t) {
      var r; try { r = cb(t); } catch (e) { r = undefined; }
      try {
        var c = document.querySelector('canvas');
        if (c && c.width > 1) {
          H = Math.max(1, Math.round(W * c.height / c.width));
          if (b.width !== W || b.height !== H) { b.width = W; b.height = H; }
          x.drawImage(c, 0, 0, W, H);
          window.__hi = { t: Math.round(performance.now()), w: W, h: H, data: x.getImageData(0, 0, W, H).data };
        }
      } catch (e) {}
      return r;
    });
  };
})();

/**
 * 找沙地里最暗的紧凑块，视为靶子。
 * 靶子 lum≈42，沙地≈200，对比度极大，用最暗点法比任何形状规则都稳。
 */
window.__target = function () {
  var F = window.__hi; if (!F) return null;
  var W = F.w, H = F.h, d = F.data;
  var y0 = Math.floor(0.38*H), y1 = Math.floor(0.64*H);
  var x0 = Math.floor(0.10*W), x1 = Math.floor(0.90*W);
  var best = 1e9, bx = -1, by = -1;
  for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) {
    var i = (y*W+x)*4;
    var lum = d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114;
    if (lum < best) { best = lum; bx = x; by = y; }
  }
  if (bx < 0 || best > 130) return { found: false, lum: Math.round(best) };
  return { found: true, x: Math.round(bx/W*10000)/10000, y: Math.round(by/H*10000)/10000, lum: Math.round(best) };
};

/** 归一化方框内的平均亮度（判断靶子是否消失） */
window.__boxLuma = function (cx, cy, rad) {
  var F = window.__hi; if (!F) return -1;
  var W = F.w, H = F.h, d = F.data;
  var xa = Math.max(0, Math.floor((cx-rad)*W)), xb = Math.min(W, Math.ceil((cx+rad)*W));
  var ya = Math.max(0, Math.floor((cy-rad)*H)), yb = Math.min(H, Math.ceil((cy+rad)*H));
  var s = 0, n = 0;
  for (var y = ya; y < yb; y++) for (var x = xa; x < xb; x++) {
    var i = (y*W+x)*4;
    s += d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114; n++;
  }
  return n ? Math.round(s/n) : -1;
};
'ok'`;

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
      if (/TUTORIAL_SEQUENCE|HealthComponents|GotoNextLevel|Level activated/i.test(s)) {
        const line = `+${Math.round((Date.now() - t0c) / 1000)}s ${s.slice(0, 180)}`;
        tutLog.push(line); console.log('   [tut]', line);
      }
    }
  });

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 60000 });
    if (r.exceptionDetails) return { __err: String((r.exceptionDetails.exception || {}).description || '').slice(0, 250) };
    return r.result.value;
  };
  const shot = async (name) => {
    const sh = await S('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, name + '.png'), Buffer.from(sh.data, 'base64'));
  };
  const target = async () => {
    const r = await evalJs('JSON.stringify(window.__target())');
    try { return JSON.parse(r); } catch (e) { return null; }
  };
  const boxLuma = async (x, y) => Number(await evalJs(`window.__boxLuma(${x}, ${y}, 0.022)`));

  // 准星位置：实测固定在画面中央略偏上
  const CX = 0.497, CY = 0.487;

  /** 拖动：dx/dy 为归一化位移（正=向右/向下），分段 move 以贴近真实手指 */
  const drag = async (dx, dy, ms) => {
    const steps = Math.max(6, Math.round(ms / 40));
    await evalJs(`(function(){
      var I = window.AutoplayInput;
      return new Promise(function(res){
        var x0 = 0.5, y0 = 0.5;
        I.press(x0, y0);
        var n = 0;
        var iv = setInterval(function(){
          n++;
          I.moveTo(x0 + (${dx}) * (n/${steps}), y0 + (${dy}) * (n/${steps}));
          if (n >= ${steps}) { clearInterval(iv); I.release(x0 + (${dx}), y0 + (${dy})); res(true); }
        }, 40);
      });
    })()`);
  };

  const fire = (holdMs) => evalJs(`(function(){
    var I = window.AutoplayInput;
    return new Promise(function(res){ I.press(${CX}, ${CY}); setTimeout(function(){ I.release(${CX}, ${CY}); res(true); }, ${holdMs}); });
  })()`);

  await S('Page.navigate', { url: URL_ });
  await sleep(2500);
  await evalJs('document.getElementById("start-btn").click()');
  await evalJs(HOOK);

  log('等待进入战斗…');
  for (let i = 0; i < 80; i++) {
    await sleep(3000);
    const l = await evalJs('window.AutoplayPerception.observe().metrics.avgLuma');
    if (i % 5 === 0) log(`  t=${(i + 1) * 3}s luma=${l}`);
    if (l > 178) { log(`  进入战斗 @ ${(i + 1) * 3}s`); break; }
    if (i % 2 === 0) await evalJs('window.__wxInjectTouch("start",0.5,0.5), window.__wxInjectTouch("end",0.5,0.5)');
  }
  await evalJs('(function(){var b=document.getElementById("ap-fold"); if(b) b.click(); return 1})()');
  log('等待 18s 让教程进入等待击杀…');
  await sleep(18000);
  await shot('aim-00-base');

  // 场景位移/拖动位移 ≈ 0.396（山脊实测 111px/400 / 0.70 拖动），取其倒数作为初始增益
  let K = 2.4;

  for (let round = 0; round < 4; round++) {
    log('');
    log(`########## 第 ${round + 1} 个靶子 ##########`);

    // ── 闭环对准 ──
    let t = await target();
    log('  初始靶子: ' + JSON.stringify(t));
    if (!t || !t.found) { log('  没有可打的靶子，结束'); break; }

    let aimed = false;
    for (let step = 0; step < 7; step++) {
      t = await target();
      if (!t || !t.found) break;
      const ex = t.x - CX, ey = t.y - CY;
      log(`   step${step}: 靶子=(${t.x},${t.y}) 误差=(${ex.toFixed(3)},${ey.toFixed(3)}) K=${K.toFixed(2)}`);
      if (Math.abs(ex) < 0.018 && Math.abs(ey) < 0.022) { aimed = true; log('   ✔ 已对准准星'); break; }
      let dx = -ex * K, dy = -ey * K;
      // 限制单次拖动幅度，避免甩过头
      const cap = 0.34;
      if (Math.abs(dx) > cap) dx = Math.sign(dx) * cap;
      if (Math.abs(dy) > cap) dy = Math.sign(dy) * cap;
      // 注意：拖动让画面反向平移，故取负号（实测向右拖 → 山脊左移）
      await drag(dx, dy, 500);
      await sleep(700);
      const t2 = await target();
      if (t2 && t2.found && t) {
        // 用一次实际结果自校正增益
        const moved = Math.abs(t2.x - t.x);
        if (moved > 0.01 && Math.abs(dx) > 0.02) {
          const gain = moved / Math.abs(dx);
          if (gain > 0.05 && gain < 3) K = Math.min(6, Math.max(0.6, 1 / gain));
        }
      }
    }

    if (!aimed) log('   ⚠ 未能在 7 步内对准，仍然尝试开火');

    // ── 开火 ──
    const aimPos = await target();
    if (!aimPos || !aimPos.found) { log('  靶子已消失（可能在瞄准途中被清掉）'); continue; }
    const bx = aimPos.x, by = aimPos.y;
    const before = await boxLuma(bx, by);
    log(`   开火前 靶点亮度=${before} lum=${aimPos.lum}`);
    await shot(`aim-r${round}-before`);

    await fire(600);
    await sleep(1500);
    const after1 = await boxLuma(bx, by);
    log(`   开火后 靶点亮度=${after1}  (Δ=${after1 - before})`);
    await shot(`aim-r${round}-after`);

    if (after1 - before > 60) {
      log('   ★★ 靶点明显变亮 —— 靶子被打掉');
    } else {
      // 再补两枪
      for (let k = 0; k < 2; k++) {
        await fire(600);
        await sleep(1200);
      }
      const after2 = await boxLuma(bx, by);
      log(`   补两枪后 靶点亮度=${after2}  (Δ=${after2 - before})`);
      if (after2 - before > 60) log('   ★★ 补枪后靶子消失');
    }
    log('   教程日志: ' + (tutLog.slice(-2).join(' | ') || '(none)'));

    // 若已推进则停
    if (tutLog.length && !/total=2/.test(tutLog[tutLog.length - 1])) {
      log('   ★★★ 教程已推进，停止实验');
      break;
    }
  }

  log('');
  log('=== 教程日志全文 ===');
  log(tutLog.join('\n') || '(none)');
  await shot('aim-final');

  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
