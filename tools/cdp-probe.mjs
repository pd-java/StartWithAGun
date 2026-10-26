/**
 * 无头 Chrome CDP 探针：加载离线版游戏，截图 → 改窗口尺寸 → 再截图。
 * 用于验证「画面是否跟随浏览器窗口自适应」。
 *
 * 用法：
 *   node tools/cdp-probe.mjs <outDir> [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2] || 'C:/temp/probe';
const URL_ = process.argv[3] || 'http://127.0.0.1:8848/';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), 'cdp-'));

const args = [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--window-size=900,900',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--mute-audio',
  'about:blank'
];
const child = spawn(CHROME, args, { stdio: 'ignore', detached: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch (e) { /* retry */ }
    await sleep(300);
  }
  throw new Error('chrome 未就绪');
}

let id = 0;
const pending = new Map();
let ws;

function send(method, params = {}, sessionId) {
  const msg = { id: ++id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    pending.set(msg.id, { resolve, reject });
    ws.send(JSON.stringify(msg));
  });
}

async function main() {
  ws = new WebSocket(await getWs());
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    }
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);

  await S('Page.enable');
  await S('Runtime.enable');
  await S('Log.enable');
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning' || m.params.type === 'log')) {
      const txt = (m.params.args || []).map((a) => a.value || a.description || '').join(' ');
      if (txt && (m.params.type !== 'log' || txt.indexOf('[wx') >= 0 || txt.indexOf('shim') >= 0 || txt.indexOf('canvas') >= 0))
        console.log('[console.' + m.params.type + ']', txt.slice(0, 400));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      console.log('[log.error]', String(m.params.entry.text).slice(0, 300));
    }
  });

  await S('Page.navigate', { url: URL_ });
  await sleep(2500);

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) { console.log('[eval-err]', (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text || '').slice(0, 400)); return { __err: r.exceptionDetails.text }; }
    return r.result.value;
  };

  console.log('viewport before:', await evalJs('innerWidth + "x" + innerHeight'));
  console.log('start btn:', await evalJs('!!document.getElementById("start-btn")'));
  await evalJs('document.getElementById("start-btn").click()');

  // 等待 canvas 出现并跑起来
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const st = await evalJs('(function(){var c=document.querySelector("canvas");return c? (c.width+"x"+c.height+" css:"+c.style.width+"x"+c.style.height):""})()');
    console.log(`t=${(i + 1) * 2}s canvas=`, st);
    if (st && /^\d+x\d+/.test(st)) {
      const w = parseInt(st, 10);
      if (w > 1) break;
    }
  }

  await sleep(8000);
  const shot1 = await S('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, 'shot-before.png'), Buffer.from(shot1.data, 'base64'));

  console.log('info1:', await evalJs('(function(){var c=document.querySelector("canvas");return {iw:innerWidth,ih:innerHeight,cw:c&&c.width,ch:c&&c.height,sw:c&&c.style.width,sh:c&&c.style.height,gbr:c&&JSON.stringify(c.getBoundingClientRect()), fw: GameGlobal.window && GameGlobal.window.innerWidth}})()'));

  // 改窗口尺寸：900x900 -> 1280x620
  await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 620, deviceScaleFactor: 1, mobile: false });
  await sleep(2000);
  const shot2 = await S('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, 'shot-after.png'), Buffer.from(shot2.data, 'base64'));

  // 实验 A：Browser.setCanvasSize（emscripten 官方尺寸更新入口）
  console.log('expA:', await evalJs('(function(){var B=GameGlobal.unityNamespace&&GameGlobal.unityNamespace.Browser;if(!B)return "no Browser";var d=devicePixelRatio||1;B.setCanvasSize(Math.round(innerWidth*d),Math.round(innerHeight*d));var c=document.querySelector("canvas");return "ok "+c.width+"x"+c.height+" native "+c.widthNative+"x"+c.heightNative})()'));
  await sleep(2500);
  const shot3 = await S('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, 'shot-expA.png'), Buffer.from(shot3.data, 'base64'));

  console.log('globals:', await evalJs('JSON.stringify({a:!!window.canvas,b:String(window.canvas&&window.canvas.id),c:!!window.GameGlobal&&!!GameGlobal.canvas})'));
  console.log('ring:', await evalJs('(window.__wxShimLogDump ? window.__wxShimLogDump().split(String.fromCharCode(10)).slice(0,20).join(" ~~~ ") : "none")'));

  console.log('style-truth:', await evalJs('(function(){var names=Object.getOwnPropertyNames(window);return {hasCanvas: names.indexOf("canvas")>=0, canvasVal: (function(){try{return String(window.canvas)}catch(e){return "ERR "+e.message}})(), typeofCanvas: typeof canvas === "undefined" ? "undefined" : "defined", bootLog: (window.__wxShimLogDump? window.__wxShimLogDump().split("\n").slice(0,12).join(" || "):"")}})()'));

  console.log('style-truth:', await evalJs('(function(){var c=document.querySelector("canvas");var chain=[],o=c;while(o&&chain.length<8){chain.push(o.constructor&&o.constructor.name||"?");o=Object.getPrototypeOf(o)}return {attr:c.getAttribute("style"), ownStyle:Object.getOwnPropertyDescriptor(c,"style")!==undefined, fakeStyleObj:(function(){var p=Object.getPrototypeOf(Object.getPrototypeOf(c));return p&&p.style})(), chain:chain, styleRef:c.style===document.createElement("canvas").style}})()'));

  console.log('canvases:', await evalJs('(function(){return Array.prototype.map.call(document.querySelectorAll("canvas"),function(c){return {id:c.id,w:c.width,h:c.height,style:[c.style.width,c.style.height,c.style.left,c.style.top],parent:c.parentNode&&(c.parentNode.id||c.parentNode.tagName),isConnected:c.isConnected}})})()'));

  console.log('GameGlobal.canvas == first?', await evalJs('(function(){var c=document.querySelector("canvas");return {same: GameGlobal.canvas===c, gid: GameGlobal.canvas&&GameGlobal.canvas.id, gw:GameGlobal.canvas&&GameGlobal.canvas.width}})()'));

  console.log('info2:', await evalJs('(function(){var c=document.querySelector("canvas");var r=HTMLCanvasElement.prototype.getBoundingClientRect.call(c);var s=getComputedStyle(c);return {iw:innerWidth,ih:innerHeight,cw:c&&c.width,ch:c&&c.height,sw:c&&c.style.width,sh:c&&c.style.height,sl:c&&c.style.left,st:c&&c.style.top,native:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)],off:[c.offsetLeft,c.offsetTop,c.offsetWidth,c.offsetHeight],cs:[s.width,s.height,s.left,s.top,s.position], fw: GameGlobal.window && GameGlobal.window.innerWidth}})()'));

  console.log('done ->', OUT);
  child.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error('FAIL', e.message);
  try { child.kill(); } catch (e2) {}
  process.exit(1);
});
