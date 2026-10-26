/**
 * autoplay-shoot-test.mjs —— 决定性实验：到底怎么开枪
 *
 * 已知（来自 IL2CPP 元数据）：
 *   FPSPlayerController: TouchPosition / ObjectUnderPointer / IsPointerOverUI /
 *                        AllowAimingCheck / TryAimAtInitialTutorialTarget /
 *                        SetAimingDirection / ClampAimingDirection / Shoot
 *   PlayerController:    InputBlocked / SetInputBlock   ← 教程期间输入被屏蔽
 *   教程序列事件:        WaitForHealthComponentsKilledSequenceEvent total=2
 *
 * 本脚本做两件事：
 *   1. 在页面内用高分辨率（320 宽）找出沙地上的小深色块，逐个 tap，
 *      每次都重新检测「这个块还在不在」——消失即判定命中。
 *   2. 记录全程游戏日志，看教程序列事件是否推进。
 *
 * 用法: node tools/autoplay-shoot-test.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const OUT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun/.workbuddy/probe-out';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9363;
const profile = mkdtempSync(join(tmpdir(), 'cdp-shoot-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1000,1000', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  'http://127.0.0.1:8848/robots.txt'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const NOISE = /ASTC6X6|decompressing texture|本地 bundle|Odin Serializer|report_fail|storage-probe|命中映射|dn-sdk|GameSessionTimeReporter/i;

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

/** 注入页面的高分辨率检测器（不改动 perception.js，仅测试用） */
const DETECTOR = `
window.__cand = function () {
  var c = document.querySelector('canvas');
  if (!c || !c.width) return [];
  var W = 320, H = Math.max(1, Math.round(W * c.height / c.width));
  var b = window.__candBuf || (window.__candBuf = document.createElement('canvas'));
  if (b.width !== W || b.height !== H) { b.width = W; b.height = H; }
  var x2 = b.getContext('2d', { willReadFrequently: true });
  x2.drawImage(c, 0, 0, W, H);
  var d = x2.getImageData(0, 0, W, H).data;
  var dark = new Uint8Array(W * H);
  for (var i = 0; i < W * H; i++) {
    var r = d[i*4], g = d[i*4+1], bl = d[i*4+2];
    var lum = r*0.299 + g*0.587 + bl*0.114;
    var ny = (i / W) | 0;
    if (ny / H < 0.34 || ny / H > 0.64) continue;         // 只看沙地
    if (lum < 108) dark[i] = 1;
  }
  var seen = new Uint8Array(W * H), out = [];
  for (var p = 0; p < W * H; p++) {
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
    if (n < 18 || n > 2000) continue;
    if (ww > 60 || hh > 70) continue;
    out.push({ x: (sx/n)/W, y: (sy/n)/H, n: n, w: ww, h: hh, ar: Math.round(hh/ww*100)/100 });
  }
  out.sort(function (a, b) { return b.ar - a.ar; });   // 越"竖"越像站立的敌人
  return out;
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
  const glog = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      const a = (m.params.args || []).map((x) => (x.value !== undefined ? x.value : x.description)).join(' ');
      const s = String(a || '');
      if (!s || NOISE.test(s)) return;
      const line = `+${Math.round((Date.now() - t0c) / 1000)}s ${s.slice(0, 200)}`;
      glog.push(line);
      console.log('   [game]', line);
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
  const cands = async () => {
    const r = await evalJs('JSON.stringify(window.__cand())');
    try { return JSON.parse(r); } catch (e) { return []; }
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

  await evalJs(DETECTOR);
  // 给教程对话/序列留时间，并让输入解除屏蔽
  log('等待 12s（教程对话 + 输入解屏蔽）…');
  await sleep(12000);
  await evalJs('(function(){var b=document.getElementById("ap-fold"); if(b) b.click(); return 1})()');

  for (let round = 0; round < 5; round++) {
    const list = await cands();
    log('');
    log(`=== 第 ${round + 1} 轮：候选 ${list.length} 个 ===`);
    if (!list.length) { log('  无候选'); break; }
    log('  ' + list.slice(0, 8).map((t, i) => `k${i}(${t.x.toFixed(3)},${t.y.toFixed(3)} n=${t.n} ar=${t.ar})`).join(' '));
    await shot(`shoot-r${round}-before`);

    let killed = 0;
    for (let i = 0; i < Math.min(list.length, 6); i++) {
      const t = list[i];
      glog.length = 0;
      await evalJs(`window.__wxInjectTouch("start",${t.x},${t.y}), window.__wxInjectTouch("end",${t.x},${t.y})`);
      await sleep(1100);
      const after = await cands();
      // 该位置附近是否还有目标
      const still = after.some((o) => Math.hypot(o.x - t.x, o.y - t.y) < 0.03 && Math.abs(o.n - t.n) < t.n * 0.9);
      const mark = still ? '还在' : '★消失';
      log(`  tap k${i} (${t.x.toFixed(3)},${t.y.toFixed(3)}) n=${t.n} ar=${t.ar} -> ${mark}`);
      if (!still) { killed++; await shot(`shoot-r${round}-killed-${i}`); }
      if (glog.length) log('     log: ' + glog.join(' | ').slice(0, 300));
    }
    log(`  本轮判定消失 ${killed} 个`);
    if (killed) { await shot(`shoot-r${round}-after`); }
  }

  await shot('shoot-final');
  log('');
  log('=== 最后日志 ===');
  log(glog.slice(-10).join('\n') || '（无）');

  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
