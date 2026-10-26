/**
 * autoplay-probe.mjs —— 自动玩前置实测
 *
 * 目的（回答 ChatGPT 提出的三个问题）：
 *   Q1 操作方式：合成的鼠标事件能否驱动游戏？按下/移动/抬起是否都被识别？
 *   Q2 目标识别：?autotest 钩子产出的 window.__redTargets 是否对应真实敌人？
 *   Q3 存档位置：localStorage 里哪些键承载游戏进度？
 *
 * 用法：node tools/autoplay-probe.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/?autotest';
const OUT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun/.workbuddy/probe-out';
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, '.keep'), '');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9345;
const profile = mkdtempSync(join(tmpdir(), 'cdp-ap-'));

const child = spawn(CHROME, [
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
  'http://127.0.0.1:8848/robots.txt'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

async function getWs() {
  for (let i = 0; i < 80; i++) {
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

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, timeout: 30000
    });
    if (r.exceptionDetails) {
      return { __err: String(r.exceptionDetails.text || '') + ' ' + String((r.exceptionDetails.exception || {}).description || '').slice(0, 200) };
    }
    return r.result.value;
  };

  log('=== 1) 加载页面 ===', URL_);
  await S('Page.navigate', { url: URL_ });
  await sleep(2000);

  // 注入工具函数
  await evalJs(`
    window.__ap = {
      canvas: function(){ return document.querySelector('canvas'); },
      rect: function(){ var c=this.canvas(); return c ? HTMLCanvasElement.prototype.getBoundingClientRect.call(c) : null; },
      hash: function(){
        var c=this.canvas(); if(!c||!c.width) return null;
        var b=window.__ap._b; if(!b){ b=document.createElement('canvas'); window.__ap._b=b; }
        b.width=64; b.height=64;
        var g=b.getContext('2d'); g.drawImage(c,0,0,64,64);
        var d=g.getImageData(0,0,64,64).data, h=0;
        for(var i=0;i<d.length;i+=4){ h=(h*31 + d[i]*1 + d[i+1]*3 + d[i+2]*7)>>>0; }
        return h;
      },
      nonBlack: function(){
        var c=this.canvas(); if(!c||!c.width) return -1;
        var b=window.__ap._b; if(!b){ b=document.createElement('canvas'); window.__ap._b=b; }
        b.width=64; b.height=64;
        var g=b.getContext('2d'); g.drawImage(c,0,0,64,64);
        var d=g.getImageData(0,0,64,64).data, n=0;
        for(var i=0;i<d.length;i+=4){ if(d[i]+d[i+1]+d[i+2] > 60) n++; }
        return n;
      },
      clickAt: function(nx, ny){
        var c=this.canvas(), r=this.rect(); if(!c||!r) return 'no-canvas';
        var x=r.left+nx*r.width, y=r.top+ny*r.height;
        var o={bubbles:true, cancelable:true, clientX:x, clientY:y, button:0, buttons:1};
        c.dispatchEvent(new MouseEvent('mousedown', o));
        window.dispatchEvent(new MouseEvent('mouseup', Object.assign({},o,{buttons:0})));
        return {x:Math.round(x), y:Math.round(y)};
      },
      downAt: function(nx, ny){
        var c=this.canvas(), r=this.rect(); if(!c||!r) return 'no-canvas';
        var x=r.left+nx*r.width, y=r.top+ny*r.height;
        c.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true, clientX:x, clientY:y, button:0, buttons:1}));
        return true;
      },
      moveAt: function(nx, ny){
        var r=this.rect(); if(!r) return 'no-rect';
        var x=r.left+nx*r.width, y=r.top+ny*r.height;
        window.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, cancelable:true, clientX:x, clientY:y, button:0, buttons:1}));
        return true;
      },
      upAt: function(nx, ny){
        var r=this.rect(); if(!r) return 'no-rect';
        var x=r.left+nx*r.width, y=r.top+ny*r.height;
        window.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, cancelable:true, clientX:x, clientY:y, button:0, buttons:0}));
        return true;
      },
      ls: function(){
        var o={};
        for(var i=0;i<localStorage.length;i++){ var k=localStorage.key(i); var v=localStorage.getItem(k)||''; o[k]={len:v.length, head:v.slice(0,80)}; }
        return o;
      }
    }; 'ok'`);

  log('viewport:', await evalJs('innerWidth+"x"+innerHeight'));
  log('start-btn 存在:', await evalJs('!!document.getElementById("start-btn")'));

  // 点击「开始游戏」
  await evalJs('document.getElementById("start-btn").click()');
  log('已点击开始，等待 Unity 启动…');

  let ready = false;
  for (let i = 0; i < 70; i++) {
    await sleep(2000);
    const st = await evalJs('(function(){var c=window.__ap.canvas();return {w:c&&c.width,h:c&&c.height,frames:window.__frameCount||0,targets:(window.__redTargets?window.__redTargets.length:null)}})()');
    if (i % 3 === 0) log(`  t=${(i + 1) * 2}s`, JSON.stringify(st));
    if (st && st.w > 1 && st.frames > 5) { ready = true; log('  Unity 已开始渲染 @', (i + 1) * 2, 's'); break; }
  }
  if (!ready) log('  !! 超时未确认渲染');

  await sleep(3000);

  log('');
  log('=== 2) 画布与识别状态 ===');
  const base = await evalJs('(function(){var c=window.__ap.canvas();var r=window.__ap.rect();return {cw:c.width,ch:c.height,rw:Math.round(r.width),rh:Math.round(r.height),left:Math.round(r.left),top:Math.round(r.top),frames:window.__frameCount||0,nonBlack:window.__ap.nonBlack(),targets:window.__redTargets||null}})()');
  log(JSON.stringify(base));

  // 连续采样帧哈希，判断游戏是否在动
  const hashes = [];
  for (let i = 0; i < 8; i++) { hashes.push(await evalJs('window.__ap.hash()')); await sleep(400); }
  log('帧哈希序列:', JSON.stringify(hashes), '唯一值:', new Set(hashes).size);

  log('');
  log('=== 3) 近 3 秒的目标识别采样 ===');
  for (let i = 0; i < 6; i++) {
    const t = await evalJs('JSON.stringify({n:(window.__redTargets||[]).length, t:(window.__redTargets||[]).slice(0,6)})');
    log('  ', t);
    await sleep(500);
  }

  log('');
  log('=== 4) 输入链路实测（合成 MouseEvent）===');
  const before = await evalJs('window.__ap.hash()');
  log('输入前 hash:', before);

  // 4a 单击画面中心
  log('4a 单击 (0.5, 0.5):', JSON.stringify(await evalJs('window.__ap.clickAt(0.5,0.5)')));
  await sleep(1200);
  log('   之后 hash:', await evalJs('window.__ap.hash()'), ' 目标数:', await evalJs('(window.__redTargets||[]).length'));

  // 4b 按下 - 移动 - 抬起
  log('4b 按下(0.3,0.3) → 移动(0.7,0.6) → 抬起');
  await evalJs('window.__ap.downAt(0.3,0.3)');
  await sleep(300);
  await evalJs('window.__ap.moveAt(0.5,0.45)');
  await sleep(300);
  await evalJs('window.__ap.moveAt(0.7,0.6)');
  await sleep(400);
  await evalJs('window.__ap.upAt(0.7,0.6)');
  await sleep(1200);
  log('   之后 hash:', await evalJs('window.__ap.hash()'));

  // 4c 对检测到的目标射击
  const tgt = await evalJs('(window.__redTargets&&window.__redTargets.length)?{x:window.__redTargets[0].x,y:window.__redTargets[0].y,n:window.__redTargets[0].n}:null');
  if (tgt) {
    log('4c 对首个目标射击:', JSON.stringify(tgt));
    log('   clickAt →', JSON.stringify(await evalJs(`window.__ap.clickAt(${tgt.x},${tgt.y})`)));
    await sleep(1500);
    log('   之后 hash:', await evalJs('window.__ap.hash()'), ' 目标数:', await evalJs('(window.__redTargets||[]).length'));
  } else {
    log('4c 跳过：当前无检测目标');
  }

  log('');
  log('=== 5) localStorage 存档结构 ===');
  const ls = await evalJs('JSON.stringify(window.__ap.ls())');
  log(ls);

  log('');
  log('=== 6) 虚拟文件系统 ===');
  log(await evalJs('JSON.stringify(window.__wxShim&&window.__wxShim.dumpFS?window.__wxShim.dumpFS():null)'));

  log('');
  log('=== 7) 诊断日志尾部 ===');
  log(await evalJs('(window.__wxShimLogDump?window.__wxShimLogDump().split("\\n").slice(-25).join("\\n"):"none")'));

  // 截图
  const shot = await S('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, 'autoplay-probe.png'), Buffer.from(shot.data, 'base64'));
  log('\n截图:', join(OUT, 'autoplay-probe.png'));

  try { child.kill(); } catch (e) {}
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch (_) {} process.exit(1); });
