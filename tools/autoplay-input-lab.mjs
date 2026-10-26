/**
 * autoplay-input-lab.mjs —— 输入模型对照实验
 *
 * 目的：确定本作的操作方式到底是哪一种
 *   A. 点哪打哪（tap 到目标坐标即命中）
 *   B. 拖动瞄准 + 点击开火（准星固定在屏幕中心）
 *   C. 有独立开火按钮
 *
 * 做法：等到真正进入战斗画面（avgLuma 从 160 跳到 200+），依次执行三种输入，
 * 每步截图 + 记录感知指标 + 记录期间游戏自身打印的日志。
 *
 * 用法: node tools/autoplay-input-lab.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const OUT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun/.workbuddy/probe-out';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9359;
const profile = mkdtempSync(join(tmpdir(), 'cdp-lab-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=900,900', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  'http://127.0.0.1:8848/robots.txt'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

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

const NOISE = /ASTC6X6|decompressing texture|本地 bundle|Odin Serializer|report_fail|storage-probe|\[SI\]/i;

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

  let logOn = false;
  const gameLogs = [];
  const t0c = Date.now();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      const a = (m.params.args || []).map((x) => (x.value !== undefined ? x.value : x.description)).join(' ');
      const s = String(a || '');
      if (!s || NOISE.test(s)) return;
      if (logOn) {
        const line = `+${Math.round((Date.now() - t0c) / 1000)}s ${s.slice(0, 240)}`;
        gameLogs.push(line);
        console.log('   [game]', line);
      }
    }
  });

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 60000 });
    if (r.exceptionDetails) return { __err: String((r.exceptionDetails.exception || {}).description || '').slice(0, 250) };
    return r.result.value;
  };
  const snap = async (name) => {
    const sh = await S('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, name + '.png'), Buffer.from(sh.data, 'base64'));
    return sh.data.length;
  };
  const metrics = () => evalJs(`JSON.stringify({
    luma: window.AutoplayPerception.observe().metrics.avgLuma,
    red: window.AutoplayPerception.observe().metrics.redCount,
    dark: window.AutoplayPerception.observe().metrics.darkCount,
    scene: window.AutoplayPerception.observe().scene,
    targets: window.AutoplayPerception.observe().targets
  })`);

  await S('Page.navigate', { url: URL_ });
  await sleep(2500);
  await evalJs('document.getElementById("start-btn").click()');

  // 不启动自动玩，手动推进到战斗，避免自动点击干扰实验
  // 判定「已进入战斗」：加载页 avgLuma 恒为 160，靶场地形一亮就 185~205。
  // 阈值必须留余量，实测同一版本不同次跑会出现 189。
  const GAMEPLAY_LUMA = 178;
  log(`等待进入战斗（avgLuma > ${GAMEPLAY_LUMA}）…`);
  let entered = false;
  for (let i = 0; i < 90; i++) {
    await sleep(3000);
    const st = await evalJs('window.AutoplayPerception.observe().metrics.avgLuma');
    if (i % 5 === 0) log(`  t=${(i + 1) * 3}s luma=${st}`);
    if (st > GAMEPLAY_LUMA) { entered = true; log(`  进入战斗 @ t=${(i + 1) * 3}s luma=${st}`); break; }
    // 每 6s 点一下中央推进加载/教程
    if (i % 2 === 0) await evalJs('window.__wxInjectTouch("start",0.5,0.5), window.__wxInjectTouch("end",0.5,0.5)');
  }
  if (!entered) { log('！！未能进入战斗，退出'); try { child.close ? 0 : 0; } catch (e) {} child.kill(); process.exit(2); }

  await sleep(1500);
  logOn = true;
  log('');
  log('=== 基线 ===');
  log(await metrics());
  await snap('lab-00-base');

  // ── 实验 A：点在检测到的目标上 ───────────────────────────────
  log('');
  log('=== 实验 A：tap 在目标坐标上 ===');
  const beforeA = await metrics();
  const tgts = JSON.parse(beforeA).targets.sort((a, b) => b.size - a.size);
  const tgt = tgts[0];
  log('  目标:', JSON.stringify(tgt));
  gameLogs.length = 0;
  await evalJs(`window.__wxInjectTouch("start",${tgt.x},${tgt.y}), window.__wxInjectTouch("end",${tgt.x},${tgt.y})`);
  await sleep(1500);
  await snap('lab-A-after-tap-target');
  log('  之后:', await metrics());

  // ── 实验 B：拖动改变视角 ────────────────────────────────────
  log('');
  log('=== 实验 B：从中心拖到右侧（是否转动视角）===');
  gameLogs.length = 0;
  await evalJs(`(function(){
    var I = window.AutoplayInput;
    I.press(0.5, 0.45);
    var n = 0, steps = 12;
    return new Promise(function(res){
      var iv = setInterval(function(){
        n++;
        I.moveTo(0.5 + 0.15 * (n / steps), 0.45);
        if (n >= steps) { clearInterval(iv); I.release(0.5 + 0.15, 0.45); res(true); }
      }, 40);
    });
  })()`);
  await sleep(1500);
  await snap('lab-B-after-drag');
  log('  之后:', await metrics());

  // ── 实验 C：点屏幕中央 ──────────────────────────────────────
  log('');
  log('=== 实验 C：tap 在屏幕中央 ===');
  gameLogs.length = 0;
  await evalJs('window.__wxInjectTouch("start",0.5,0.5), window.__wxInjectTouch("end",0.5,0.5)');
  await sleep(1500);
  await snap('lab-C-after-tap-center');
  log('  之后:', await metrics());

  // ── 实验 D：长按 + 释放 ─────────────────────────────────────
  log('');
  log('=== 实验 D：长按 400ms 后释放（是否有蓄力/开镜）===');
  gameLogs.length = 0;
  await evalJs(`(function(){
    var I = window.AutoplayInput;
    I.press(0.5, 0.45);
    return new Promise(function(res){ setTimeout(function(){ I.release(0.5, 0.45); res(true); }, 400); });
  })()`);
  await sleep(1500);
  await snap('lab-D-after-longpress');
  log('  之后:', await metrics());

  log('');
  log('=== 各实验期间的游戏日志 ===');
  log(gameLogs.length ? gameLogs.join('\n') : '（无）');

  log('');
  log('=== 最终状态 ===');
  log(await evalJs('JSON.stringify({state:window.Autoplay.state, strat: window.AutoplayStrategy ? window.AutoplayStrategy.inspect() : null})'));

  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
