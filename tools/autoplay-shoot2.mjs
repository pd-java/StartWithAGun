/**
 * autoplay-shoot2.mjs —— 决定性实验：按住并释放是否就能击杀靶子
 *
 * 已确认的关键事实（这版全部据此重写）：
 *  1. 教程字幕原文是「按住并释放射击」——输入模型不是「快速点击」，而是 press → hold → release。
 *  2. 画布只能在 rAF 回调「之后」读；此前页面内检测器直接 drawImage 画布，读到全黑，
 *     所以一直返回 0 个候选。这版改为读取 rAF 后缓存的高分辨率帧。
 *  3. 教程卡在 WaitForHealthComponentsKilled(total=2)，用它做唯一的成功判据。
 *
 * 实验分三组，全部作用在同一个靶子上：
 *   A 快速点击（start+end 立即）      —— 对照组，预期无效
 *   B 按住 500ms 再释放
 *   C 按住 1200ms 再释放
 *
 * 用法: node tools/autoplay-shoot2.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const OUT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun/.workbuddy/probe-out';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9369;
const profile = mkdtempSync(join(tmpdir(), 'cdp-sh2-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1000,1000', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  'http://127.0.0.1:8848/robots.txt'
], { stdio: 'ignore' });
process.on('exit', () => { try { child.kill(); } catch (e) {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const NOISE = /ASTC6X6|decompressing texture|本地 bundle|Odin Serializer|report_fail|storage-probe|命中映射|dn-sdk|glCreateShader|SoftMask|referenced script|Shader |Convex Mesh|kinematic body|RectTransform is being set|memorysetup|RemoteConfig|DeserializedConfiguration|Time set to|cloud-store|CloudStorage|PLUGIN/i;

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
 * rAF 渲染后缓存一帧高分辨率像素，并在此帧上做深色目标检测。
 * ⚠️ 关键：drawImage 必须在 cb(t) 返回之后执行，否则读到的是已清空的缓冲。
 */
const HOOK = `
window.__hi = null;
(function () {
  if (window.__hiHooked) return; window.__hiHooked = true;
  var _raf = window.requestAnimationFrame.bind(window);
  var W = 400, H = 0;
  var b = document.createElement('canvas');
  var x = b.getContext('2d', { willReadFrequently: true });
  window.requestAnimationFrame = function (cb) {
    return _raf(function (t) {
      var r;
      try { r = cb(t); } catch (e) { r = undefined; }
      try {
        var c = document.querySelector('canvas');
        if (c && c.width > 1) {
          H = Math.max(1, Math.round(W * c.height / c.width));
          if (b.width !== W || b.height !== H) { b.width = W; b.height = H; }
          x.drawImage(c, 0, 0, W, H);
          window.__hi = { t: Math.round(performance.now()), w: W, h: H, data: x.getImageData(0, 0, W, H).data };
        }
      } catch (e) { /* ignore */ }
      return r;
    });
  };
})();

/**
 * 在缓存帧上找沙地里的深色小目标。
 * 沙地很亮(lum 200+)，靶子/人形 lum < 150，所以阈值取 150 足够稳。
 */
window.__find = function () {
  var F = window.__hi;
  if (!F) return { ok: false, reason: 'no-frame' };
  var W = F.w, H = F.h, d = F.data;
  var dark = new Uint8Array(W * H);
  var y0 = Math.floor(0.36 * H), y1 = Math.floor(0.62 * H);
  for (var y = y0; y < y1; y++) {
    for (var x = 0; x < W; x++) {
      var i = (y * W + x) * 4;
      var lum = d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114;
      if (lum < 150) dark[y * W + x] = 1;
    }
  }
  var seen = new Uint8Array(W * H), out = [];
  for (var p = y0 * W; p < y1 * W; p++) {
    if (!dark[p] || seen[p]) continue;
    var st = [p], n = 0, sx = 0, sy = 0, minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
    seen[p] = 1;
    while (st.length) {
      var q = st.pop(), qx = q % W, qy = (q / W) | 0;
      n++; sx += qx; sy += qy;
      if (qx < minx) minx = qx; if (qx > maxx) maxx = qx;
      if (qy < miny) miny = qy; if (qy > maxy) maxy = qy;
      var nb = [[1,0],[-1,0],[0,1],[0,-1]];
      for (var k = 0; k < 4; k++) {
        var ax = qx + nb[k][0], ay = qy + nb[k][1];
        if (ax < 0 || ay < 0 || ax >= W || ay >= H) continue;
        var ai = ay * W + ax;
        if (dark[ai] && !seen[ai]) { seen[ai] = 1; st.push(ai); }
      }
    }
    var ww = maxx - minx + 1, hh = maxy - miny + 1;
    if (n < 8 || n > 900) continue;
    if (ww > 60 || hh > 60) continue;
    out.push({
      x: Math.round((sx/n)/W*10000)/10000,
      y: Math.round((sy/n)/H*10000)/10000,
      n: n, w: ww, h: hh,
      ar: Math.round(hh / ww * 100) / 100
    });
  }
  out.sort(function (a, b) { return b.ar - a.ar; });
  return { ok: true, t: F.t, count: out.length, list: out };
}; 'ok'`;

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
      if (/TUTORIAL|Dialogue|MovingHand|RangeTargets|HealthComponents|GotoNextLevel|Level activated|Killed|kill/i.test(s)) {
        const line = `+${Math.round((Date.now() - t0c) / 1000)}s ${s.slice(0, 200)}`;
        tutLog.push(line);
        console.log('   [tut]', line);
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
  const find = async () => {
    const r = await evalJs('JSON.stringify(window.__find())');
    try { return JSON.parse(r); } catch (e) { return { ok: false, reason: String(r).slice(0, 120) }; }
  };

  await S('Page.navigate', { url: URL_ });
  await sleep(2500);
  await evalJs('document.getElementById("start-btn").click()');
  await evalJs(HOOK);

  log('等待进入战斗…');
  let entered = false;
  for (let i = 0; i < 80; i++) {
    await sleep(3000);
    const l = await evalJs('window.AutoplayPerception.observe().metrics.avgLuma');
    if (i % 5 === 0) log(`  t=${(i + 1) * 3}s luma=${l}`);
    if (l > 178) { entered = true; log(`  进入战斗 @ ${(i + 1) * 3}s`); break; }
    if (i % 2 === 0) await evalJs('window.__wxInjectTouch("start",0.5,0.5), window.__wxInjectTouch("end",0.5,0.5)');
  }
  if (!entered) { log('！！未进入战斗'); process.exit(2); }

  await evalJs('(function(){var b=document.getElementById("ap-fold"); if(b) b.click(); return 1})()');
  // 让教程序列进入「等待击杀」
  log('等待 25s，让教程走到 WaitForHealthComponentsKilled…');
  await sleep(25000);

  log('');
  log('=== 当前帧的目标检测 ===');
  const f0 = await find();
  log('  ' + JSON.stringify(f0).slice(0, 800));
  await shot('s2-before');

  if (!f0.ok || !f0.list || !f0.list.length) {
    log('！！检测不到目标，无法继续。先确认帧缓存是否有效：');
    log('  hi = ' + (await evalJs('window.__hi ? window.__hi.w + "x" + window.__hi.h : "null"')));
    try { child.kill(); } catch (e) {}
    process.exit(3);
  }

  // 选一个最像人形的目标（ar 最大且不太小）
  const target = f0.list[0];
  log(`  选中靶子: (${target.x}, ${target.y}) n=${target.n} wh=${target.w}x${target.h} ar=${target.ar}`);

  const pressRelease = async (holdMs) => {
    await evalJs(`(function(){
      var I = window.AutoplayInput;
      return new Promise(function(res){
        I.press(${target.x}, ${target.y});
        setTimeout(function(){ I.release(${target.x}, ${target.y}); res(true); }, ${holdMs});
      });
    })()`);
  };

  const cases = [
    { name: 'A-quick-tap', hold: 0, desc: '快速点击' },
    { name: 'B-hold500', hold: 500, desc: '按住 500ms' },
    { name: 'C-hold1200', hold: 1200, desc: '按住 1200ms' }
  ];

  for (const cs of cases) {
    log('');
    log(`--- ${cs.name}（${cs.desc}）@ (${target.x}, ${target.y}) ---`);
    await sleep(1800);
    const b4 = await find();
    await shot(`s2-${cs.name}-before`);
    await pressRelease(cs.hold);
    await sleep(1600);
    const af = await find();
    await shot(`s2-${cs.name}-after`);
    log(`  释放前目标数=${b4.count} 之后=${af.count}`);
    if (b4.ok && af.ok) {
      const still = (af.list || []).some((o) => Math.hypot(o.x - target.x, o.y - target.y) < 0.035);
      log(`  原位置目标: ${still ? '仍在' : '★已消失'}   luma=${await evalJs('window.AutoplayPerception.observe().metrics.avgLuma')}`);
    }
    log(`  教程日志新增: ${tutLog.length ? tutLog.slice(-2).join(' | ') : '无'}`);
  }

  log('');
  log('=== 收尾：保持按住 800ms 连打 6 次，看教程是否推进 ===');
  for (let i = 0; i < 6; i++) {
    const f = await find();
    if (f.ok && f.list && f.list.length) {
      const t2 = f.list[0];
      log(`  第 ${i + 1} 次 -> (${t2.x}, ${t2.y}) ar=${t2.ar} n=${t2.n}`);
      await evalJs(`(function(){
        var I = window.AutoplayInput;
        return new Promise(function(res){
          I.press(${t2.x}, ${t2.y});
          setTimeout(function(){ I.release(${t2.x}, ${t2.y}); res(true); }, 800);
        });
      })()`);
    } else {
      log(`  第 ${i + 1} 次 -> 没有目标了（可能打完了）`);
    }
    await sleep(2000);
  }
  await shot('s2-final');

  log('');
  log('=== 教程日志全文 ===');
  log(tutLog.join('\n') || '（无）');

  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
