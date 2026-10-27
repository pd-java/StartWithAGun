/**
 * perception-darktest.mjs —— detectDarkTargets 的合成图回归测试
 *
 * 目的（ChatGPT turn-12 裁定）：
 *   修复「中央排除圈无条件抠掉真目标」之后，不能只验证原来那个目标重新出现，
 *   而要分别验证六种情形。全部用**合成 RGBA 缓冲**构造，不依赖游戏处于哪个场景。
 *
 * 用例：
 *   1. 排除区内只有一个可信目标            → 保留
 *   2. 区内目标 vs 区外明显更可信的候选    → 抑制区内低可信候选
 *   3. 区内外置信度接近                    → 两个都保留（不凭位置删）
 *   4. 排除区内没有目标                    → 不影响区外候选
 *   5. 不同目标位置 / 不同画面尺寸          → 不依赖单个固定坐标
 *   6. 原有 UI 干扰场景（准星 + 大镜筒块）  → 不产生明显误检回归
 *
 * 用法: node tools/perception-darktest.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const ROOT = 'D:/document/coder/MyCareer/9-StartWithAGunProj/StartWithAGun';
const OUT = ROOT + '/.workbuddy/probe-out';
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9439;
const profile = mkdtempSync(join(tmpdir(), 'cdp-perc-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1000,800', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--mute-audio', URL_
], { stdio: 'ignore' });
process.on('exit', () => { try { child.kill(); } catch (e) {} });

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
function send(m, p = {}, sid) {
  const msg = { id: ++id, method: m, params: p }; if (sid) msg.sessionId = sid;
  return new Promise((res, rej) => { pending.set(msg.id, { resolve: res, reject: rej }); ws.send(JSON.stringify(msg)); });
}

const HELPERS = `
window.__mkImg = function (w, h, bg) {
  var a = new Uint8ClampedArray(w * h * 4);
  for (var i = 0; i < w * h; i++) { a[i*4] = bg; a[i*4+1] = bg; a[i*4+2] = bg; a[i*4+3] = 255; }
  return a;
};
/* 以归一化中心 + 归一化尺寸画一个暗矩形 */
window.__rect = function (a, w, h, ncx, ncy, nw, nh, lum) {
  var x0 = Math.round((ncx - nw / 2) * w), x1 = Math.round((ncx + nw / 2) * w);
  var y0 = Math.round((ncy - nh / 2) * h), y1 = Math.round((ncy + nh / 2) * h);
  for (var y = Math.max(0, y0); y < Math.min(h, y1); y++) {
    for (var x = Math.max(0, x0); x < Math.min(w, x1); x++) {
      var i = (y * w + x) * 4; a[i] = lum; a[i+1] = lum; a[i+2] = lum; a[i+3] = 255;
    }
  }
  return a;
};
window.__det = function (a, w, h) {
  var P = window.AutoplayPerception;
  var list = P.__detectDarkTargets(a, w, h);
  return { list: list, debug: P.__darkDebug() };
};
'ok'`;

async function main() {
  ws = new WebSocket(await getWs());
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  };
  const { targetId } = await send('Target.createTarget', { url: URL_ });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Page.enable'); await S('Runtime.enable');
  const ev = async (e) => {
    const r = await S('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, timeout: 60000 });
    if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description || '').slice(0, 300) };
    return r.result.value;
  };

  // 只需要 perception.js 加载完成，不需要等 Unity 启动
  let ready = false;
  for (let i = 0; i < 60; i++) {
    ready = await ev('!!(window.AutoplayPerception && window.AutoplayPerception.__detectDarkTargets)');
    if (ready === true) { log(`感知层就绪 @ ${(i + 1) * 0.5}s`); break; }
    await sleep(500);
  }
  if (!ready) { log('✘ perception.js 未就绪'); try { child.kill(); } catch (e) {} process.exit(2); }
  await ev(HELPERS);

  const R = [];
  const push = (name, ok, detail) => { R.push({ name, ok: !!ok, detail }); log(`  ${ok ? '✔ PASS' : '✘ FAIL'}  ${name}${detail ? '  | ' + detail : ''}`); };
  const brief = (l) => l.map((t) => `(${t.x.toFixed(2)},${t.y.toFixed(2)} sz=${t.size} cf=${t.confidence ?? '-'} in=${t.inDisc ? 1 : 0} ex=${t.exclusion || '-'})`).join(' ');

  log('\n=== 1) 排除区内只有一个可信目标 → 保留 ===');
  let r = JSON.parse(await ev(`(function(){
    var w=320,h=240,a=window.__mkImg(w,h,200);
    window.__rect(a,w,h,0.48,0.43,0.075,0.10,20);
    return JSON.stringify(window.__det(a,w,h));
  })()`));
  push('1 区内唯一目标被保留', r.list.length === 1 && r.list[0].inDisc === true,
    `kept=${r.list.length} inside=${r.debug.inside} suppressed=${r.debug.suppressed} :: ${brief(r.list)}`);

  log('\n=== 2) 区内目标 vs 区外明显更可信候选 → 抑制区内 ===');
  r = JSON.parse(await ev(`(function(){
    var w=320,h=240,a=window.__mkImg(w,h,200);
    window.__rect(a,w,h,0.48,0.43,0.050,0.070,60);   // 区内：小、偏灰
    window.__rect(a,w,h,0.25,0.25,0.125,0.170,0);    // 区外：大、全黑
    return JSON.stringify(window.__det(a,w,h));
  })()`));
  push('2 区内低可信候选被抑制', r.list.length === 1 && r.debug.suppressed === 1 && r.list[0].inDisc === false,
    `kept=${r.list.length} suppressed=${r.debug.suppressed} :: ${brief(r.list)}`);

  log('\n=== 3) 区内外置信度接近 → 两个都保留 ===');
  r = JSON.parse(await ev(`(function(){
    var w=320,h=240,a=window.__mkImg(w,h,200);
    window.__rect(a,w,h,0.61,0.42,0.075,0.100,10);   // 区内、但离开准星核心
    window.__rect(a,w,h,0.25,0.25,0.075,0.100,10);   // 区外，同尺寸同暗度
    return JSON.stringify(window.__det(a,w,h));
  })()`));
  push('3 置信度接近时不凭位置删除',
    r.list.length === 2 && r.debug.suppressed === 0,
    `kept=${r.list.length} inside=${r.debug.inside} suppressed=${r.debug.suppressed} :: ${brief(r.list)}`);

  log('\n=== 4) 排除区内没有目标 → 不影响区外候选 ===');
  r = JSON.parse(await ev(`(function(){
    var w=320,h=240,a=window.__mkImg(w,h,200);
    window.__rect(a,w,h,0.25,0.25,0.075,0.100,20);
    return JSON.stringify(window.__det(a,w,h));
  })()`));
  push('4 区内无目标时区外候选不变', r.list.length === 1 && r.debug.inside === 0 && r.debug.suppressed === 0,
    `kept=${r.list.length} inside=${r.debug.inside} :: ${brief(r.list)}`);

  log('\n=== 5) 不同目标位置 / 不同画面尺寸 ===');
  const c5a = JSON.parse(await ev(`(function(){
    var w=320,h=240,a=window.__mkImg(w,h,200);
    window.__rect(a,w,h,0.35,0.30,0.075,0.100,20);
    return JSON.stringify(window.__det(a,w,h));
  })()`));
  const c5b = JSON.parse(await ev(`(function(){
    var w=640,h=360,a=window.__mkImg(w,h,200);
    window.__rect(a,w,h,0.70,0.55,0.075,0.100,20);
    return JSON.stringify(window.__det(a,w,h));
  })()`));
  const near = (t, x, y) => t && Math.abs(t.x - x) < 0.03 && Math.abs(t.y - y) < 0.03;
  push('5a 320x240 @ (0.35,0.30) 命中', c5a.list.length === 1 && near(c5a.list[0], 0.35, 0.30), brief(c5a.list));
  push('5b 640x360 @ (0.70,0.55) 命中', c5b.list.length === 1 && near(c5b.list[0], 0.70, 0.55), brief(c5b.list));

  log('\n=== 6) 原有 UI 干扰场景 ===');
  // 6a：只有准星小点。按「规则 4：没有竞争候选就保留」，它会被保留 ——
  //     这是相对旧实现的行为变化，如实记录，不粉饰。
  const c6a = JSON.parse(await ev(`(function(){
    var w=320,h=240,a=window.__mkImg(w,h,200);
    window.__rect(a,w,h,0.5,0.42,0.030,0.040,15);
    return JSON.stringify(window.__det(a,w,h));
  })()`));
  push('6a 仅准星小点 → 被保留（规则4；行为变化已记录）',
    c6a.list.length === 1 && Math.abs(c6a.list[0].x - 0.5) < 0.02,
    `kept=${c6a.list.length} :: ${brief(c6a.list)}`);

  // 6b：准星小点 + 一块**不重叠**的深色大块（墙体/布景）。大块远超 40 格，
  //     应当被尺寸过滤，而不是变成候选。
  const c6b = JSON.parse(await ev(`(function(){
    var w=320,h=240,a=window.__mkImg(w,h,200);
    window.__rect(a,w,h,0.5,0.42,0.030,0.040,15);    // 准星小点
    window.__rect(a,w,h,0.22,0.22,0.300,0.260,10);   // 远处深色大块（墙面）
    return JSON.stringify(window.__det(a,w,h));
  })()`));
  push('6b 大块被尺寸过滤，不产生额外候选',
    c6b.list.length === 1 && Math.abs(c6b.list[0].x - 0.5) < 0.02,
    `kept=${c6b.list.length} :: ${brief(c6b.list)}`);

  log('\n=== 7) 旧代码会漏掉的情形（回归锚点） ===');
  r = JSON.parse(await ev(`(function(){
    var d = window.AutoplayPerception.__disc();
    var w=320,h=240,a=window.__mkImg(w,h,200);
    window.__rect(a,w,h,0.48,0.43,0.075,0.100,20);
    var out = window.__det(a,w,h);
    var dx = 0.48 - d.cx, dy = 0.43 - d.cy;
    return JSON.stringify({ r2: dx*dx+dy*dy, discR2: d.r2, kept: out.list.length });
  })()`));
  push('7 靶子在旧排除圈内但如今被保留（旧逻辑会抠掉）',
    r.r2 < r.discR2 && r.kept === 1,
    `靶子 r²=${r.r2.toFixed(5)} < 排除圈 r²=${r.discR2} → 旧实现必抠，现 kept=${r.kept}`);

  const pass = R.filter((x) => x.ok).length;
  log(`\n=== 汇总: ${pass}/${R.length} 通过 ===`);
  writeFileSync(join(OUT, 'perception-darktest.json'), JSON.stringify({ at: new Date().toISOString(), pass, total: R.length, results: R }, null, 1));
  log('已写 .workbuddy/probe-out/perception-darktest.json');
  try { child.kill(); } catch (e) {}
  process.exit(pass === R.length ? 0 : 1);
}

main().catch((e) => { log('FATAL', e && e.message); try { child.kill(); } catch (x) {} process.exit(2); });
