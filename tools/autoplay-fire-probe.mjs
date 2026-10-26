/**
 * autoplay-fire-probe.mjs —— 判定「点一下屏幕是否=开火」
 *
 * 判据：开枪有枪口闪光 + 后坐力，画面平均亮度会在开火后 50~200ms 内出现尖峰。
 * 所以每次 tap 之后以 ~60ms 间隔连采 8 次 avgLuma，看是否出现明显尖峰。
 *
 * 对照组：
 *   - 点在画面中央（大概率空地）
 *   - 点在检测到的靶子上
 *   - 空转（不点）作为基线噪声
 *
 * 用法: node tools/autoplay-fire-probe.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const OUT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun/.workbuddy/probe-out';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9365;
const profile = mkdtempSync(join(tmpdir(), 'cdp-fire-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1000,1000', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  'http://127.0.0.1:8848/robots.txt'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const NOISE = /ASTC6X6|decompressing texture|本地 bundle|Odin Serializer|report_fail|storage-probe|命中映射|dn-sdk|glCreateShader|SoftMask|referenced script|Shader|Convex Mesh|kinematic body|RectTransform is being set/i;

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

/**
 * 帧序列采样钩子。
 *
 * ⚠️ 两条实测结论决定了它必须长这样：
 *  1. 本作 WebGL 未开 preserveDrawingBuffer，帧外读画布全是 0。
 *  2. 即使在 rAF 内，读在游戏渲染回调「之前」也全是 0 —— 上一帧的缓冲早已被清掉。
 *     只有「回调之后、同一 JS 任务内」读才拿得到真实像素。
 * 所以采样放在 cb(t) 返回之后，并带时间戳，事后按时间窗口找尖峰。
 */
const FRAME_SERIES = `
window.__frames = [];
(function () {
  if (window.__fsHooked) return; window.__fsHooked = true;
  var _raf = window.requestAnimationFrame.bind(window);
  var b = document.createElement('canvas'); b.width = 64; b.height = 64;
  var x = b.getContext('2d', { willReadFrequently: true });
  window.requestAnimationFrame = function (cb) {
    return _raf(function (t) {
      var r;
      try { r = cb(t); } catch (e) { r = undefined; }
      try {
        var c = document.querySelector('canvas');
        if (c && c.width > 1) {
          x.drawImage(c, 0, 0, 64, 64);
          var d = x.getImageData(0, 0, 64, 64).data, s = 0, h = 0;
          for (var i = 0; i < d.length; i += 4) {
            s += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
            h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) >>> 0;
          }
          window.__frames.push([Math.round(performance.now()), Math.round(s / (d.length / 4)), h]);
          if (window.__frames.length > 1500) window.__frames.shift();
        }
      } catch (e) { /* ignore */ }
      return r;
    });
  };
})(); 'ok'`;

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
    if (m.method === 'Runtime.consoleAPICalled') {
      const a = (m.params.args || []).map((x) => (x.value !== undefined ? x.value : x.description)).join(' ');
      const s = String(a || '');
      if (!s || NOISE.test(s)) return;
      log(`   [+${Math.round((Date.now() - t0c) / 1000)}s]`, s.slice(0, 180));
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
  /** 取最近 windowMs 内的帧序列，算亮度尖峰与帧间哈希变化 */
  const window_ = async (ms) => {
    const r = await evalJs(`(function(){
      var now = performance.now();
      return JSON.stringify(window.__frames.filter(function(f){ return now - f[0] <= ${ms}; }));
    })()`);
    try { return JSON.parse(r); } catch (e) { return []; }
  };
  const analyse = (frames) => {
    if (frames.length < 2) return { n: frames.length };
    const lumas = frames.map((f) => f[1]);
    const deltas = [];
    for (let i = 1; i < frames.length; i++) {
      deltas.push(frames[i][2] === frames[i - 1][2] ? 0 : 1);
    }
    return {
      n: frames.length,
      min: Math.min(...lumas),
      max: Math.max(...lumas),
      span: Math.max(...lumas) - Math.min(...lumas),
      changedFrames: deltas.reduce((a, b) => a + b, 0),
      first: lumas[0], last: lumas[lumas.length - 1]
    };
  };

  await S('Page.navigate', { url: URL_ });
  await sleep(2500);
  await evalJs('document.getElementById("start-btn").click()');

  log('等待进入战斗…');
  let entered = false;
  for (let i = 0; i < 80; i++) {
    await sleep(3000);
    const l = await evalJs('window.AutoplayPerception.observe().metrics.avgLuma');
    if (i % 5 === 0) log(`  t=${(i + 1) * 3}s luma=${l}`);
    if (l > 178) { entered = true; log(`  进入战斗 @ ${(i + 1) * 3}s`); break; }
    if (i % 2 === 0) await evalJs('window.__wxInjectTouch("start",0.5,0.5), window.__wxInjectTouch("end",0.5,0.5)');
  }
  if (!entered) { log('！！未进入战斗'); child.kill(); process.exit(2); }

  await evalJs(FRAME_SERIES);
  // 等加载收尾 + 教程序列进入等待击杀
  log('等待 20s 让教程序列走到「等待击杀」…');
  await sleep(4000);
  await evalJs('(function(){var b=document.getElementById("ap-fold"); if(b) b.click(); return 1})()');
  await sleep(16000);

  log('');
  log('=== 基线（不输入，纯噪声）===');
  {
    const f = await window_(3000);
    log('  ' + JSON.stringify(analyse(f)));
  }

  await shot('fire-before');

  const cases = [
    { name: '点中央 0.50,0.50', x: 0.5, y: 0.5 },
    { name: '点上方空地 0.50,0.30', x: 0.5, y: 0.30 },
    { name: '点沙地中部 0.42,0.52', x: 0.42, y: 0.52 },
    { name: '点中央再点 0.50,0.50', x: 0.5, y: 0.5 }
  ];

  for (const cs of cases) {
    log('');
    log(`=== ${cs.name} ===`);
    await evalJs('window.__frames.length = 0');
    await sleep(700);
    await evalJs(`window.__wxInjectTouch("start",${cs.x},${cs.y}), window.__wxInjectTouch("end",${cs.x},${cs.y})`);
    await sleep(1400);
    const f = await window_(2500);
    const a = analyse(f);
    log('  开火前后 2.5s 帧序列: ' + JSON.stringify(a));
    log('  明细: ' + JSON.stringify(f.map((x) => [x[1]]).flat()));
    await shot('fire-' + cs.name.replace(/[^\w]/g, '_'));
    await sleep(1200);
  }

  log('');
  log('=== 结束状态 ===');
  log(await evalJs('JSON.stringify({state:window.Autoplay.state, scene: window.AutoplayPerception.observe().scene, luma: window.AutoplayPerception.observe().metrics.avgLuma})'));
  await shot('fire-final');

  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
