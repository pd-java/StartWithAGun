#!/usr/bin/env node
/*
 * test-harness.js —— 无头浏览器自测
 * ---------------------------------------------------------------
 * 启动静态服务器 + Chromium（headless），加载 index.html，
 * 点击「开始游戏」，采集 console / 异常 / 截图，
 * 用来验证离线版能否真正跑起来。
 *
 *   node test-harness.js            # 跑一次
 *   node test-harness.js --headful  # 有界面
 *   node test-harness.js --wait 60  # 等 60 秒
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PLAYWRIGHT_PATHS = [
  path.join(__dirname, '..', '..', 'github-rea', 'rea', 'node_modules', 'playwright-core'),
  'playwright-core',
  'playwright'
];

let chromium = null;
for (const p of PLAYWRIGHT_PATHS) {
  try { chromium = require(p).chromium; break; } catch (e) { /* next */ }
}
if (!chromium) {
  console.error('找不到 playwright-core，请先安装或指定路径');
  process.exit(1);
}

const HEADFUL = process.argv.includes('--headful');
const WAIT_SEC = (function () {
  const i = process.argv.indexOf('--wait');
  return i >= 0 ? parseInt(process.argv[i + 1], 10) : 45;
})();
const PORT = 8848 + Math.floor(Math.random() * 500);
const OUT_DIR = path.join(__dirname, 'test-output');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];
const exePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  // 1. 起服务器
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js'), String(PORT)], {
    cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe']
  });
  let srvLog = '';
  srv.stdout.on('data', (d) => { srvLog += d.toString(); });
  srv.stderr.on('data', (d) => { srvLog += d.toString(); });
  await sleep(700);

  const url = `http://127.0.0.1:${PORT}/?verbose`;
  console.log('▶ 打开', url, '| Chrome:', exePath || '(bundled)');

  const browser = await chromium.launch({
    headless: !HEADFUL,
    executablePath: exePath,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-unsafe-swiftshader',
      '--use-gl=swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-webgl',
      '--disable-web-security',
      '--allow-file-access-from-files'
    ]
  });

  const ctx = await browser.newContext({
    viewport: { width: 900, height: 1000 },
    deviceScaleFactor: 1
  });
  const page = await ctx.newPage();

  const logs = [];
  const errors = [];
  page.on('console', (m) => {
    const t = m.type();
    const txt = m.text();
    logs.push({ type: t, text: txt });
    if (t === 'error' || t === 'warning') {
      console.log(`  [${t}] ${txt.slice(0, 300)}`);
    }
  });
  page.on('pageerror', (e) => {
    errors.push(e.message + '\n' + (e.stack || ''));
    console.log('  [pageerror]', e.message.slice(0, 400));
  });
  page.on('requestfailed', (r) => {
    console.log('  [reqfail]', r.url().slice(0, 140), r.failure() && r.failure().errorText);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) console.log('  [http' + r.status() + ']', r.url().slice(0, 160));
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  // 2. 点击开始
  console.log('▶ 点击「开始游戏」');
  await page.click('#start-btn').catch(() => {});

  // 3. 轮询状态
  const t0 = Date.now();
  let startedOk = false;
  let lastStatus = '';
  while ((Date.now() - t0) / 1000 < WAIT_SEC) {
    await sleep(1000);
    const st = await page.evaluate(() => {
      const s = document.getElementById('boot-status');
      const o = document.getElementById('boot-overlay');
      const f = document.getElementById('fatal-error');
      return {
        status: s ? s.textContent : '',
        overlayDisplay: o ? getComputedStyle(o).display : 'none',
        overlayOpacity: o ? getComputedStyle(o).opacity : '1',
        rafFrames: typeof window.__rafCount === 'number' ? window.__rafCount : null,
        hasModule: !!(window.GameGlobal && window.GameGlobal.Module && window.GameGlobal.Module.asm),
        fatal: f && f.style.display === 'block' ? f.textContent.slice(0, 600) : ''
      };
    }).catch((e) => ({ status: 'evaluate failed: ' + e.message }));

    if (st.status && st.status !== lastStatus) {
      console.log(`  (${((Date.now() - t0) / 1000).toFixed(0)}s) ${st.status}`);
      lastStatus = st.status;
    }
    if (st.fatal && st.fatal !== lastStatus) {
      console.log(`  ⚠️ fatal: ${st.fatal.replace(/\n/g, ' | ').slice(0, 400)}`);
      lastStatus = st.fatal;
    }
    // 判定依据：Unity wasm 已经实例化（Module.asm 存在），才算是真跑起来了
    if (st.hasModule) {
      startedOk = true;
      console.log(`✅ Unity 模块实例化完成 @ ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      // 关键：不要「等 4 秒就截」——Addressables 要加载 69 个 bundle，
      // 之后还要逐个解压 ASTC 纹理，整个过程可达 60s+。
      // 改成轮询采样，直到画面真的出现非黑像素（或超时）。
      let lastNonBlack = -1;
      const tRender = Date.now();
      while ((Date.now() - tRender) / 1000 < WAIT_SEC) {
        await sleep(2000);
        const p = await page.evaluate(() => {
          try {
            const c = document.querySelector('canvas');
            if (!c) return -1;
            const tmp = document.createElement('canvas');
            tmp.width = 48; tmp.height = 48;
            const g = tmp.getContext('2d');
            g.drawImage(c, 0, 0, 48, 48);
            const d = g.getImageData(0, 0, 48, 48).data;
            let nb = 0;
            for (let i = 0; i < d.length; i += 4) {
              if (d[i] > 8 || d[i + 1] > 8 || d[i + 2] > 8) nb++;
            }
            return nb / (48 * 48);
          } catch (e) { return -1; }
        });
        const el = ((Date.now() - tRender) / 1000).toFixed(0);
        if (p !== lastNonBlack) {
          console.log(`  (${el}s) 画面非黑像素比 ${p.toFixed(3)}`);
          lastNonBlack = p;
        }
        // 画面已经稳定出现内容 → 再多等 3 秒让动画稳定，然后截图
        if (p > 0.05) {
          console.log(`✅ 画面已渲染 @ +${el}s`);
          await sleep(3000);
          break;
        }
      }
      break;
    }
  }
  if (!startedOk) console.log('❌ 超时：Unity 模块未完成实例化');

  // 4. 采集运行时诊断
  const diag = await page.evaluate(() => {
    const out = {};
    try {
      const c = document.querySelector('canvas');
      out.canvas = c ? { w: c.width, h: c.height, cw: c.style.width, ch: c.style.height } : null;
      // 检查是否真渲染了内容
      if (c) {
        try {
          const tmp = document.createElement('canvas');
          tmp.width = 64; tmp.height = 64;
          const g = tmp.getContext('2d');
          g.drawImage(c, 0, 0, 64, 64);
          const d = g.getImageData(0, 0, 64, 64).data;
          let nonBlack = 0, sum = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i] > 8 || d[i + 1] > 8 || d[i + 2] > 8) nonBlack++;
            sum += d[i] + d[i + 1] + d[i + 2];
          }
          out.pixels = { nonBlackRatio: +(nonBlack / 4096).toFixed(3), avgBrightness: +(sum / 4096 / 3).toFixed(1) };
        } catch (e) { out.pixels = { err: e.message }; }
      }
      out.hasManager = !!(window.GameGlobal && window.GameGlobal.manager);
      out.hasModule = !!(window.GameGlobal && window.GameGlobal.Module);
      out.hasUnityNs = !!(window.GameGlobal && window.GameGlobal.unityNamespace);
      out.unityVersion = window.GameGlobal && window.GameGlobal.unityNamespace && window.GameGlobal.unityNamespace.unityVersion;
      out.rafFrames = typeof window.__rafCount === 'number' ? window.__rafCount : null;
      out.adStats = window.__wxShim ? window.__wxShim.stats : null;
      out.modulesRegistered = window.__wxLoader ? Object.keys(window.__wxLoader.defs).length : 0;
      out.modulesExecuted = window.__wxLoader ? Object.keys(window.__wxLoader.cache).length : 0;
      out.fatalText = (function () {
        const f = document.getElementById('fatal-error');
        return f && f.style.display === 'block' ? f.textContent.slice(0, 2000) : '';
      })();
    } catch (e) { out.err = e.message; }
    return out;
  });

  console.log('\n===== 诊断 =====');
  console.log(JSON.stringify(diag, null, 2));

  await page.screenshot({ path: path.join(OUT_DIR, 'shot-final.png') });

  // 5. 输出日志摘要
  const logFile = path.join(OUT_DIR, 'console.log');
  fs.writeFileSync(logFile, logs.map((l) => `[${l.type}] ${l.text}`).join('\n'), 'utf8');
  console.log(`\n完整 console 日志: ${logFile} (${logs.length} 条)`);
  if (errors.length) {
    console.log('\n===== 未捕获异常 =====');
    errors.slice(0, 10).forEach((e, i) => console.log(`#${i + 1}: ${e.slice(0, 900)}\n`));
  }

  await browser.close();
  srv.kill();
  console.log('\n结果:', startedOk ? '✅ 启动成功' : '❌ 未能启动');
  process.exit(startedOk ? 0 : 2);
})().catch((e) => {
  console.error('测试脚本崩溃:', e);
  process.exit(3);
});
