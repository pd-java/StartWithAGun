#!/usr/bin/env node
/*
 * server.js —— 零依赖本地静态服务器
 * ---------------------------------------------------------------
 * 为什么不能直接双击 index.html：
 *   - Unity 需要用 fetch / XHR 读取 20MB 级别的 wasm 与 data，
 *     file:// 协议下会被 CORS 与「同步 XHR」双重限制直接拒绝。
 *   - 浏览器要求 wasm 的 MIME 是 application/wasm 才会走流式编译。
 *   - SharedArrayBuffer / 音频 / 全屏 都要求安全上下文（localhost 算安全）。
 *
 * 用法：
 *   node server.js            # 默认 http://127.0.0.1:8848
 *   node server.js 9000       # 指定端口
 *   node server.js 9000 --open  # 启动后自动打开浏览器
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = __dirname;
const PORT = parseInt(process.argv[2], 10) || 8848;
const AUTO_OPEN = process.argv.includes('--open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.br': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.unityweb': 'application/octet-stream',
  '.data': 'application/octet-stream',
  '.bundle': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  if (MIME[ext]) return MIME[ext];
  // xxx.wasm.br / xxx.unityweb.bin 这类复合后缀
  if (/\.wasm(\.br)?$/i.test(file)) return 'application/wasm';
  return 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  } catch (e) {
    res.writeHead(400); res.end('bad url'); return;
  }
  if (urlPath === '/') urlPath = '/index.html';

  // 防目录穿越
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('forbidden'); return;
  }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + urlPath);
      return;
    }

    const isAsset = /\/assets\//.test(urlPath);   // 大资源（bundle/wasm）长缓存，脚本短缓存
    const headers = {
      'Content-Type': contentType(filePath),
      'Cache-Control': isAsset ? 'public, max-age=604800' : 'no-cache',
      'Last-Modified': st.mtime.toUTCString(),
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Accept-Ranges': 'bytes'
    };

    // Range 支持（Unity 加载 bundle 时会用）
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
        if (start >= st.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
          res.end();
          return;
        }
        end = Math.min(end, st.size - 1);
        headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
        headers['Content-Length'] = end - start + 1;
        res.writeHead(206, headers);
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }

    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(filePath).pipe(res);
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  ❌ 端口 ${PORT} 已被占用。换一个端口：node server.js ${PORT + 1}\n`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║   开局带把枪 (SniperSiege) · 本地离线版             ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`   请在浏览器打开：  ${url}`);
  console.log(`   详细日志模式：    ${url}?verbose`);
  console.log(`   调试面板：        ${url}?debug`);
  console.log('');
  console.log('   Ctrl+C 停止服务');
  console.log('');

  if (AUTO_OPEN) {
    const cmd = process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});

process.on('SIGINT', () => {
  console.log('\n  服务已停止。\n');
  process.exit(0);
});
