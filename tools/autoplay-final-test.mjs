/**
 * autoplay-final-test.mjs —— 一次跑完所有交互假设
 *
 * 已证实：
 *   - __wxInjectTouch 能把触摸送进游戏（点齿轮弹出了设置面板，全局视觉变化 97%）
 *   - 教程字幕写的是「按住并释放射击」
 *   - 教程卡在 WaitForHealthComponentsKilled(total=2)
 *
 * 所以只剩一个问题：到底怎么按，才能打掉这两个靶子。
 *
 * 本脚本顺序执行 5 组假设，每组都以「教程是否推进 / 靶子是否消失」判定：
 *   H1 点中央一次（对照）
 *   H2 按住中央 600ms 再释放 ×5
 *   H3 按住靶子 600ms 再释放 ×5
 *   H4 先把靶子拖到准星再按住释放 ×5
 *   H5 在靶子上左右拖动（模拟瞄准）后按住释放 ×5
 *
 * 靶子检测：rAF 后缓存 400 宽帧，沙地区域 lum<150，按面积降序（不再按长宽比，
 * 之前按 ar 排序会把混凝土墩的竖边当靶子，已实测踩坑）。
 *
 * 用法: node tools/autoplay-final-test.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const OUT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun/.workbuddy/probe-out';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9373;
const profile = mkdtempSync(join(tmpdir(), 'cdp-fin-'));
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

/** 沙地深色目标：按面积降序，限定画面中部与合理尺寸 */
window.__find = function () {
  var F = window.__hi;
  if (!F) return { ok: false };
  var W = F.w, H = F.h, d = F.data;
  var y0 = Math.floor(0.36*H), y1 = Math.floor(0.62*H);
  var x0 = Math.floor(0.10*W), x1 = Math.floor(0.90*W);
  var dark = new Uint8Array(W*H);
  for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) {
    var i = (y*W+x)*4;
    var lum = d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114;
    if (lum < 150) dark[y*W+x] = 1;
  }
  var seen = new Uint8Array(W*H), out = [];
  for (var p = y0*W; p < y1*W; p++) {
    if (!dark[p] || seen[p]) continue;
    var st=[p], n=0, sx=0, sy=0, mnx=1e9, mxx=-1, mny=1e9, mxy=-1;
    seen[p]=1;
    while (st.length) {
      var q = st.pop(), qx = q % W, qy = (q/W)|0;
      n++; sx+=qx; sy+=qy;
      if (qx<mnx) mnx=qx; if (qx>mxx) mxx=qx;
      if (qy<mny) mny=qy; if (qy>mxy) mxy=qy;
      var nb=[[1,0],[-1,0],[0,1],[0,-1]];
      for (var k=0;k<4;k++){
        var ax=qx+nb[k][0], ay=qy+nb[k][1];
        if (ax<0||ay<0||ax>=W||ay>=H) continue;
        var ai=ay*W+ax;
        if (dark[ai] && !seen[ai]) { seen[ai]=1; st.push(ai); }
      }
    }
    var ww=mxx-mnx+1, hh=mxy-mny+1;
    if (n < 12 || n > 900) continue;
    if (ww < 3 || hh < 4) continue;
    if (ww > 55 || hh > 55) continue;
    var ar = hh/ww;
    if (ar < 0.45 || ar > 4.0) continue;
    out.push({ x: Math.round((sx/n)/W*10000)/10000, y: Math.round((sy/n)/H*10000)/10000, n: n, w: ww, h: hh, ar: Math.round(ar*100)/100 });
  }
  out.sort(function (a,b) { return b.n - a.n; });
  return { ok: true, count: out.length, list: out.slice(0, 12) };
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
      if (/TUTORIAL|Dialogue|MovingHand|RangeTargets|HealthComponents|GotoNextLevel|Level activated/i.test(s)) {
        const line = `+${Math.round((Date.now() - t0c) / 1000)}s ${s.slice(0, 190)}`;
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
    try { return JSON.parse(r); } catch (e) { return { ok: false }; }
  };
  const tap = (x, y) => evalJs(`window.__wxInjectTouch("start",${x},${y}), window.__wxInjectTouch("end",${x},${y})`);
  const holdRel = (x, y, ms) => evalJs(`(function(){
    var I = window.AutoplayInput;
    return new Promise(function(res){ I.press(${x},${y}); setTimeout(function(){ I.release(${x},${y}); res(true); }, ${ms}); });
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
  log('等待 20s 让教程进入等待击杀…');
  await sleep(20000);

  const first = await find();
  log('');
  log('目标检测: ' + JSON.stringify(first).slice(0, 700));
  await shot('fin-00-base');
  const tgt = (first.ok && first.list && first.list.length) ? first.list[0] : { x: 0.5, y: 0.5, n: 0 };
  log('主目标: ' + JSON.stringify(tgt));

  const report = [];
  const progress = async (label) => {
    const f = await find();
    const tut = tutLog.length ? tutLog[tutLog.length - 1] : '(none)';
    const line = `${label}: targets=${f.ok ? f.count : '?'} luma=${await evalJs('window.AutoplayPerception.observe().metrics.avgLuma')} lastTut=${tut}`;
    log('  ' + line);
    report.push(line);
    return f;
  };

  // H1
  log('');
  log('=== H1 点中央一次 ===');
  await tap(0.5, 0.5);
  await sleep(1600);
  await report('H1');
  await shot('fin-H1');

  // H2
  log('');
  log('=== H2 按住中央 600ms 释放 ×5 ===');
  for (let i = 0; i < 5; i++) { await holdRel(0.5, 0.5, 600); await sleep(1500); }
  await report('H2');
  await shot('fin-H2');

  // H3
  log('');
  log(`=== H3 按住目标 (${tgt.x},${tgt.y}) 600ms 释放 ×5 ===`);
  for (let i = 0; i < 5; i++) { await holdRel(tgt.x, tgt.y, 600); await sleep(1500); }
  await report('H3');
  await shot('fin-H3');

  // H4 拖到准星再按住释放
  log('');
  log('=== H4 把目标拖到准星后按住释放 ×5 ===');
  for (let i = 0; i < 5; i++) {
    const f = await find();
    const t = (f.ok && f.list && f.list.length) ? f.list[0] : null;
    if (t) {
      await evalJs(`(function(){
        var I = window.AutoplayInput;
        return new Promise(function(res){
          I.press(${t.x}, ${t.y});
          var n = 0, steps = 10;
          var iv = setInterval(function(){
            n++;
            I.moveTo(${t.x} + (${0.49} - ${t.x}) * (n/steps), ${t.y} + (${0.485} - ${t.y}) * (n/steps));
            if (n >= steps) { clearInterval(iv); I.release(0.49, 0.485); res(true); }
          }, 45);
        });
      })()`);
    } else { await holdRel(0.49, 0.485, 600); }
    await sleep(1500);
  }
  await report('H4');
  await shot('fin-H4');

  // H5 在目标上左右拖动后释放
  log('');
  log('=== H5 目标上左右轻拖后按住释放 ×5 ===');
  for (let i = 0; i < 5; i++) {
    const f = await find();
    const t = (f.ok && f.list && f.list.length) ? f.list[0] : { x: 0.5, y: 0.5 };
    await evalJs(`(function(){
      var I = window.AutoplayInput;
      return new Promise(function(res){
        I.press(${t.x}, ${t.y});
        var n = 0;
        var iv = setInterval(function(){
          n++;
          I.moveTo(${t.x} + 0.01 * Math.sin(n), ${t.y});
          if (n >= 8) { clearInterval(iv); I.release(${t.x}, ${t.y}); res(true); }
        }, 60);
      });
    })()`);
    await sleep(1500);
  }
  await report('H5');
  await shot('fin-H5');

  log('');
  log('=== 汇总 ===');
  log(report.join('\n'));
  log('');
  log('=== 教程日志 ===');
  log(tutLog.join('\n') || '(none)');

  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
