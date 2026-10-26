/**
 * autoplay-shot.mjs —— 定时截图 + 目标统计，用来肉眼确认"自动玩到底卡在哪个画面"
 *
 * 用法: node tools/autoplay-shot.mjs [url] [截图时间点秒,逗号分隔]
 * 输出: .workbuddy/probe-out/shot-<秒>.png  + 控制台目标明细
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const TIMES = (process.argv[3] || '8,20,35,55,80').split(',').map(Number);
const OUT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun/.workbuddy/probe-out';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9357;
const profile = mkdtempSync(join(tmpdir(), 'cdp-shot-'));
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

  const errs = [];
  const NOISE = /ASTC6X6|decompressing texture|Downloading|UnityWebRequest/i;
  const t0c = Date.now();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      errs.push(String((m.params.exceptionDetails.exception || {}).description || '').slice(0, 200));
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      const a = (m.params.args || []).map((x) => (x.value !== undefined ? x.value : x.description)).join(' ');
      const s = String(a || '');
      if (!s || NOISE.test(s)) return;
      console.log(`   [console +${Math.round((Date.now() - t0c) / 1000)}s]`, s.slice(0, 260));
    }
  });

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 60000 });
    if (r.exceptionDetails) return { __err: String((r.exceptionDetails.exception || {}).description || '').slice(0, 250) };
    return r.result.value;
  };

  await S('Page.navigate', { url: URL_ });
  await sleep(2500);
  await evalJs('document.getElementById("start-btn").click()');
  log('已点开始，启动自动玩');
  await sleep(800);
  log('start ->', await evalJs('window.Autoplay.start().then(function(v){return v})'));

  const t0 = Date.now();
  for (const sec of TIMES) {
    const wait = sec * 1000 - (Date.now() - t0);
    if (wait > 0) await sleep(wait);

    const st = await evalJs(`JSON.stringify({
      state: window.Autoplay.state,
      scene: window.AutoplayPerception.observe().scene,
      luma: window.AutoplayPerception.observe().metrics.avgLuma,
      red: window.AutoplayPerception.observe().metrics.redCount,
      dark: window.AutoplayPerception.observe().metrics.darkCount,
      changeRate: window.AutoplayPerception.observe().metrics.changeRate,
      targets: window.AutoplayPerception.observe().targets,
      shots: window.Autoplay.stats.shots,
      taps: window.Autoplay.stats.taps,
      strat: window.AutoplayStrategy.inspect()
    })`);
    log('');
    log(`=== t=${sec}s ===`);
    log(st);
    const sh = await S('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `shot-${sec}.png`), Buffer.from(sh.data, 'base64'));
    log(`  已存 shot-${sec}.png`);
    if (errs.length) { log('   ! ' + errs.slice(-2).join(' | ')); errs.length = 0; }
  }

  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
