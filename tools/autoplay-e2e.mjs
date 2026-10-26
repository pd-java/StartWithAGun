/**
 * autoplay-e2e.mjs —— 自动玩端到端验证
 * 用普通 URL（不带 ?autotest）启动，验证：
 *   1) 模块全部加载、状态机进入 RUNNING
 *   2) 自动点击能推进 启动页 → 战斗场景
 *   3) 进入战斗后能识别目标并开枪（stats.shots > 0）
 *   4) 暂停后不再产生新输入
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const OUT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun/.workbuddy/probe-out';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9355;
const profile = mkdtempSync(join(tmpdir(), 'cdp-e2e-'));
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
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      errs.push(String((m.params.exceptionDetails.exception || {}).description || '').slice(0, 180));
    }
  });

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 30000 });
    if (r.exceptionDetails) return { __err: String((r.exceptionDetails.exception || {}).description || '').slice(0, 250) };
    return r.result.value;
  };

  await S('Page.navigate', { url: URL_ });
  await sleep(2000);

  log('=== 模块加载检查 ===');
  log(await evalJs(`JSON.stringify({
    Input: !!window.AutoplayInput,
    Perception: !!window.AutoplayPerception,
    Strategy: !!window.AutoplayStrategy,
    Autoplay: !!window.Autoplay,
    ProgressReset: !!window.ProgressReset,
    Diag: !!window.AutoplayDiag,
    panel: !!document.getElementById('ap-toggle'),
    inject: typeof window.__wxInjectTouch
  })`));

  await evalJs('document.getElementById("start-btn").click()');
  log('已点「开始游戏」，启动自动玩…');
  await sleep(1200);
  log('start ->', await evalJs('window.Autoplay.start().then(function(v){return v})'));

  // 观测 300s（软件渲染下首屏加载约 60~120s）
  let shotSeen = false, gameplaySeen = false;
  for (let i = 0; i < 100; i++) {
    await sleep(3000);
    const st = await evalJs('JSON.stringify(window.Autoplay.getStatus())');
    let s; try { s = JSON.parse(st); } catch (e) { log('  status-err', st); break; }
    const line = `t=${(i + 1) * 3}s state=${s.state} scene=${s.scene} targets=${s.targets} shots=${s.stats.shots} taps=${s.stats.taps} ticks=${s.stats.ticks} err=${s.stats.errors} luma=${s.metrics && s.metrics.avgLuma}`;
    if (i % 3 === 0 || s.stats.shots > 0) log('  ' + line);
    if (i % 10 === 0) log('    perception:', await evalJs('JSON.stringify(window.AutoplayPerception.stats())'));
    if (s.stats.shots > 0) shotSeen = true;
    if (s.scene === 'gameplay') gameplaySeen = true;

    if (i === 30 || i === 60) {
      const sh = await S('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(OUT, `e2e-t${(i + 1) * 3}.png`), Buffer.from(sh.data, 'base64'));
    }
    if (shotSeen && gameplaySeen && i > 20) break;
    if (errs.length) { log('    ! ' + errs.slice(-1)[0]); errs.length = 0; }
  }

  log('');
  log('=== 暂停测试：暂停后 6 秒内是否还有新动作 ===');
  log('pause ->', await evalJs('window.Autoplay.pause()'));
  const before = await evalJs('window.Autoplay.getStatus().stats.shots + "/" + window.Autoplay.getStatus().stats.taps');
  await sleep(6000);
  const after = await evalJs('window.Autoplay.getStatus().stats.shots + "/" + window.Autoplay.getStatus().stats.taps');
  log(`  暂停前 射击/点击=${before}  暂停后=${after}  ${before === after ? '✔ 无新动作' : '✘ 仍在动作'}`);
  log('  输入按下状态残留:', await evalJs('window.AutoplayInput.isPressed()'));

  log('resume ->', await evalJs('window.Autoplay.resume()'));
  await sleep(4000);
  log('  恢复后状态:', await evalJs('JSON.stringify({state:window.Autoplay.state,shots:window.Autoplay.getStatus().stats.shots})'));
  log('stop ->', await evalJs('window.Autoplay.stop()'));

  log('');
  log('=== 诊断日志（尾部 25 条）===');
  log(await evalJs('window.AutoplayDiag.dump(25)'));

  log('');
  log('=== 存档现状 ===');
  log(await evalJs('JSON.stringify(window.ProgressReset.inspect().summary)'));

  const sh = await S('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, 'e2e-final.png'), Buffer.from(sh.data, 'base64'));

  log('');
  log('结论: 进入战斗=' + gameplaySeen + ' 出现过射击=' + shotSeen);

  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
