/*
 * unity-data-hook.js —— Unity 运行时与本地资源的桥接层
 * ---------------------------------------------------------------
 * 原始微信构建里，Unity 的 .data 文件是通过 wx.getFileSystemManager() +
 * 自研 Loader（plugin 里的 Wo/xo 模块）喂给运行时，数据包还被自定义压缩过。
 *
 * 在浏览器里我们直接绕开这套机制：
 *   - Module.getPreloadedPackage / preRun 覆盖：
 *       拦截 Unity 的「数据包加载」步骤，改为 fetch 本地 .data.unityweb
 *       并解出 UnityWebData1.0 容器中的 data.unity3d，写进 Unity 的虚拟 FS。
 *
 * UnityWebData1.0 格式（本游戏实测）：
 *   0..14   "UnityWebData1.0"（15 字节，无结尾 \0）
 *   15      0x00
 *   16..19  headerLen (u32 BE) = 240
 *   20..23  dataLen   (u32 BE) = 240      —— 头部其实也记在 headerLen 里
 *   从 24 起是文件表项，每项：
 *       24..27  id       (u32 BE)
 *       28..31  nameLen  (u32 BE)
 *       32..    name     (nameLen 字节，UTF-8)
 *                offset   (u32 BE)  —— 相对 headerLen
 *                size     (u32 BE)
 *   条目一直排到 offset == headerLen 为止。
 */
(function () {
  'use strict';

  var V = (location.search.indexOf('verbose') >= 0) || localStorage.getItem('wxshim.verbose') === '1';
  function log() {
    if (!V) return;
    console.log.apply(console, ['%c[unity-hook]', 'color:#fa8c16;font-weight:bold'].concat(Array.prototype.slice.call(arguments)));
  }
  function logAlways() {
    console.log.apply(console, ['%c[unity-hook]', 'color:#fa8c16;font-weight:bold'].concat(Array.prototype.slice.call(arguments)));
  }

  var G = window.GameGlobal || (window.GameGlobal = {});
  var ASSET_ROOT = (function () {
    var m = location.search.match(/[?&]assets=([^&]+)/);
    var r = m ? decodeURIComponent(m[1]) : 'assets/';
    return r.slice(-1) === '/' ? r : r + '/';
  })();

  var DATA_FILE = '3e69ea94faae18bb.webgl.data.unityweb.bin';   // 22 MB
  var WASM_FILE = 'wasmcode_decompressed.wasm';                  // 23 MB（完整 wasm）
  var WASM_FILE_ALT = 'wasmcode1_decompressed.wasm';             // 38 MB（另一套纹理压缩变体）
  // wasm 缓存戳：wasm 在 /assets/ 下有 7 天长缓存，每次改了 wasm 必须 bump
  // 这个版本号（拼成 ?v= 查询参数改变缓存键），否则用户会一直命中旧缓存。
  // 20261018a：修正补丁索引偏移 + 重打联赛引导补丁
  var WASM_VER = '20261018a';

  // ---------------------------------------------------------------------
  // Buffer 缓存：同一个游戏实例内只下载 / 解析一次
  // ---------------------------------------------------------------------
  var dataPromise = null;
  var wasmPromise = null;

  function fetchBuffer(url) {
    log('fetch', url);
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
      var total = parseInt(r.headers.get('content-length') || '0', 10);
      if (!r.body || !r.body.getReader) return r.arrayBuffer();
      // 带进度的手动流式读取（大文件体验更好）
      var reader = r.body.getReader();
      var chunks = [];
      var loaded = 0;
      return (function pump() {
        return reader.read().then(function (res) {
          if (res.done) {
            var out = new Uint8Array(loaded);
            var off = 0;
            chunks.forEach(function (c) { out.set(c, off); off += c.length; });
            return out.buffer;
          }
          chunks.push(res.value);
          loaded += res.value.length;
          if (total) updateProgress(loaded / total, url);
          return pump();
        });
      })();
    });
  }

  var progressEl = null;
  function updateProgress(ratio, label) {
    if (!progressEl) progressEl = document.getElementById('boot-progress-inner');
    if (progressEl) progressEl.style.width = Math.min(100, Math.round(ratio * 100)) + '%';
    var t = document.getElementById('boot-status');
    if (t && label) t.textContent = '加载资源 ' + Math.round(ratio * 100) + '%  ·  ' + label.split('/').pop();
  }

  function getDataBuffer() {
    if (!dataPromise) dataPromise = fetchBuffer(ASSET_ROOT + DATA_FILE);
    return dataPromise;
  }
  // 异步预取到的 wasm 缓存（Uint8Array）。
  // 目的：尽量不在主线程上跑「同步 XHR + 23MB 逐字节转换」。
  // 若 prefetch 先完成，install() 直接用这份，省掉数秒阻塞。
  var wasmAsyncCache = null;
  function getWasmBuffer() {
    if (!wasmPromise) {
      wasmPromise = fetchBuffer(ASSET_ROOT + WASM_FILE + '?v=' + WASM_VER).catch(function (e) {
        console.warn('[unity-hook] 主 wasm 加载失败，尝试备用:', e.message);
        return fetchBuffer(ASSET_ROOT + WASM_FILE_ALT);
      }).then(function (buf) {
        wasmAsyncCache = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        return wasmAsyncCache;
      });
    }
    return wasmPromise;
  }

  // ---------------------------------------------------------------------
  // UnityWebData1.0 解析
  // ---------------------------------------------------------------------
  /*
   * 容器格式（全部小端 u32）：
   *   [0..15]  "UnityWebData1.0\0"   （15 字节 magic + 1 字节 \0）
   *   [16]     headerLen             ← 文件表 + 头部本身的总长度
   *   [20..]   文件表，每条：
   *              u32 offset   （相对数据区起点，即相对 headerLen）
   *              u32 size
   *              u32 nameLen
   *              utf8 name (nameLen 字节)
   *   数据区从 headerLen 开始。
   *
   * 实测本游戏 6 条：
   *   240 4930578  data.unity3d
   *   4930818 23888  RuntimeInitializeOnLoads.json
   *   4954706 7002   ScriptingAssemblies.json
   *   4961708 93     boot.config
   *   4961801 16653296 Il2CppData/Metadata/global-metadata.dat
   *   21615097 613728 Resources/unity_default_resources
   */
  function parseUnityWebData(buf) {
    var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var magic = '';
    for (var i = 0; i < 15; i++) magic += String.fromCharCode(bytes[i]);
    if (magic !== 'UnityWebData1.0') {
      throw new Error('不是 UnityWebData1.0 容器，实际 magic = "' + magic + '"');
    }
    var ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    var dv = new DataView(ab);
    var pos = 16;
    var headerLen = dv.getUint32(pos, true); pos += 4;   // ← 小端
    var entries = [];
    while (pos + 12 <= headerLen) {
      var offset = dv.getUint32(pos, true); pos += 4;    // ← 先 offset
      var size = dv.getUint32(pos, true); pos += 4;      // ← 再 size
      var nameLen = dv.getUint32(pos, true); pos += 4;   // ← 再 nameLen
      if (nameLen === 0 || nameLen > 4096 || pos + nameLen > headerLen) break;
      var nameBytes = bytes.subarray(pos, pos + nameLen); pos += nameLen;
      var name = '';
      for (var j = 0; j < nameBytes.length; j++) name += String.fromCharCode(nameBytes[j]);
      try { name = decodeURIComponent(escape(name)); } catch (e) {}
      entries.push({
        name: name,
        offset: offset,
        size: size,
        // ⚠️ 实测确认：这个 offset 字段是【相对整个文件的绝对偏移】，
        //   不要再加 headerLen。证据（本游戏真实数据）：
        //     data.unity3d                 offset=240       → 该处正是 "UnityFS" magic
        //     RuntimeInitializeOnLoads.json offset=4930818  → 该处正是 '{"root":'
        //     ScriptingAssemblies.json      offset=4954706  → 该处正是 '{"names"'
        //     boot.config                  offset=4961708  → 该处正是 'wait-for'
        //     global-metadata.dat          offset=4961801  → 该处正是 0xFAB11BAF (魔数)
        //   之前误加 headerLen 导致所有文件整体错位 240 字节，
        //   IL2CPP 读到坏元数据 → main() 里 memory access out of bounds。
        absOffset: offset
      });
      if (entries.length > 10000) break;
    }
    logAlways('UnityWebData 解析完成：headerLen=' + headerLen +
      '，条目数=' + entries.length +
      '，首个=' + (entries[0] ? entries[0].name + '(' + entries[0].size + 'B)' : '无'));
    return { headerLen: headerLen, entries: entries, bytes: bytes };
  }

  // ---------------------------------------------------------------------
  // 把 data.unity3d 写进 Unity 的 MEMFS
  // ---------------------------------------------------------------------
  /*
   * ⚠️ 关键时序：Module.FS 在 preRun 阶段【还没有】被创建。
   *   Emscripten 的 preRun 是在 FS 初始化之前跑的，所以这时写文件必然失败。
   *
   * 但 framework 里把 FS 挂到了
   *     GameGlobal.unityNamespace.FS = { root, mounts, ..., writeFile(), mkdir() ... }
   * 也就是 Emscripten 的原生 FS 对象（记作 nI）。
   * unityNamespace 在 framework 模块加载时就创建好了，比 preRun 早得多，
   * 所以从这里能稳定拿到 FS。
   */
  function getFS(Module) {
    if (Module.FS && Module.FS.writeFile) return Module.FS;
    var ns = (window.GameGlobal && window.GameGlobal.unityNamespace);
    if (ns && ns.FS && ns.FS.writeFile) return ns.FS;
    if (typeof FS !== 'undefined' && FS && FS.writeFile) return FS;
    return null;
  }

  function writeIntoFS(Module, path, bytes) {
    var FSobj = getFS(Module);
    if (!FSobj) { log('FS 还不可用，跳过:', path); return false; }
    try {
      // 展开父目录
      var parts = path.split('/').filter(Boolean);
      var cur = '';
      for (var i = 0; i < parts.length - 1; i++) {
        cur += '/' + parts[i];
        try { FSobj.mkdir(cur); } catch (e) { /* 已存在 */ }
      }
      try { FSobj.unlink(path); } catch (e) {}
      FSobj.writeFile(path, bytes);
      log('FS 写入成功:', path, bytes.length, 'bytes');
      return true;
    } catch (e) {
      console.error('[unity-hook] FS 写入失败:', path, e);
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // 安装到 Unity Module 上的钩子
  // ---------------------------------------------------------------------
  var installed = false;

  function install(Module) {
    if (installed || !Module) return;
    installed = true;

    var isWx = true;

    // --- 1) 拦截 wasm 二进制：直接给 ArrayBuffer，跳过一切定位逻辑 ---
    // ⚠️ Emscripten 认的字段名是 wasmBinary（不是 wasmBin）：
    //     framework 里写着   j.wasmBinary && (y = j.wasmBinary);
    //   这里两个都设，兼容不同调用点。
    //
    // ⚠️ 时序：UnityModule 一被调用就会同步走到 WebAssembly.instantiate，
    //    异步 fetch 来不及。所以先用同步 XHR 把 wasm 读进来（只在启动阶段一次）。
    var syncWasm = wasmAsyncCache || getWasmBufferSync();
    if (syncWasm) {
      Module.wasmBinary = syncWasm;
      Module.wasmBin = syncWasm;
      logAlways('wasm 就绪（同步）：' + Math.round(syncWasm.byteLength / 1048576) + ' MB');
    } else {
      // 同步读取失败再退回异步（可能已由 prefetch 缓存，promise 会立刻 resolve）
      getWasmBuffer().then(function (buf) {
        var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        Module.wasmBinary = u8;
        Module.wasmBin = u8;
        logAlways('wasm 就绪（异步）：' + Math.round(u8.byteLength / 1048576) + ' MB');
      });
    }

    // --- 2) 拦截 preloaded package（Unity 的 .data 加载入口）---
    Module.getPreloadedPackage = function (remotePackageName, remotePackageSize) {
      log('getPreloadedPackage 被调用:', remotePackageName, remotePackageSize);
      // 必须同步返回 ArrayBuffer —— Unity 在这里期待同步
      var cached = getDataBufferSync();
      if (!cached) {
        console.error('[unity-hook] 数据包尚未就绪，getPreloadedPackage 失败');
        return new ArrayBuffer(0);
      }
      return cached;
    };

    // --- 3) 在 main 之前把 data 包内的所有条目放进虚拟 FS ---
    //
    // ⚠️ 时机选择（踩过的坑）：
    //   · preRun 阶段太早 —— MEMFS 根目录是在 run()（aS）里才 mount 的
    //     （nU.root=nI.mount(nU,{},null)），mount 会用全新目录覆盖 root，
    //     preRun 里写的文件全部被"雪藏"，main 一读就 OOB。
    //   · onRuntimeInitialized 恰好介于 mount 完成与 _main() 之间：
    //       aS:  FS.init → mount 根 → iM(ctors) → a(j) → onRuntimeInitialized() → _main()
    //     所以在这里写文件既保证了 FS 可用，又赶在 main 之前。
    //
    // 注意：不只是 data.unity3d。IL2CPP 运行时还需要
    //   Il2CppData/Metadata/global-metadata.dat   ← 缺了会直接崩（没有类元数据）
    //   boot.config / ScriptingAssemblies.json / Resources/unity_default_resources
    // 微信版 Unity 是把整个 UnityWebData 解到 / 下的，我们也照做。
    function writeDataEntries() {
      try {
        var info = parseUnityWebData(getDataBufferSync());
        var count = 0;
        info.entries.forEach(function (e) {
          if (!e.name || e.size <= 0) return;
          var slice = info.bytes.subarray(e.absOffset, e.absOffset + e.size);
          // UnityWebData 里的名字已经是相对根的路径，直接写到 / 下
          var p = '/' + e.name.replace(/^\/+/, '');
          if (writeIntoFS(Module, p, slice)) count++;
        });
        logAlways('data 包写入 FS：' + count + '/' + info.entries.length + ' 条');
        window.__unityDataReady = true;
      } catch (e) {
        console.error('[unity-hook] 数据包预处理失败:', e);
      }
    }

    var origORI = Module.onRuntimeInitialized;
    Module.onRuntimeInitialized = function () {
      writeDataEntries();
      if (typeof origORI === 'function') {
        try { origORI.apply(this, arguments); } catch (e) { console.error('[unity-hook] origORI 异常', e); }
      }
    };

    // --- 4) 告诉 Unity 去哪里找文件（全部本地化）---
    var origLocateFile = Module.locateFile;
    Module.locateFile = function (path, prefix) {
      log('locateFile:', path, '| prefix =', prefix);
      // wasm：交给 wasmBin
      if (/\.wasm(\.br)?$/i.test(path)) return ASSET_ROOT + path;
      // data：交给 getPreloadedPackage
      if (/\.data(\.unityweb)?$/i.test(path)) return ASSET_ROOT + path;
      if (/\.data\.unityweb$/i.test(path)) return ASSET_ROOT + DATA_FILE;
      // 其它（bundle / 字体 / json）走 StreamingAssets
      if (origLocateFile) {
        try { return origLocateFile(path, prefix); } catch (e) {}
      }
      return (prefix || '') + path;
    };

    // --- 5) 数据包 URL：关闭 Unity 自己的下载逻辑 ---
    Module.dataUrl = ASSET_ROOT + DATA_FILE;

    log('hooks installed');
  }

  // 同步取 wasm（只在启动阶段调用一次；23MB，本地 HTTP 很快）
  //
  // ⚠️ 坑：Chrome 明确禁止对【同步】XHR 设置 responseType（除空串/"text"），
  //   赋值 responseType='arraybuffer' 会直接抛
  //   "The response type cannot be changed for synchronous requests"。
  //   所以同步模式下只能拿字符串再手工转字节：
  //   给请求加 overrideMimeType('text/plain; charset=x-user-defined')，
  //   之后 responseText 里每个字符就是 0..255 的一个字节（x-user-defined 编码），
  //   用 charCodeAt & 0xff 即可还原。23MB 循环约 50~150ms，只在启动时跑一次。
  function xhrSyncBinary(url) {
    var x = new XMLHttpRequest();
    try { x.overrideMimeType('text/plain; charset=x-user-defined'); } catch (e) {}
    x.open('GET', url, false);
    x.send(null);
    if (!(x.status >= 200 && x.status < 300 || x.status === 0)) return null;
    var txt = x.responseText;
    if (!txt || !txt.length) return null;
    var len = txt.length;
    var out = new Uint8Array(len);
    for (var i = 0; i < len; i++) out[i] = txt.charCodeAt(i) & 0xff;
    return out;
  }

  var wasmSync = null, wasmSyncTried = false;
  function getWasmBufferSync() {
    if (wasmSyncTried) return wasmSync;
    wasmSyncTried = true;
    var files = [WASM_FILE + '?v=' + WASM_VER, WASM_FILE_ALT];
    for (var i = 0; i < files.length; i++) {
      try {
        var buf = xhrSyncBinary(ASSET_ROOT + files[i]);
        if (buf && buf.length > 8) {
          // 顺带校验一下 magic（\0asm）便于尽早发现指错文件
          var magicOK = buf[0] === 0x00 && buf[1] === 0x61 && buf[2] === 0x73 && buf[3] === 0x6d;
          if (!magicOK) {
            console.warn('[unity-hook] wasm 同步读取到非 wasm 文件:', files[i]);
            continue;
          }
          wasmSync = buf;
          logAlways('wasm 同步读取 OK：' + Math.round(wasmSync.byteLength / 1048576) + ' MB (' + files[i] + ')');
          return wasmSync;
        }
      } catch (e) {
        console.warn('[unity-hook] wasm 同步读取失败:', files[i], e && e.message);
      }
    }
    return null;
  }

  // 同步取数据（用同步 XHR，只在 preRun 阶段调用一次）
  // 同 wasm：同步 XHR 不能设 responseType，走 x-user-defined 手工转字节。
  var dataSync = null;
  function getDataBufferSync() {
    if (dataSync) return dataSync;
    try {
      var buf = xhrSyncBinary(ASSET_ROOT + DATA_FILE);
      if (buf && buf.length > 0) {
        dataSync = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        logAlways('data 同步读取 OK：' + Math.round(dataSync.byteLength / 1048576) + ' MB');
      }
    } catch (e) {
      console.error('[unity-hook] data 同步读取失败:', e);
    }
    return dataSync;
  }

  // 预取（页面空闲时先拉数据，缩短等待）
  function prefetch() {
    getDataBuffer().catch(function (e) { console.warn('data prefetch failed', e); });
    getWasmBuffer().catch(function (e) { console.warn('wasm prefetch failed', e); });
  }

  window.__unityHook = {
    install: install,
    prefetch: prefetch,
    parseUnityWebData: parseUnityWebData,
    getDataBuffer: getDataBuffer,
    getWasmBuffer: getWasmBuffer,
    files: { data: DATA_FILE, wasm: WASM_FILE, wasmAlt: WASM_FILE_ALT }
  };

  logAlways('ready · data=' + DATA_FILE + ' · wasm=' + WASM_FILE);
})();
