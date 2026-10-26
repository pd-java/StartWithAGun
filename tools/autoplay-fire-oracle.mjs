/**
 * autoplay-fire-oracle.mjs —— 用弹药徽标做「这一枪到底响没响」的硬判据
 *
 * 背景（v5 的结论）：
 *   准星精确位置已量到 (0.5000, 0.4994)（白十字四段笔画交点）；
 *   敌人头顶有纯红小条 (255,15,0) 做身份锚点；
 *   闭环拖动能把敌人压到距准星 0.018 以内。
 *   但连打 8 次 press-hold-release，敌人不动、教程仍 total=2、画面连抖动都没有。
 *
 * 新线索：画面右侧有一个**固定 UI 徽标**，圆形、子弹图标 + "4/5"。
 *   实测：换过多个摄像机角度后它仍在同一像素位置 ⇒ 是 HUD 不是布景。
 *   而且无论我们"开火"多少次，它始终是 4/5 ⇒ **弹药没有消耗 ⇒ 枪没响**。
 *
 * 于是它成了完美的判据：只要数字变了，就说明这一发真的打出去了。
 * 本脚本把各种输入方式挨个试一遍，逐一读徽标，输出一张「哪种输入能让枪响」的表。
 *
 * 用法: node tools/autoplay-fire-oracle.mjs [url]
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const ROOT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun';
const OUT = ROOT + '/.workbuddy/probe-out';
const PY = 'C:/Users/11313/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9391;
const profile = mkdtempSync(join(tmpdir(), 'cdp-oracle-'));
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

/* 输入原语：全部走 __wxInjectTouch，不派发 DOM 事件 */
const INPUT = `
window.__inp = {
  tap: function (x, y, hold) {
    var I = window.AutoplayInput;
    return new Promise(function (res) {
      I.press(x, y);
      var h = 0, n = Math.max(1, Math.round((hold || 120) / 120));
      var iv = setInterval(function () {
        h++; I.moveTo(x, y);
        if (h >= n) { clearInterval(iv); I.release(x, y); res('ok'); }
      }, 120);
    });
  },
  drag: function (x0, y0, x1, y1, steps, stepMs, hold) {
    var I = window.AutoplayInput;
    return new Promise(function (res) {
      I.press(x0, y0);
      var n = 0;
      var iv = setInterval(function () {
        n++;
        I.moveTo(x0 + (x1 - x0) * (n / steps), y0 + (y1 - y0) * (n / steps));
        if (n >= steps) {
          clearInterval(iv);
          var h = 0, hn = Math.max(1, Math.round((hold || 120) / 120));
          var iv2 = setInterval(function () {
            h++; I.moveTo(x1, y1);
            if (h >= hn) { clearInterval(iv2); I.release(x1, y1); res('ok'); }
          }, 120);
        }
      }, stepMs);
    });
  }
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
      if (/TUTORIAL_SEQUENCE|HealthComponents|GotoNextLevel|Level activated/i.test(s)) {
        const line = `+${Math.round((Date.now() - t0c) / 1000)}s ${s.slice(0, 160)}`;
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
  const snapPath = async (tag) => {
    const name = `${tag}-${String(++shotN).padStart(2, '0')}`;
    const sh = await S('Page.captureScreenshot', { format: 'png' });
    const p = join(OUT, name + '.png');
    writeFileSync(p, Buffer.from(sh.data, 'base64'));
    return p;
  };
  /**
   * 读弹药徽标的指纹。
   * 区域是实测的固定 HUD 位置：x[0.925,0.998] y[0.552,0.640]。
   * 返回 8x8 的灰度均值网格（对 1~2 像素抖动不敏感），以及整体均值。
   */
  const badge = async (tag) => {
    const p = await snapPath(tag);
    const code = `
import sys, json
from PIL import Image
import numpy as np
a = np.asarray(Image.open(sys.argv[1]).convert('L'), dtype=float)
h, w = a.shape
x0,x1 = int(0.925*w), int(0.998*w)
y0,y1 = int(0.552*h), int(0.640*h)
sub = a[y0:y1, x0:x1]
g = sub.reshape(8, sub.shape[0]//8, 8, sub.shape[1]//8).mean(axis=(1,3))
print(json.dumps({'mean': round(float(sub.mean()),2), 'grid': [round(float(v),1) for v in g.flatten()]}))
`;
    try {
      const out = execFileSync(PY, ['-c', code, p], { encoding: 'utf8', maxBuffer: 1 << 20 });
      const r = JSON.parse(out.trim().split('\n').pop());
      r.png = p;
      return r;
    } catch (e) {
      log('  ⚠ 读徽标失败: ' + String(e.message).slice(0, 150));
      return null;
    }
  };
  const gridDiff = (a, b) => {
    if (!a || !b) return null;
    let s = 0;
    for (let i = 0; i < a.grid.length; i++) s += Math.abs(a.grid[i] - b.grid[i]);
    return Math.round(s / a.grid.length * 100) / 100;
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
  await evalJs(INPUT);
  log('  等教程进入"等待击杀"…');
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    if (tutLog.some((l) => /Waiting for targets/.test(l))) { log(`  已进入等待击杀 @ 轮询第 ${i + 1} 次`); break; }
  }

  log('');
  log('=== 阶段 1：徽标稳定性基线（不输入）===');
  const b0 = await badge('oracle');
  await sleep(1500);
  const b1 = await badge('oracle');
  await sleep(1500);
  const b2 = await badge('oracle');
  log(`  连续三次读数 diff(0,1)=${gridDiff(b0, b1)}  diff(1,2)=${gridDiff(b1, b2)}  mean=${b2 ? b2.mean : '?'}`);
  log('  → 阈值取 3.0：超过就认为徽标内容变了');

  const cases = [
    { name: '01 中心快速点按 (0.50,0.50) 120ms', fn: () => evalJs('window.__inp.tap(0.50,0.50,120)') },
    { name: '02 中心按住释放 (0.50,0.50) 600ms', fn: () => evalJs('window.__inp.tap(0.50,0.50,600)') },
    { name: '03 中心按住释放 (0.50,0.50) 1500ms', fn: () => evalJs('window.__inp.tap(0.50,0.50,1500)') },
    { name: '04 上方空域点按 (0.50,0.28) 120ms', fn: () => evalJs('window.__inp.tap(0.50,0.28,120)') },
    { name: '05 下方武器区按住释放 (0.50,0.80) 600ms', fn: () => evalJs('window.__inp.tap(0.50,0.80,600)') },
    { name: '06 左半屏点按 (0.30,0.50) 120ms', fn: () => evalJs('window.__inp.tap(0.30,0.50,120)') },
    { name: '07 微拖后释放 (0.47,0.50)->(0.52,0.50)', fn: () => evalJs('window.__inp.drag(0.47,0.50,0.52,0.50,6,45,200)') },
    { name: '08 大幅拖后释放 (0.30,0.50)->(0.70,0.50)', fn: () => evalJs('window.__inp.drag(0.30,0.50,0.70,0.50,20,45,200)') },
    { name: '09 点弹药徽标本身 (0.960,0.596)', fn: () => evalJs('window.__inp.tap(0.960,0.596,120)') },
    { name: '10 点徽标并长按 (0.960,0.596) 900ms', fn: () => evalJs('window.__inp.tap(0.960,0.596,900)') },
    { name: '11 按住不动 3s 再释放 (0.50,0.50)', fn: () => evalJs('window.__inp.tap(0.50,0.50,3000)') }
  ];

  log('');
  log('=== 阶段 2：逐项试输入，每项后读徽标 ===');
  let prev = b2;
  const rows = [];
  for (const c of cases) {
    await c.fn();
    await sleep(1400);
    const b = await badge('oracle');
    const d = gridDiff(prev, b);
    rows.push({ name: c.name, diff: d, mean: b ? b.mean : null, png: b ? b.png : '' });
    log(`  ${c.name}  → diff=${d}  mean=${b ? b.mean : '?'}${d > 3 ? '   ★ 徽标变了！' : ''}`);
    prev = b;
  }

  log('');
  log('=== 汇总 ===');
  const hits = rows.filter((r) => r.diff > 3);
  if (hits.length) {
    log('  ★ 能让徽标（弹药）发生变化的输入：');
    hits.forEach((h) => log('    ' + h.name + '  diff=' + h.diff));
  } else {
    log('  ✘ 全部 11 种输入都没让弹药变化 ⇒ 当前状态下射击被禁止（很可能是教程对话期间的 InputBlocked）');
  }
  log('  教程日志尾部: ' + (tutLog.slice(-3).join('  |  ') || '(none)'));

  try { child.kill(); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
