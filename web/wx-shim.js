/*
 * wx-shim.js —— 微信小游戏 API 在浏览器中的等价实现
 * ---------------------------------------------------------------
 * 目标：让 <wechat>/minigame 环境下的 Unity WebGL 产物在普通浏览器里跑起来。
 *
 * 设计原则：
 *   1. 所有资源都从同源静态目录读取（fetch / 同步 XHR），做到完全离线。
 *   2. 广告类 API（激励视频 / 插屏 / banner / 格子）全部 mock 成「立即播放成功」，
 *      从而【直接跳过看广告解锁】的节点。
 *   3. 微信私有能力（云开发、蓝牙、设备方向、聊天、直播、录像、开放数据域）
 *      提供安全空实现，避免运行时报错中断主循环。
 *   4. 平台伪装成 "devtools"，让 weapp-adapter 走 Object.defineProperty 分支，
 *      把 canvas/document/navigator 直接注入 window，Unity 运行时无需改动。
 */
(function () {
  'use strict';

  var LOG_PREFIX = '[wx-shim]';
  var VERBOSE = (location.search.indexOf('verbose') >= 0) || localStorage.getItem('wxshim.verbose') === '1';

  // 诊断环形缓冲：无论是否 verbose 都记录，供 F9 / debug 面板导出。
  // ⚠️ Unity 自身的 Debug.Log 也会打到 console，400 行很容易被冲掉，
  //    所以：① 主环加大 ② 另设「错误环」只收 error/warn/异常，永不被刷掉。
  var LOG_RING = [];
  var ERR_RING = [];
  var BOOT_T0 = Date.now();
  function stamp() {
    var d = Date.now() - BOOT_T0;
    return (d / 1000).toFixed(1) + 's';
  }
  function ringPush(line) {
    try {
      var s = '[' + stamp() + '] ' + line;
      LOG_RING.push(s);
      if (LOG_RING.length > 3000) LOG_RING.splice(0, LOG_RING.length - 3000);
      if (/^\[(\d+\.\d+s)\] \[(error|window\.error|unhandledrejection|stall)/.test(s) ||
          /Exception|NullReference|ArgumentNull|wasm-function|RuntimeError|abort/i.test(s)) {
        ERR_RING.push(s);
        if (ERR_RING.length > 200) ERR_RING.splice(0, ERR_RING.length - 200);
      }
    } catch (e) { /* ignore */ }
  }
  window.__wxShimLogDump = function () {
    try {
      var head = [
        '=== wx-shim 诊断日志 ===',
        'time: ' + new Date().toISOString(),
        'url: ' + location.href,
        'ua: ' + navigator.userAgent,
        'canvas: ' + (function () {
          var c = document.querySelector('canvas');
          return c ? (c.width + 'x' + c.height + ' css ' + c.clientWidth + 'x' + c.clientHeight) : 'none';
        })(),
        'stalls: ' + (window.__frameStalls || []).join(', '),
        ''
      ].join('\n');
      var errPart = ERR_RING.length ? ('=== 错误/停顿（优先看） ===\n' + ERR_RING.join('\n') + '\n\n') : '=== 错误/停顿 ===\n(无)\n\n';
      var tail = LOG_RING.slice(-400).join('\n');
      return head + errPart + '=== 最近日志 ===\n' + tail;
    } catch (e) { return ''; }
  };
  // 主线程停顿探测：rAF 间隔大幅超时说明 JS/wasm 被长时间阻塞（区别于「逻辑等待」）
  window.__frameStalls = [];
  (function watchStall() {
    var last = performance.now();
    var nativeRaf = window.requestAnimationFrame.bind(window);
    (function tick() {
      nativeRaf(function (t) {
        var gap = t - last;
        last = t;
        if (gap > 1200) {
          var rec = Math.round(gap) + 'ms@' + stamp();
          window.__frameStalls.push(rec);
          if (window.__frameStalls.length > 20) window.__frameStalls.shift();
          ringPush('[stall] 主线程停顿 ' + rec);
        }
        tick();
      });
    })();
  })();
  // F9：导出诊断日志（复制到剪贴板，失败则弹框）
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'F9') return;
    e.preventDefault();
    var dump = window.__wxShimLogDump();
    var tip = function () { console.log('%c[wx-shim] 诊断日志已导出', 'color:#07C160;font-weight:bold'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(dump).then(tip).catch(function () { prompt('请手动复制（Ctrl+A）:', dump); });
    } else {
      prompt('请手动复制（Ctrl+A）:', dump);
    }
  });
  // 捕获页面所有 console 输出与未捕获异常（浅拷贝参数，避免引用膨胀）
  (function installRing() {
    var orig = {};
    ['log', 'info', 'warn', 'error'].forEach(function (m) {
      orig[m] = console[m] ? console[m].bind(console) : function () {};
    });
    ['log', 'info', 'warn', 'error'].forEach(function (m) {
      console[m] = function () {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
          var v = arguments[i];
          try { parts.push(typeof v === 'string' ? v : JSON.stringify(v)); }
          catch (e) { parts.push(String(v)); }
        }
        ringPush('[' + m + '] ' + parts.join(' ').slice(0, 500));
        orig[m].apply(null, arguments);
      };
    });
    window.addEventListener('error', function (ev) {
      ringPush('[window.error] ' + (ev.message || '') + ' @ ' + (ev.filename || '') + ':' + (ev.lineno || 0));
    });
    window.addEventListener('unhandledrejection', function (ev) {
      var r = ev.reason;
      ringPush('[unhandledrejection] ' + (r && r.message ? r.message : String(r)));
    });
  })();

  function log() {
    if (!VERBOSE) return;
    var a = ['%c' + LOG_PREFIX, 'color:#07C160;font-weight:bold'];
    for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
    console.log.apply(console, a);
  }
  function logAlways() {
    var a = ['%c' + LOG_PREFIX, 'color:#07C160;font-weight:bold'];
    for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
    console.log.apply(console, a);
  }

  // ---------------------------------------------------------------------
  // 0. 基础环境
  // ---------------------------------------------------------------------
  // ⚠️ 先抓原生的 rAF / setTimeout 引用：后面 unity-shim.js 会覆盖
  // window.requestAnimationFrame，如果不提前保存就会自我递归。
  var NATIVE = {
    raf: window.requestAnimationFrame.bind(window),
    caf: window.cancelAnimationFrame.bind(window),
    setTimeout: window.setTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    clearInterval: window.clearInterval.bind(window),
    fetch: window.fetch ? window.fetch.bind(window) : null,
    XHR: window.XMLHttpRequest
  };

  // ---------------------------------------------------------------------
  // 0.1 离线网络层 —— 让所有「外网」请求直接返回合法空响应
  // ---------------------------------------------------------------------
  //
  // 为什么必须做这件事：
  //   原版游戏跑在微信里，所有远端请求（RemoteConfig / 埋点 / 广告 SDK /
  //   热更清单）都是可达的。搬到离线浏览器后，这些请求必然失败，而且是
  //   【两种不同的失败形态】：
  //     · 浏览器 CORS 拦截  → fetch 直接 reject（request:fail）
  //     · 目标服务器 400/500 → onerror 带着 statusCode 回调
  //   Unity 的托管层（System.Net / UnityWebRequest）对「失败」路径的处理
  //   与「成功但内容为空」完全不同：失败路径下 response 流为 null，
  //   上层的 JsonUtility / 反序列化逻辑拿着空引用继续走，
  //   最终在 wasm 堆里越界 —— 这正是
  //     RuntimeError: memory access out of bounds
  //     at j92815 ← j92611 ← ... （崩溃前最后 3 次 env 调用全是
  //     JS_WebRequest_GetResponseMetaDataLengths / MetaData / Release）
  //   的成因。
  //
  // 解法：
  //   在 window 层包住 fetch 与 XMLHttpRequest。
  //   · 同源请求（本地 assets/server）→ 原样直通，绝不干扰游戏自身的资源加载
  //   · 跨域请求 → 立即返回一个 200 + 空 body 的合法响应，
  //     让 Unity 走「成功拿到空数据」这条它本来就能正确处理的分支
  //
  //   这不是在"伪造游戏逻辑"，而是把「网络不可达」这个物理事实
  //   翻译成 Unity 能安全消化的表达形式 —— 离线版本来就该没有远端数据。
  var OFFLINE_NET = { enabled: true, blocked: 0, passed: 0 };

  function isSameOrigin(url) {
    try {
      var u = new URL(url, location.href);
      return u.origin === location.origin;
    } catch (e) {
      // 相对路径 / 无法解析 → 当作同源
      return true;
    }
  }

  function offlineResponse(url) {
    // settings/catalog → 本地 JSON；aa/WebGL/*.bundle → 本地二进制；其余 → 结构正确的空 JSON
    return offlineBodyAsync(url || '').then(function (res) {
      var isBundle = res.kind === 'bundle';
      var len = isBundle ? res.body.byteLength : new TextEncoder().encode(res.body).byteLength;
      return new Response(isBundle ? res.body : String(res.body), {
        status: 200,
        statusText: 'OK',
        headers: {
          'Content-Type': isBundle ? 'application/octet-stream' : 'application/json',
          'Content-Length': String(len),
          'X-Offline-Shim': '1'
        }
      });
    });
  }

  // ---------------------------------------------------------------------
  // 0.2 离线响应体 —— 按 URL 返回「语义正确」的合法内容
  // ---------------------------------------------------------------------
  //
  // ⚠️ 为什么不能统一返回空字符串：
  //   空 body 到了 C# 侧会变成 null，于是：
  //     System.IO.StringReader..ctor(String s)  → ArgumentNullException
  //     GravitySDK...GlobalCheck()              → ArgumentException
  //   这两个异常在 wasm-split 双包环境下展开时，
  //   会踩坏 IL2CPP 的异常链状态，最终：
  //     RuntimeError: memory access out of bounds
  //     at j92815 (StringBuilder/字符串路径)
  //
  //   所以离线层必须按请求类型给出【结构正确】的空数据：
  //     · JSON 配置类    → 一个合法 JSON 对象（可带关键字段）
  //     · 埋点/上报类    → {} 或简单成功回执
  //     · 图片/二进制    → 空字节
  //   Unity 拿到合法 JSON 就会走正常反序列化分支，不抛异常。
  var OFFLINE_JSON_MAP = [
    // RemoteConfig：直接用从 CDN 抓下来的【真实配置原文】，
    // 保证 C# 反序列化时每个字段的形状都和线上环境一致。
    {
      test: /RemoteConfig/i,
      body: {"appId":"wx97389648b73dfeca","appName":"开局带把枪","fallbackAppVersion":"","reviewAppVersion":"","isUnderReview":false,"disableDebuggingFeatures":true,"forceLogin":false,"forceLoadRemote":false,"autoRetryCount":3,"adIdConfig":{"interstitialAdId":"adunit-8329c8ff26e09bb9","bannerId":"","rewardedVideoAdIds":["adunit-2a859f2508e2b6cf"],"rewardedVideoAdConfigs":[{"adUnitId":"adunit-2a859f2508e2b6cf","label":"video-1"}],"customAdIds":[]},"bannerAdDelay":0,"customAdDelay":0,"logLevel":0,"enableAliyunTrack":true,"enableGravityTrack":true,"offerId":"","paymentImageUrl":"","exchangeRate":100,"trackRate":1,"enableClientTracking":true,"enableStarkMiniPayTrack":true,"corpId":"","customerServiceUrl":"","forceTrueShare":false,"pullBackDelay":0,"shareTemplateIds":[],"shareTitles":["逃出生天，荒岛探秘！","末世求生，尸潮危机！"],"shareImageUrls":["https://voodoo.ali.landintheair.com/ShareImage/RageSwarm/1.jpg"],"gravity":{"accessToken":"gfc7oN2nzvQMeqJdgi8eV4WkRlxwUcZH","autoTrack":true,"debug":false},"customData":[{"key":"EnableTencentAdSDK","value":"true"},{"key":"EnableDirectCompleteButton","value":"false"}],"name":"RemoteConfig","hideFlags":0,"CdnUrl":"https://voodoo.ali.landintheair.com/RemoteConfig/wx97389648b73dfeca.json","projectGroup":"Voodoo"}
    },
    // miniGameNoAdConfig：真实接口当前返回 500，这里给一个结构正确的空结果
    {
      test: /miniGameNoAdConfig/i,
      body: { errCode: 0, errMsg: 'ok', data: null }
    },
    // openid 换取接口：SI 期望 {errCode,errMsg,data:{openId,sessionKey}} 结构
    {
      test: /\/openid\/wx|openid\//i,
      body: { errCode: 0, errMsg: 'ok', data: { openId: 'offline-user-0001', sessionKey: 'offline-sk', unionId: '' } }
    },
    // Addressables 的 settings / catalog（已抓取到本地 web/assets/StreamingAssets/aa/）
    {
      test: /StreamingAssets\/aa\/(settings|catalog)\.json/i,
      local: '/assets/StreamingAssets/aa/$1.json'
    },
    // -----------------------------------------------------------------
    // @dn-sdk/minigame（腾讯数据上报 SDK）
    //   它的 Go 后端统一返回 { code, msg, data, success }，
    //   SDK 内部直接反序列化成 Dictionary 后取 dict["msg"]。
    //   之前给 {} 就会抛：
    //     KeyNotFoundException: The given key 'msg' was not present in the dictionary
    //   这几个配置接口必须给完整信封。
    // -----------------------------------------------------------------
    {
      test: /data-nexus-config\/v1\/sdk\/config\/get/i,
      body: { code: 0, msg: 'success', success: true, data: { enable: false, config: {} } }
    },
    {
      test: /data-nexus-config\/v1\/sdk\/minigame\/get/i,
      body: { code: 0, msg: 'success', success: true, data: { enable: false } }
    },
    {
      test: /data-nexus-trace\/log|data-nexus-cgi\/miniprogram|logstores\/log\/track/i,
      body: { code: 0, msg: 'success', success: true, data: null }
    },
    // GravityEngine initialize：同样要 {code,msg,data,success} 信封
    {
      test: /gravity-engine\.com/i,
      body: { code: 0, msg: 'success', success: true, data: { client_id: 'offline-user-0001', is_new: 1 } }
    },
    // -----------------------------------------------------------------
    // 云存档（CloudGameData / TencentAd.*）不做 JSON 兜底！
    //   真实服务是火山 TOS 对象存储（ss.landintheair.com/storage/...）：
    //     GET  不存在 → 404 + {"Code":"NoSuchKey",...}   → 游戏走「新用户」
    //     GET  存在   → 200 + 文件原文
    //     PUT         → 200（保存）
    //   之前给 200 + "{}" 是错的：游戏会认为「云存档加载成功但为空」，
    //   每次会话引导完成标记全部重置 —— 联赛解锁引导与战斗引导
    //   同时弹出（用户实测 bug）。正确做法见下方 CLOUD_STORE 仿真。
    // -----------------------------------------------------------------
    // 阿里云 / 腾讯埋点：一律成功回执
    {
      test: /aliyuncs\.com|log\.aliyun|sentry|bugly|beacon/i,
      body: { code: 0, msg: 'success', success: true, data: null }
    }
  ];

  function offlineBody(url, asText) {
    for (var i = 0; i < OFFLINE_JSON_MAP.length; i++) {
      if (OFFLINE_JSON_MAP[i].test.test(url)) {
        console.log('[offline] 命中映射 #' + i + ' <- ' + String(url).slice(0, 140));
        return JSON.stringify(OFFLINE_JSON_MAP[i].body);
      }
    }
    console.log('[offline] 兜底 {} <- ' + String(url).slice(0, 140));
    // 未知的远端接口：一律给空 JSON 对象。
    // 这比空字符串安全得多 —— 空对象能被任何 JSON 反序列化器接受。
    return '{}';
  }

  // ---------------------------------------------------------------------
  // 0.15 Addressables 运行时资源本地化
  // ---------------------------------------------------------------------
  //
  // catalog.json 里的 m_InternalId 长这样：
  //   {UnityEngine.AddressableAssets.Addressables.RuntimePath}/WebGL/<name>.bundle
  // 游戏把它拼成 CDN 绝对地址去拉：
  //   https://voodoo.ali.landintheair.com/SniperSiege/wx/<ver>/StreamingAssets/aa/WebGL/<name>.bundle
  //
  // 离线版把 883 个 .bundle 全部放在
  //   web/assets/StreamingAssets/aa/WebGL/   （589MB）
  // 所以拦截层必须做三件事：
  //   1. settings.json / catalog.json  → 本地真实 JSON 文本
  //   2. aa/WebGL/*.bundle             → 本地真实【二进制】（关键！）
  //   3. 其余远端接口                   → 结构正确的空 JSON
  //
  // ⚠️ bundle 绝不能走 offlineBody() 的 JSON 兜底：
  //    那会把 "{}" 当成 AssetBundle 交给引擎，触发
  //    UnityWebRequest result : DataProcessingError
  //    Failed to decompress data for the AssetBundle
  //
  var AA_DIR = '/assets/StreamingAssets/aa/';           // 与 web/assets 对应
  var AA_BUNDLE_DIR = AA_DIR + 'WebGL/';

  // settings/catalog 用本地真实文件（先同步拿一份文本，供同步 XHR 使用）
  var AA_FILES = { settings: null, catalog: null };
  (function preloadAA() {
    ['settings', 'catalog'].forEach(function (k) {
      fetch(AA_DIR + k + '.json')
        .then(function (r) { return r.text(); })
        .then(function (t) { AA_FILES[k] = t; log('预载 aa/' + k + '.json: ' + t.length + ' bytes'); })
        .catch(function (e) { console.warn('预载 aa/' + k + ' 失败', e); });
    });
  })();

  // 从 URL 里抽出 bundle 文件名（处理 CDN 与本地两种形态）
  function aaBundleName(url) {
    var u = String(url || '');
    var m = /\/aa\/WebGL\/([^\/\?#]+\.bundle)(?:[?#]|$)/i.exec(u);
    if (m) return m[1];
    // 兜底：任意路径下以 .bundle 结尾
    m = /\/([^\/\?#]+\.bundle)(?:[?#]|$)/i.exec(u);
    return m ? m[1] : null;
  }

  // 异步版本：返回 { kind, body }
  //   kind = 'bundle'  → body 是 ArrayBuffer
  //   kind = 'text'    → body 是 string
  function offlineBodyAsync(url) {
    var u = String(url || '');
    var mSet = /\/aa\/settings\.json/i.test(u) || /StreamingAssets\/aa\/settings\.json/i.test(u);
    var mCat = /\/aa\/catalog\.json/i.test(u) || /StreamingAssets\/aa\/catalog\.json/i.test(u);

    if (mSet || mCat) {
      var k = mSet ? 'settings' : 'catalog';
      console.log('[offline] 本地文件 aa/' + k + '.json <- ' + u.slice(0, 140));
      var body = AA_FILES[k];
      var p = body ? Promise.resolve(body)
        : fetch(AA_DIR + k + '.json').then(function (r) { return r.text(); });
      return p.then(function (t) { return { kind: 'text', body: t }; });
    }

    var bn = aaBundleName(u);
    if (bn) {
      // 本地真实二进制。不预载（589MB），按需 fetch。
      // ⚠️ 不要用 encodeURIComponent：它会把文件名里的 '(' ')' 编成 %28/%29，
      //    server 端 decodeURIComponent 一次后得到的是字面量 "%28"，直接 404。
      //    bundle 名只含 [A-Za-z0-9_.()%-]，用 encodeURI 只转义空格等极少数字符即可。
      var localUrl = AA_BUNDLE_DIR + encodeURI(bn).replace(/#/g, '%23');
      return fetch(localUrl, { credentials: 'same-origin' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.arrayBuffer();
        })
        .then(function (buf) {
          if (!window.__aaBundleHits) window.__aaBundleHits = 0;
          window.__aaBundleHits++;
          console.log('[offline] 本地 bundle ' + bn + ' <- ' + buf.byteLength + ' bytes');
          return { kind: 'bundle', body: buf };
        })
        .catch(function (e) {
          console.warn('[offline] bundle 本地缺失:', bn, e && e.message);
          return { kind: 'bundle', body: new ArrayBuffer(0) };
        });
    }

    return Promise.resolve({ kind: 'text', body: offlineBody(u, true) });
  }

  // ---------------------------------------------------------------------
  // 0.16 本地「云存档」对象存储仿真（仿火山 TOS 行为）
  // ---------------------------------------------------------------------
  //
  // 游戏的存档链路：
  //   GET  https://ss.landintheair.com/storage/<appId>/<openId>/CloudGameData
  //   PUT  同 URL（保存）
  //   GET  .../TencentAd.is_new_user 等其他 storage 文件
  //
  // 真实服务（TOS）行为：
  //   GET 不存在 → 404 + {"Code":"NoSuchKey",...}  → 游戏走「新用户」
  //   GET 存在   → 200 + 文件原文
  //   PUT        → 200（空体 + ETag）
  //
  // ⚠️ 之前离线层给 GET 返回 200 + "{}"，导致：
  //   [GameDataManager] cloud load ok: {}   ← 假成功
  //   → 引导完成标记、联赛解锁标记等每次会话全部重置
  //   → 「联赛解锁引导」与「战斗引导」同时弹出（两个引导叠加 bug）
  //
  // 离线版用 localStorage 做持久化对象存储：
  //   key   = 'wxcloud:' + URL 路径（storage/xxx/yyy）
  //   value = 原文（文本）
  // ---------------------------------------------------------------------
  var CLOUD_PREFIX = 'wxcloud:';
  var CLOUD_RE = /^https?:\/\/[^\/]*landintheair\.com\/storage\/(.+)$/i;

  function cloudKeyOf(url) {
    var m = CLOUD_RE.exec(String(url || ''));
    return m ? CLOUD_PREFIX + m[1].split('?')[0] : null;
  }

  // 返回 { status, body }；非云存档 URL 返回 null
  var CLOUD_MEM = {};        // localStorage 写失败（配额）时的内存兜底
  function cloudStoreHandle(url, method, body) {
    var key = cloudKeyOf(url);
    if (!key) return null;
    var m = String(method || 'GET').toUpperCase();
    if (m === 'GET' || m === 'HEAD') {
      var v = null;
      try { v = localStorage.getItem(key); } catch (e) {}
      if (v == null && Object.prototype.hasOwnProperty.call(CLOUD_MEM, key)) v = CLOUD_MEM[key];
      if (v == null) {
        console.log('[cloud-store] GET MISS <-', url.slice(0, 140));
        return { status: 404, body: JSON.stringify({
          Code: 'NoSuchKey', Message: 'The specified key does not exist.',
          Key: key.slice(CLOUD_PREFIX.length), EC: '0017-00000003'
        }) };
      }
      console.log('[cloud-store] GET HIT (' + v.length + 'B) <-', url.slice(0, 140));
      return { status: 200, body: v };
    }
    if (m === 'PUT' || m === 'POST') {
      var text = (body == null) ? '' : (typeof body === 'string' ? body : null);
      if (text == null) {
        // ArrayBuffer / Uint8Array / Blob → 尽力转文本
        try {
          if (body instanceof ArrayBuffer) text = new TextDecoder().decode(body);
          else if (body && body.buffer instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset || 0, body.byteLength));
          else text = String(body);
        } catch (e) { text = ''; }
      }
      console.log('[cloud-store] PUT body diag: typeof=' + (typeof body) +
        ' ctor=' + (body && body.constructor && body.constructor.name) +
        ' len=' + (body && (body.byteLength != null ? body.byteLength : body.length)) +
        ' textLen=' + text.length);
      try {
        localStorage.setItem(key, text);
      } catch (e) {
        // 配额满 / 隐私模式：退回内存，仍然对游戏报告成功。
        // 绝不返回 500 —— 否则升级、解锁等写档流程可能卡在「保存失败」分支。
        console.warn('[cloud-store] localStorage 写入失败，改用内存兜底', key, e && e.message);
        CLOUD_MEM[key] = text;
      }
      // 双写：内存里也留一份，保证同一会话内读到的永远是最新值
      CLOUD_MEM[key] = text;
      console.log('[cloud-store] PUT OK (' + text.length + 'B) ->', key.slice(CLOUD_PREFIX.length));
      return { status: 200, body: '' };
    }
    if (m === 'DELETE') {
      try { localStorage.removeItem(key); } catch (e) {}
      delete CLOUD_MEM[key];
      return { status: 204, body: '' };
    }
    return { status: 405, body: 'method not supported' };
  }

  function isCloudStorageUrl(url) { return !!cloudKeyOf(url); }

  // ---------------------------------------------------------------------
  // 0.25 GPU 扩展伪装 —— 桌面 GPU 会报告 S3TC 等压缩纹理扩展，
  //      真手机（微信环境）只有 ASTC/ETC。引擎探测到 S3TC 后会走
  //      桌面压缩纹理路径，触发 wx 小游戏版从未执行的代码分支
  //      （首帧 Dictionary`2 缓存解引用 → memory access out of bounds）。
  //      把压缩纹理扩展全部屏蔽，让引擎选择未压缩纹理路径。
  // ---------------------------------------------------------------------
  (function maskGpuExts() {
    var BLOCK = /^(WEBGL_compressed_texture_|WEBKIT_WEBGL_compressed_texture_)/;
    ['WebGL2RenderingContext', 'WebGLRenderingContext'].forEach(function (name) {
      var Ctor = window[name];
      if (!Ctor || !Ctor.prototype) return;
      var proto = Ctor.prototype;
      var origGet = proto.getExtension;
      if (origGet && !proto.__extMasked) {
        proto.__extMasked = true;
        proto.getExtension = function (n) {
          if (BLOCK.test(String(n || ''))) return null;
          return origGet.apply(this, arguments);
        };
        var origList = proto.getSupportedExtensions;
        if (origList) {
          proto.getSupportedExtensions = function () {
            var list = origList.apply(this, arguments) || [];
            return list.filter(function (n) { return !BLOCK.test(n); });
          };
        }
      }
    });
  })();

  if (NATIVE.fetch) {
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input
        : (input && input.url) ? input.url : String(input);
      if (!OFFLINE_NET.enabled || isSameOrigin(url)) {
        OFFLINE_NET.passed++;
        return NATIVE.fetch(input, init);
      }
      OFFLINE_NET.blocked++;
      var method = (init && init.method) || (input && input.method) || 'GET';
      // 云存档（对象存储）仿真：GET/PUT 直接落到 localStorage
      var cloud = cloudStoreHandle(url, method, init && init.body);
      if (cloud) {
        return Promise.resolve(new Response(cloud.status === 204 ? null : cloud.body, {
          status: cloud.status,
          statusText: cloud.status === 404 ? 'Not Found' : 'OK',
          headers: { 'Content-Type': cloud.status === 404 ? 'application/json' : 'application/octet-stream', 'X-Offline-Cloud': '1' }
        }));
      }
      log('离线拦截 fetch:', url);
      return Promise.resolve(offlineResponse(url));
    };
  }

  if (NATIVE.XHR) {
    var OrigXHR = NATIVE.XHR;

    /**
     * 对跨域请求做一层「伪同步成功」包装。
     *
     * 难点：Unity 用的是同步 XHR（open(url, false)），而我们不能在
     * 同步上下文里 await 一个 Promise。好在「返回空数据」这件事
     * 不需要真的经过网络，可以直接在 getter 上伪造结果。
     */
    function OfflineXHR() {
      var xhr = new OrigXHR();
      var offline = false;
      var offlineUrl = '';
      var fakeStatus = 200;
      var fakeText = '';
      var fakeBuf = new ArrayBuffer(0);
      var self = this;

      function encodeBuf(s) {
        try {
          // UTF-8 编码，带 BOM 与否都行；Unity 侧用 TextDecoder
          return new TextEncoder().encode(s).buffer;
        } catch (e) {
          var a = new Uint8Array(s.length);
          for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xFF;
          return a.buffer;
        }
      }

      var origOpen = xhr.open.bind(xhr);
      var offlineMethod = 'GET';
      xhr.open = function (method, url, async) {
        offline = OFFLINE_NET.enabled && !isSameOrigin(url);
        if (offline) {
          offlineUrl = url;
          offlineMethod = String(method || 'GET').toUpperCase();
          // 云存档（对象存储）仿真：GET 直接同步查 localStorage；
          // PUT/POST 的 body 在 send() 才有，open 阶段先占位。
          if (isCloudStorageUrl(url)) {
            if (offlineMethod === 'GET' || offlineMethod === 'HEAD') {
              var c0 = cloudStoreHandle(url, offlineMethod, null);
              fakeStatus = c0.status;
              fakeText = c0.body;
              fakeBuf = encodeBuf(fakeText);
            } else {
              fakeText = '';
              fakeBuf = new ArrayBuffer(0);
            }
          }
          // settings / catalog 用预载的真实 JSON 文本
          else {
            var mSetX = /StreamingAssets\/aa\/settings\.json/i.test(url);
            var mCatX = /StreamingAssets\/aa\/catalog\.json/i.test(url);
            if (mSetX && AA_FILES.settings) {
              fakeText = AA_FILES.settings;
              fakeBuf = encodeBuf(fakeText);
            } else if (mCatX && AA_FILES.catalog) {
              fakeText = AA_FILES.catalog;
              fakeBuf = encodeBuf(fakeText);
            } else {
              // 实测：Unity WebGL 加载 Addressables bundle 走的是 fetch（69/69 次），
              // XHR 分支只承担少量远端 JSON 接口，这里不必处理二进制。
              fakeText = offlineBody(url, true);
              fakeBuf = encodeBuf(fakeText);
            }
          }
          OFFLINE_NET.blocked++;
          log('离线拦截 XHR:', url, async === false ? '(同步)' : '');
        } else {
          OFFLINE_NET.passed++;
        }
        return origOpen.apply(null, arguments);
      };

      var origSend = xhr.send.bind(xhr);
      xhr.send = function (body) {
        if (!offline) return origSend(body);
        // 云存档 PUT/POST：body 此时才可用，同步写入本地对象存储
        if (isCloudStorageUrl(offlineUrl) && (offlineMethod === 'PUT' || offlineMethod === 'POST')) {
          var c1 = cloudStoreHandle(offlineUrl, offlineMethod, body);
          fakeStatus = c1.status;
          fakeText = c1.body;
          fakeBuf = encodeBuf(fakeText);
        }
        // 直接跳过真实发送；用一个已完成的假状态替代
        setTimeout(function () {
          try {
            if (typeof xhr.onreadystatechange === 'function') xhr.onreadystatechange();
            if (typeof xhr.onload === 'function') xhr.onload();
            if (typeof xhr.onloadend === 'function') xhr.onloadend();
          } catch (e) { /* 忽略 */ }
        }, 0);
        return undefined;
      };

      // 关键属性全部改写成「成功空响应」
      Object.defineProperties(xhr, {
        readyState: { get: function () { return offline ? 4 : this.__rs; }, configurable: true },
        status: { get: function () { return offline ? fakeStatus : this.__st; }, configurable: true },
        statusText: { get: function () {
          if (!offline) return this.__stx;
          if (fakeStatus === 404) return 'Not Found';
          if (fakeStatus === 204) return 'No Content';
          if (fakeStatus >= 400) return 'Error';
          return 'OK';
        }, configurable: true },
        responseText: { get: function () { return offline ? fakeText : this.__rt; }, configurable: true },
        response: {
          get: function () {
            if (!offline) return this.__rsp;
            return (this.responseType === 'arraybuffer' || this.responseType === 'blob')
              ? fakeBuf : fakeText;
          },
          configurable: true
        },
        responseURL: { get: function () { return offline ? '' : this.__ru; }, configurable: true },
        getResponseHeader: {
          value: function (n) {
            if (offline) return /content-type/i.test(n) ? 'application/json' : null;
            return this.__gh ? this.__gh(n) : null;
          },
          configurable: true
        },
        getAllResponseHeaders: {
          value: function () {
            return offline ? 'content-type: application/json\r\n' : (this.__gah ? this.__gah() : '');
          },
          configurable: true
        }
      });

      // 把原生 getter 的结果缓存起来，供非离线分支读取
      ['readyState', 'status', 'statusText', 'responseText', 'response', 'responseURL']
        .forEach(function (prop) {
          try {
            Object.defineProperty(xhr, '__' + ({
              readyState: 'rs', status: 'st', statusText: 'stx',
              responseText: 'rt', response: 'rsp', responseURL: 'ru'
            })[prop], {
              get: function () {
                return Object.getOwnPropertyDescriptor(OrigXHR.prototype, prop).get.call(xhr);
              },
              configurable: true
            });
          } catch (e) { /* 忽略 */ }
        });

      return xhr;
    }
    OfflineXHR.prototype = OrigXHR.prototype;
    OfflineXHR.UNSENT = 0; OfflineXHR.OPENED = 1; OfflineXHR.HEADERS_RECEIVED = 2;
    OfflineXHR.LOADING = 3; OfflineXHR.DONE = 4;

    window.XMLHttpRequest = OfflineXHR;
  }

  window.__offlineNet = OFFLINE_NET;
  window.__nativeRAF = NATIVE.raf;

  var G = (typeof GameGlobal !== 'undefined') ? GameGlobal : (window.GameGlobal = {});
  if (G.__wxShimInjected) { log('already injected'); return; }
  G.__wxShimInjected = true;

  // 资源根路径（相对 index.html）
  var ASSET_ROOT = (function () {
    var q = location.search.match(/[?&]assets=([^&]+)/);
    return q ? decodeURIComponent(q[1]) : 'assets/';
  })();
  if (ASSET_ROOT.slice(-1) !== '/') ASSET_ROOT += '/';

  // 视频 / 音频解码相关的宿主能力（微信 lib 提供，浏览器没有）
  var WX_ENV = {
    USER_DATA_PATH: 'wxfile://usr',
    USER_DATA_PATH_WASM: 'wxfile://usr',
    OPEN_DATA_CONTEXT: 'openDataContext'
  };

  // ---------------------------------------------------------------------
  // 1. 本地文件读取工具：同步 XHR + 异步 fetch 双通道
  // ---------------------------------------------------------------------
  var fileCache = Object.create(null); // path -> ArrayBuffer

  function normalizePath(p) {
    if (typeof p !== 'string') p = String(p);
    p = p.replace(/\\/g, '/');
    p = p.replace(/^wxfile:\/\/[^/]*\//, '');           // wxfile://usr/... -> ...
    p = p.replace(/^https?:\/\/[^/]+\//, '');            // 绝对 URL -> 相对路径
    p = p.replace(/^\.\//, '');
    p = p.replace(/^\/+/, '');                            // 去掉前导斜杠
    p = p.replace(/^__GAME_FILE_CACHE\//, '');            // 微信缓存前缀
    p = p.replace(/^__GAME_FILE_CACHE\//, '');
    return p;
  }

  // 把一个逻辑路径映射到真实可取的 URL 列表（按优先级）
  function candidateUrls(p) {
    var n = normalizePath(p);
    var list = [];
    // wasmcode/xxx.wasm.br 这类分包路径 -> assets/wasmcode/xxx
    list.push(ASSET_ROOT + n);
    // 微信缓存目录下的 unityweb 文件，实际放在 assets/ 根下
    var slash = n.lastIndexOf('/');
    if (slash >= 0) list.push(ASSET_ROOT + n.slice(slash + 1));
    list.push(ASSET_ROOT + n.replace(/^(wasmcode1?|wasmcode2)\//, ''));
    return list;
  }

  function xhrSync(url, asText) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', url, false);
      if (!asText) x.responseType = 'arraybuffer';
      x.send(null);
      if (x.status >= 200 && x.status < 300 || (x.status === 0 && x.response)) {
        return asText ? (x.responseText || '') : x.response;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /** 同步读取文件，返回 ArrayBuffer 或 string。找不到抛异常。 */
  function readFileSyncSafe(path, asText) {
    var urls = candidateUrls(path);
    for (var i = 0; i < urls.length; i++) {
      if (fileCache[urls[i]] && !asText) return fileCache[urls[i]];
      var d = xhrSync(urls[i], asText);
      if (d !== null && (asText ? d.length > 0 : d.byteLength > 0)) {
        if (!asText) fileCache[urls[i]] = d;
        log('readFileSync ok:', urls[i], asText ? d.length + ' chars' : d.byteLength + ' bytes');
        return d;
      }
    }
    log('readFileSync MISS:', path, '->', urls);
    throw new Error('readFileSync: no such file ' + path);
  }

  function readFileAsync(path) {
    var urls = candidateUrls(path);
    return new Promise(function (resolve, reject) {
      (function tryNext(i) {
        if (i >= urls.length) { reject(new Error('readFile: no such file ' + path)); return; }
        fetch(urls[i], { credentials: 'same-origin' })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.arrayBuffer();
          })
          .then(function (buf) {
            fileCache[urls[i]] = buf;
            log('readFile async ok:', urls[i], buf.byteLength, 'bytes');
            resolve(buf);
          })
          .catch(function () { tryNext(i + 1); });
      })(0);
    });
  }

  // ---------------------------------------------------------------------
  // 屏幕 / 设备信息
  // ---------------------------------------------------------------------
  // ⚠️ 关键决策：platform 伪装成 "ios" 而不是 "devtools"。
  //
  // weapp-adapter 对 platform 有两个分支：
  //   - "devtools"：用 Object.defineProperty(window, 'document', {value: 伪document})
  //     浏览器里 window.document 是 [Unforgeable] 的，直接抛
  //     TypeError: Cannot redefine property: document，整个适配层就挂了。
  //   - 其它（ios/android）：把伪 document / canvas / navigator 赋值到 GameGlobal，
  //     然后 GameGlobal.window = 伪 window。
  //     Unity 运行时是通过 GameGlobal 上的全局变量访问 document / canvas 的，
  //     这条路在浏览器里完全可行。
  //
  // 代价：Unity 会认为自己在 iOS 上，需要把 isIOSHighPerformanceMode 相关分支
  // 全部关掉（否则它会走 WXWebGL / WXWebAssembly 的定制路径）。
  var FAKE_PLATFORM = 'ios';
  var FAKE_SYSTEM = 'iOS 16.6';

  var CSS_W = function () { return Math.max(1, window.innerWidth | 0); };
  var CSS_H = function () { return Math.max(1, window.innerHeight | 0); };
  var DPR = function () { return window.devicePixelRatio || 1; };

  // 原生 style getter。
  // ⚠️ 为什么必须有它：game.js 的 weapp-adapter 会改主 canvas 的原型链
  //   （e.__proto__.__proto__ = 适配层 Element 实例），而那个实例自带一个
  //   假 style 对象 —— 于是运行期 `canvas.style.width = ...` 全写进了假对象，
  //   真实布局纹丝不动（浏览器实测：computed style 永远等于画布固有尺寸）。
  //   本 shim 比 game.js 先加载，此刻 Element.prototype 还是原生的，
  //   先把真引用抓下来，之后所有布局写入都走它。
  var NATIVE_STYLE_GET = (function () {
    // ⚠️ style 定义在 HTMLElement.prototype（不在 Element.prototype）
    var holders = [window.HTMLElement && HTMLElement.prototype,
                   window.Element && Element.prototype,
                   window.SVGElement && SVGElement.prototype];
    for (var i = 0; i < holders.length; i++) {
      try {
        if (!holders[i]) continue;
        var d = Object.getOwnPropertyDescriptor(holders[i], 'style');
        if (d && d.get) return d.get;
      } catch (e) { /* try next */ }
    }
    return null;
  })();
  function realStyle(c) {
    try { if (NATIVE_STYLE_GET) return NATIVE_STYLE_GET.call(c); } catch (e) { /* fallthrough */ }
    return c.style;
  }

  // 让 Unity 以与真实微信窗口一致的比例运行。
  // ⚠️ 不能硬编码 iPhone X 的 375/812=0.462：
  //    真实微信 PC 端小游戏窗口游戏区是 431x748 ≈ 0.576，
  //    硬套 0.462 会把画面横向压窄约 20%（用户实测反馈）。
  //    真机上游戏本来就是全屏自适应（CanvasScaler 处理任意比例），
  //    所以默认直接铺满窗口（stretch），只有显式 ?fit=contain 才裁剪。
  var FIT_MODE = (function () {
    var m = location.search.match(/[?&]fit=(\w+)/);
    return m ? m[1] : 'stretch';
  })();

  function computeGameViewport() {
    var w = CSS_W(), h = CSS_H();
    if (FIT_MODE === 'stretch') return { width: w, height: h, left: 0, top: 0, scale: 1 };
    // contain：可选锁定一个参考比例（默认取真实微信窗口游戏区 431/748）
    var TARGET_AR = 431 / 748;
    var gw, gh;
    if (w / h > TARGET_AR) { gh = h; gw = h * TARGET_AR; }
    else { gw = w; gh = w / TARGET_AR; }
    return { width: Math.round(gw), height: Math.round(gh), left: Math.round((w - gw) / 2), top: Math.round((h - gh) / 2), scale: 1 };
  }

  var VIEW = computeGameViewport();

  // 窗口缩放回调表（对应 wx.onWindowResize）
  var winResizeCbs = [];

  /**
   * 浏览器窗口尺寸变化时的完整处理。
   *
   * ⚠️ 为什么不能只改 canvas 的 CSS 尺寸：
   *   微信小游戏里「窗口变大」是通过 wx.onWindowResize 通知适配层，
   *   适配层再回调引擎；浏览器里这条链路根本不存在。
   *   更要命的是伪 window 的 innerWidth/innerHeight 原本是启动瞬间的固定值，
   *   lib/game.js 的
   *       canvas.clientWidth  = window.innerWidth  * _ScaleRate
   *       canvas.getBoundingClientRect() = { width: window.innerWidth, ... }
   *   也都读它 —— 于是引擎始终认为画布还是启动时那么大，
   *   用户把窗口拉大后画面就不再跟随（就是"页面不自适应窗口大小"）。
   *   这里把三件事做全：
   *     1) 更新 canvas 的 CSS 尺寸 + 后备缓冲（applyCanvasLayout）
   *     2) 触发 wx.onWindowResize 注册的回调
   *     3) 向伪 window / canvas 派发 resize 事件（引擎/输入系统可能监听）
   */
  function onBrowserResize() {
    VIEW = computeGameViewport();
    syncCanvas(true);

    var info = {
      windowWidth: VIEW.width, windowHeight: VIEW.height,
      screenWidth: VIEW.width, screenHeight: VIEW.height
    };
    for (var i = 0; i < winResizeCbs.length; i++) {
      try { winResizeCbs[i](info); } catch (e) { console.warn('[wx-shim] onWindowResize 回调异常', e); }
    }
    try {
      if (G && G.__fakeDispatch) G.__fakeDispatch('resize', { type: 'resize' });
    } catch (e) { /* ignore */ }
    try {
      if (mainCanvas && mainCanvas.dispatchEvent) mainCanvas.dispatchEvent(new Event('resize'));
    } catch (e) { /* ignore */ }
    ringPush('[resize] ' + VIEW.width + 'x' + VIEW.height + ' (css ' + CSS_W() + 'x' + CSS_H() + ' dpr ' + DPR() + ')');
  }

  var resizeTimer = 0;
  function scheduleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(onBrowserResize, 60);   // 拖动窗口时防抖，避免反复重建后备缓冲
  }
  window.addEventListener('resize', scheduleResize);
  // 全屏切换 / 旋转屏幕
  window.addEventListener('orientationchange', scheduleResize);
  document.addEventListener('fullscreenchange', scheduleResize);
  // visualViewport（devtools 开合、移动端软键盘、缩放都会触发它而不一定触发 window.resize）
  try {
    if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleResize);
  } catch (e) { /* ignore */ }
  // DPR 变化（Ctrl+/- 浏览器缩放、跨屏拖动）：matchMedia resolution 变化
  try {
    var dprMql = window.matchMedia('(resolution: ' + DPR() + 'dppx)');
    var rearmDpr = function () {
      try {
        dprMql = window.matchMedia('(resolution: ' + DPR() + 'dppx)');
        dprMql.addEventListener('change', onDprChange);
      } catch (e) { /* ignore */ }
    };
    var onDprChange = function () { scheduleResize(); rearmDpr(); };
    dprMql.addEventListener('change', onDprChange);
  } catch (e) { /* ignore */ }

  // ── 兜底巡检 ──────────────────────────────────────────────────────
  // 有些场景不派发 resize 事件（滚动条出现/消失、部分 DPI 切换、窗口管理器
  // 的边缘 snap 等）。一旦 window 尺寸与 canvas 脱节，Unity 的 Screen 尺寸
  // （= innerWidth）与渲染缓冲（canvas.width）就会不一致 —— UI 按一个尺寸
  // 布局、画面按另一个尺寸渲染，正是「图层位置错乱」的元凶。
  // 每 600ms 比对一次，脱节就自动重同步。
  setInterval(function () {
    try {
      if (!mainCanvas) return;
      var v = computeGameViewport();
      var bw = Math.round(v.width * DPR()), bh = Math.round(v.height * DPR());
      if (mainCanvas.width !== bw || mainCanvas.height !== bh) {
        ringPush('[resize-watch] 检测到尺寸脱节 ' + mainCanvas.width + 'x' + mainCanvas.height +
                 ' -> ' + bw + 'x' + bh + '，自动重同步');
        onBrowserResize();
      }
      maybeReloadForBigResize(v.width, v.height);
    } catch (e) { /* ignore */ }
  }, 600);

  // ── 大幅尺寸变化 → 以新尺寸重启游戏 ─────────────────────────────
  // 游戏代码里大量 UI 是「启动/进入界面那一刻」用当时尺寸摆位的
  // （UGUI 锚点会重排，但代码定位、按引用/拷贝缓存的系统信息不会）。
  // 微信真机窗口尺寸永不变化，游戏根本没写运行期重布局逻辑，
  // 所以任何 in-place 适配都做不到 100% 一致。
  // 窗口宽或高变化超过 25% 时，直接以新尺寸全新启动（进度在本地
  // 存档里，无损），这是唯一能保证「所有图层都按同一尺寸布局」的方案。
  var reloadBaseW = 0, reloadBaseH = 0, reloadTimer = 0, reloadCount = 0, reloadCalls = 0;
  function maybeReloadForBigResize(w, h) {
    reloadCalls++;
    window.__rrDbg = { calls: reloadCalls, base: [reloadBaseW, reloadBaseH], w: w, h: h,
      booted: !!window.__gameBooted, count: reloadCount };
    if (/[?&]noreload=1/.test(location.search)) return;   // 调试/探针可禁用
    if (!window.__gameBooted && !(mainCanvas && mainCanvas.width > 300)) {
      // 未启动完成：以当前尺寸为基准，不重载（启动前变窗口=按新尺寸启动）
      reloadBaseW = w; reloadBaseH = h;
      return;
    }
    if (!reloadBaseW) { reloadBaseW = w; reloadBaseH = h; return; }
    var dw = Math.abs(w - reloadBaseW) / reloadBaseW;
    var dh = Math.abs(h - reloadBaseH) / reloadBaseH;
    if (dw < 0.25 && dh < 0.25) {
      // 变回去了：撤销已排定的重启
      if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = 0; }
      return;
    }
    if (reloadCount >= 3) return;   // 防异常环境无限重载
    if (reloadTimer) return;        // ⚠️ 已排定就不再重排：巡检每 600ms 都会进来，
                                    //    如果每次都 clearTimeout+重排，2s 永远到不了
    reloadTimer = setTimeout(function () {
      reloadTimer = 0;
      // 再验一次（拖动过程中可能又变回去了）
      var v2 = computeGameViewport();
      var dw2 = Math.abs(v2.width - reloadBaseW) / reloadBaseW;
      var dh2 = Math.abs(v2.height - reloadBaseH) / reloadBaseH;
      if (dw2 < 0.25 && dh2 < 0.25) return;
      reloadCount++;
      ringPush('[resize-reload] 窗口尺寸变化过大（' + reloadBaseW + 'x' + reloadBaseH +
               ' -> ' + v2.width + 'x' + v2.height + '），以新尺寸重启游戏 #' + reloadCount);
      try { localStorage.setItem('wxshim.fs:__resizeReload', '1'); } catch (e) {}
      location.reload();
    }, 2000);
  }

  // 重启后给一次性提示（读标记即清）
  (function notifyResizeReload() {
    try {
      if (localStorage.getItem('wxshim.fs:__resizeReload') !== '1') return;
      localStorage.removeItem('wxshim.fs:__resizeReload');
      var show = function () {
        var el = document.createElement('div');
        el.textContent = '已按新窗口尺寸重新启动';
        el.style.cssText = 'position:fixed;left:50%;top:14%;transform:translateX(-50%);z-index:99999;' +
          'background:rgba(0,0,0,0.72);color:#fff;padding:10px 18px;border-radius:20px;' +
          'font-size:14px;pointer-events:none;transition:opacity .5s;opacity:1;';
        (document.body || document.documentElement).appendChild(el);
        setTimeout(function () { el.style.opacity = '0'; }, 2200);
        setTimeout(function () { el.remove && el.remove(); }, 2900);
      };
      if (document.body) show(); else window.addEventListener('DOMContentLoaded', show);
    } catch (e) { /* ignore */ }
  })();

  // ⚠️ 系统信息必须返回「活值对象」：
  //   lib/plugin.js 会把 getSystemInfoSync() 的返回值**按引用**缓存在
  //   w.systemInfo 里（仅设备旋转时才刷新），游戏侧到处读它的
  //   windowWidth / screenWidth / safeArea 来摆 UI。
  //   如果每次返回普通快照对象，启动后窗口一变（关 devtools、拖窗口、
  //   缩放），缓存里就全是旧尺寸 —— UI 一半按旧尺寸、一半按新尺寸，
  //   正是「各个图层位置错乱」的元凶。
  //   用 getter 让所有字段实时反映当前窗口，缓存引用也永远读到新值。
  //   （带忽略型 setter：万一外部代码想写这些字段，不抛异常。）
  function defineLive(target, compute) {
    Object.defineProperty(target, compute.key, {
      configurable: true, enumerable: true,
      get: function () { return compute.get(); },
      set: function () { /* 忽略外部写入 */ }
    });
  }

  var LIVE_SYSINFO = null;
  function makeLiveSystemInfo() {
    if (LIVE_SYSINFO) return LIVE_SYSINFO;
    var o = {
      brand: 'browser', model: 'Browser',
      language: 'zh_CN', version: '8.0.50', system: FAKE_SYSTEM,
      platform: FAKE_PLATFORM, SDKVersion: '3.5.0',
      fontSizeSetting: 16, benchmarkLevel: 30, deviceOrientation: 'portrait',
      host: { env: 'WeChat', version: 587405312 }, enableDebug: false, theme: 'light'
    };
    [['pixelRatio', function () { return DPR(); }],
     ['screenWidth', function () { return computeGameViewport().width; }],
     ['screenHeight', function () { return computeGameViewport().height; }],
     ['windowWidth', function () { return computeGameViewport().width; }],
     ['windowHeight', function () { return computeGameViewport().height; }],
     ['statusBarHeight', function () { return 0; }]
    ].forEach(function (p) { defineLive(o, { key: p[0], get: p[1] }); });
    var safe = {};
    [['left', function () { return 0; }],
     ['top', function () { return 0; }],
     ['right', function () { return computeGameViewport().width; }],
     ['bottom', function () { return computeGameViewport().height; }],
     ['width', function () { return computeGameViewport().width; }],
     ['height', function () { return computeGameViewport().height; }]
    ].forEach(function (p) { defineLive(safe, { key: p[0], get: p[1] }); });
    defineLive(o, { key: 'safeArea', get: function () { return safe; } });
    LIVE_SYSINFO = o;
    return o;
  }

  function getSystemInfoSync() {
    return makeLiveSystemInfo();
  }

  // ---------------------------------------------------------------------
  // 3. canvas / image / audio 工厂
  // ---------------------------------------------------------------------
  var mainCanvas = null;
  var offCanvases = [];

  function createMainCanvas() {
    var c = document.createElement('canvas');
    c.id = 'GameCanvas';
    c.setAttribute('width', 1);
    c.setAttribute('height', 1);
    c.style.cssText = 'position:absolute;display:block;touch-action:none;outline:none;background:#000;';
    (document.getElementById('game-container') || document.body).appendChild(c);
    mainCanvas = c;
    pinCanvasId(c, 'GameCanvas');
    applyCanvasLayout();
    return c;
  }

  /**
   * 把主 canvas 的 id 钉死，禁止被清空。
   *
   * ⚠️ 为什么必须这么做：
   *   Unity 官方适配插件（lib/plugin.js）里有一句
   *       S.id = "";      // S 就是主上屏 canvas
   *   在微信小游戏里 canvas 不是 DOM 元素、本来没有 id，
   *   这句是安全的。但在浏览器里 canvas 是真正的 HTMLCanvasElement，
   *   清空 id 会让 Unity 引擎侧的 canvas 选择器计算（lib/game.js 的 i3()）
   *   产出 "#" 这种非法选择器：
   *       var t = "#" + CSS.escape(j.canvas.id);   // => "#"
   *       document.querySelector(t)                // => SyntaxError
   *   而这个 querySelector 是在 env.JS_SystemInfo_GetCanvasClientSize 里
   *   被 wasm 同步调用的，异常会直接打断 main()，
   *   导致引擎初始化中断 —— 表现就是永久黑屏、主循环永不启动。
   *
   *   这里用带 getter/setter 的属性把 id 固定住：
   *   任何试图写入空值（或其他值）的赋值都被忽略，只记一条日志。
   */
  function pinCanvasId(c, id) {
    try {
      var current = id;
      Object.defineProperty(c, 'id', {
        configurable: true,
        enumerable: true,
        get: function () { return current; },
        set: function (v) {
          if (v) { current = v; }
          else { log('拦截了对主 canvas id 的清空（保持 "' + current + '"）'); }
        }
      });
      log('主 canvas id 已钉死为', current);
    } catch (e) {
      console.warn('[wx-shim] 无法钉死 canvas id（不影响其他功能）:', e);
    }
  }

  // 画布同步总入口。
  // ⚠️ 顺序很重要：
  //   1) 先铺 CSS（引擎的 setCanvasSize 会清掉 style width/height）
  //   2) 后备缓冲的修改必须走 unityNamespace.Browser.setCanvasSize（emscripten
  //      官方入口）：它会更新 widthNative/heightNative 并触发引擎侧 resizeListeners，
  //      Unity 收到后更新 Screen 尺寸、gl.viewport 并重排 UI。
  //      直接赋值 canvas.width 不仅引擎不认，还会先改了缓冲导致 setCanvasSize
  //      内部「相同值提前返回」，跳过通知 —— 引擎 Screen 与实际缓冲脱节，图层错乱。
  //   3) setCanvasSize 之后再补一遍 CSS。
  function syncCanvas(force) {
    if (!mainCanvas) return;
    var v = computeGameViewport();
    var d = DPR();
    var bw = Math.round(v.width * d), bh = Math.round(v.height * d);

    var needBuf = force || mainCanvas.width !== bw || mainCanvas.height !== bh;
    var B = null;
    try { B = (typeof G !== 'undefined') && G.unityNamespace && G.unityNamespace.Browser; } catch (e) {}

    applyCanvasStyle(v);

    if (needBuf) {
      var done = false;
      if (B && typeof B.setCanvasSize === 'function') {
        try { B.setCanvasSize(bw, bh); done = true; } catch (e) { done = false; }
      }
      if (!done) {   // 引擎未就绪（启动早期）：直接改缓冲
        if (mainCanvas.width !== bw) mainCanvas.width = bw;
        if (mainCanvas.height !== bh) mainCanvas.height = bh;
      }
      // emscripten 的 updateCanvasDimensions 会重写 canvas.style，补回去
      applyCanvasStyle(v);
    }
    log('canvas sync', bw + 'x' + bh, 'css', v.width + 'x' + v.height, needBuf ? '(changed)' : '');
  }

  function applyCanvasStyle(v) {
    var rstyle = realStyle(mainCanvas);
    rstyle.width = v.width + 'px';
    rstyle.height = v.height + 'px';
    rstyle.left = v.left + 'px';
    rstyle.top = v.top + 'px';
  }

  // 兼容旧调用名
  function applyCanvasLayout() { syncCanvas(false); }

  // 画布的真实几何信息。lib/game.js 把主 canvas 实例的
  // getBoundingClientRect 覆盖成了 { left:0, top:0, width:innerWidth, ... }，
  // 但那只在「画布 1:1 铺满窗口」时才是对的；运行期等比缩放后必须用真实矩形
  // 才能正确换算点击坐标。这里绕过实例覆盖、直接用原型上的原生实现。
  function canvasNativeRect() {
    var fallback = { left: 0, top: 0, width: CSS_W(), height: CSS_H() };
    if (!mainCanvas) return fallback;
    try {
      var r = HTMLCanvasElement.prototype.getBoundingClientRect.call(mainCanvas);
      return r && r.width > 0 ? r : fallback;
    } catch (e) { return fallback; }
  }

  // 把窗口坐标换算成画布逻辑坐标（CSS px）。
  // ⚠️ stretch 1:1 模式下（缓冲 = CSS 尺寸 × dpr），Unity 的 Screen 尺寸 =
  //    innerWidth（当前值），UI 按当前窗口布局 —— 所以这里必须用「当前」真实
  //    矩形 1:1 换算，绝不能再乘「启动宽/当前宽」的历史缩放系数：
  //    那是 contain 等比缩放时代的逻辑，resize 后会让所有点击整体偏移
  //    （偏移量 = 1 - 启动宽/当前宽），表现正是「图层错乱、点不动」。
  function mapToCanvas(clientX, clientY) {
    var r = canvasNativeRect();
    return [clientX - r.left, clientY - r.top];
  }

  /*
   * wx.createCanvas() 的语义（微信）：
   *   第一次调用 → 返回屏幕上那个主上屏 canvas；
   *   后续调用   → 返回**离屏** canvas（每调用一次一个新的）。
   *
   * ⚠️ 这里踩过的坑：
   *   插件统一加载页的 LaunchStage.init() 里写着
   *       var i = E.createCanvas();           // E === wx
   *       i.width = n*te; i.height = o*te;
   *       var f = i.getContext("2d");         // ← 拿 2D 用于画进度条
   *       this.offscreenCtx = f;
   *   如果每次都返回主 canvas，而主 canvas 已经被 getContext('webgl')
   *   占用过，浏览器规范规定再取 2d 会返回 **null**
   *   （一个 canvas 只能有一个 context 类型）。
   *   于是 launchStage.offscreenCtx 为 null，游戏启动后
   *   hideLoadingPage() → hideProgress() → this.offscreenCtx.clearRect(...)
   *   直接 TypeError，整局卡死。
   *
   *   所以必须严格按微信语义：第一次给主 canvas，之后每次新建离屏 canvas。
   */
  var __createCanvasCalled = 0;
  function createCanvas() {
    __createCanvasCalled++;
    // 首次：主上屏 canvas（weapp-adapter 会用它做首屏）
    if (__createCanvasCalled === 1) {
      if (typeof GameGlobal !== 'undefined' && GameGlobal.canvas) return GameGlobal.canvas;
      return ensureMainCanvas();
    }
    // 后续：全新离屏 canvas
    var c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    offCanvases.push(c);
    return c;
  }

  /**
   * 保证主 canvas 一定存在、有 id、挂在 DOM 上。
   *
   * ⚠️ 为什么 id 和 DOM 挂载都必不可少：
   *   Unity 的 wasm 启动早期会调 env.JS_SystemInfo_GetCanvasClientSize，
   *   实现是（见 lib/game.js）：
   *       var t = io(ptr);                            // 读出 canvas 选择器字符串
   *       var r = "#canvas" == t ? j.canvas : document.querySelector(t);
   *   而那个字符串由 framework 的 i3() 生成：
   *       var i = j.canvas ? j.canvas.id : "unity-canvas";
   *       return "#" + CSS.escape(i);
   *   也就是说：如果 j.canvas.id === ''，选择器就是 "#"，
   *   document.querySelector('#') 直接抛
   *       SyntaxError: '#' is not a valid selector
   *   这个异常是从 wasm 里同步调进来的，会把 main() 整个打断 ——
   *   引擎初始化半途而废，画面永远黑屏、主循环永远不启动。
   *
   *   另外 querySelector 只认「在文档里」的元素，
   *   所以光设 id 不 append 也没用。
   */
  function ensureMainCanvas() {
    if (mainCanvas && mainCanvas.isConnected) return mainCanvas;
    if (!mainCanvas) mainCanvas = createMainCanvas();
    // ★ 关键修复：game.js 的 weapp-adapter 会在 wx.createCanvas() 返回的主 canvas 上
    //   执行 e.__proto__.__proto__ = new EventTargetPolyfill()，
    //   把 addEventListener/dispatchEvent 替换成 WeakMap 版实现。
    //   Unity InputSystem 通过 canvas.addEventListener 注册的监听进了 WeakMap，
    //   而浏览器真实事件只派发给真 DOM 监听器 —— 输入从此全部失联。
    //   用实例属性把这三个方法恢复为原生实现（实例属性优先于原型链）。
    try {
      var proto = HTMLCanvasElement.prototype;
      ['addEventListener', 'removeEventListener', 'dispatchEvent'].forEach(function (m) {
        if (mainCanvas[m] !== proto[m]) {
          Object.defineProperty(mainCanvas, m, { value: proto[m], writable: true, configurable: true });
        }
      });
    } catch (e) { /* ignore */ }
    // 极端情况下被别人移出 DOM，重新挂回去
    if (!mainCanvas.isConnected) {
      (document.getElementById('game-container') || document.body).appendChild(mainCanvas);
    }
    if (typeof GameGlobal !== 'undefined') GameGlobal.canvas = mainCanvas;
    return mainCanvas;
  }

  function createImage() {
    var img = new Image();
    img.crossOrigin = 'anonymous';
    return img;
  }

  // ////////////////////////////////////////////////////////////////////////
  // 4. 文件系统管理器（40+ API）—— 全部映射到本地静态目录
  // ////////////////////////////////////////////////////////////////////////
  function failCb(o, msg) {
    if (o && typeof o.fail === 'function') o.fail({ errMsg: msg || 'fail' });
  }
  function okCb(o, res) {
    if (o && typeof o.success === 'function') o.success(res || {});
  }
  function doneCb(o) {
    if (o && typeof o.complete === 'function') o.complete({});
  }

  // 允许「写」的文件（走内存；同时镜像到 localStorage，刷新不丢进度）
  var memFS = Object.create(null);
  var FS_PERSIST_PREFIX = 'wxshim.fs:';
  var FS_PERSIST_MAX = 128 * 1024;   // 只持久化小文件（存档），资源缓存不落 localStorage

  // 资源缓存（bundle / wasm / 压缩流）体积大且可重建，不持久化
  var FS_PERSIST_SKIP_EXT = /\.(bundle|wasm|br|unityweb|dat|bin|data|png|jpg|ogg|mp3|wav|ab)$/i;

  function fsShouldPersist(k, size) {
    if (size > FS_PERSIST_MAX) return false;
    if (FS_PERSIST_SKIP_EXT.test(k)) return false;
    return true;
  }

  function fsPersist(k, rec) {
    try {
      if (!rec || !fsShouldPersist(k, rec.size || 0)) return;
      var u8 = new Uint8Array(rec.data);
      var bin = '';
      var CH = 8192;
      for (var i = 0; i < u8.length; i += CH) {
        bin += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
      }
      localStorage.setItem(FS_PERSIST_PREFIX + k, btoa(bin));
    } catch (e) { /* 配额满等原因：静默放弃持久化 */ }
  }

  function fsUnpersist(p) {
    try {
      var k = normalizeFsPath(p) || p;
      localStorage.removeItem(FS_PERSIST_PREFIX + k);
      if (p !== k) localStorage.removeItem(FS_PERSIST_PREFIX + p);
    } catch (e) { /* ignore */ }
  }

  /**
   * 文件系统：这是整个移植里最需要「像真的」的一块。
   *
   * Unity 插件（plugin.js）自己实现了一套资源缓存，流程是：
   *   1. downloadFile(url) → 拿到临时文件 tempFilePath
   *   2. getFileInfo(tempFilePath) 校验 expectedSize === actualSize
   *   3. renameSync(tempFilePath → downloaded/xxx.br)
   *   4. 下次启动 statSync() 判断缓存命中，命中就直接 readFileSync
   *
   * 任何一步返回假数据（比如 stat 永远 size=0），都会让插件判定
   * 「缓存损坏」→ 删缓存 → 重新下载 → 又失败，无限循环，永远进不到
   * UnityModule 实例化。所以这里必须提供真实的目录/尺寸/重命名语义。
   *
   * 读路径优先走 memFS（插件写进去的），miss 时再回落到本地静态资源目录。
   * 写路径只落 memFS（浏览器里没有真正的可写文件系统，也不需要）。
   */
  function normalizeFsPath(p) {
    if (!p) return '';
    var s = String(p).replace(/\\/g, '/');

    // 微信真实路径形如：
    //   wxfile://usr/__GAME_FILE_CACHE/downloaded/xxx.br
    //   wxfile://usr/__GAME_FILE_CACHE/__PLUGIN_TMP__/abc.tmp
    //   wxfile://__wxprivate__/__PATCH_DIR/patchconfig.json
    // 统一剥掉协议头和 __GAME_FILE_CACHE 这一层，得到稳定的相对键：
    //   usr/downloaded/xxx.br
    //   usr/__PLUGIN_TMP__/abc.tmp
    //   __wxprivate__/__PATCH_DIR/patchconfig.json
    s = s.replace(/^wxfile:\/\//, '');
    s = s.replace(/\/__GAME_FILE_CACHE\//g, '/');
    s = s.replace(/^__GAME_FILE_CACHE\//, '');
    // 绝对 URL
    s = s.replace(/^https?:\/\/[^\/]+\//, '');
    s = s.replace(/^\.\//, '');
    s = s.replace(/^\/+/, '');
    return s;
  }

  /**
   * 宽松查找：插件不同模块对同一个文件会写出不同前缀的路径，
   * 例如同时出现
   *   wxfile://usr/__GAME_FILE_CACHE/wasmcode/a.wasm.br
   *   wasmcode/a.wasm.br
   *   downloaded/a.wasm.br
   * 只要「文件名 + 关键目录」一致，就应该视为同一个文件，
   * 否则 stat 判不存在 → 插件认为缓存损坏 → 反复重下。
   *
   * 匹配优先级：
   *   1. 完全一致的 key
   *   2. 去掉 usr/ 前缀后一致
   *   3. 尾部两段一致（目录名 + 文件名）
   *   4. 文件名一致（最宽松，仅当唯一命中时采用）
   */
  function fsFind(p) {
    var k = normalizeFsPath(p);
    if (!k) return null;
    if (memFS[k]) return memFS[k];

    var k2 = k.replace(/^usr\//, '');
    if (memFS[k2]) return memFS[k2];

    var parts = k2.split('/');
    if (parts.length >= 2) {
      var tail = parts.slice(-2).join('/');
      var hit = null, hits = 0;
      Object.keys(memFS).forEach(function (key) {
        var kk = key.replace(/^usr\//, '');
        if (kk === tail || kk.slice(-(tail.length + 1)) === '/' + tail) { hit = memFS[key]; hits++; }
      });
      if (hits === 1) return hit;
    }

    var base = parts[parts.length - 1];
    var hit2 = null, hits2 = 0;
    Object.keys(memFS).forEach(function (key) {
      var kk = key.replace(/^usr\//, '');
      if (kk === base || kk.slice(-(base.length + 1)) === '/' + base) { hit2 = memFS[key]; hits2++; }
    });
    if (hits2 === 1) return hit2;

    return null;
  }

  function fsExists(p) {
    var k = normalizeFsPath(p);
    if (!k) return false;
    if (fsFind(p)) return true;
    if (fsIsDir(k)) return true;
    return false;
  }

  /**
   * 目录判定。
   * 插件的 statAsyncCatch 会先 stat 父目录（比如 wxfile://usr）来确认
   * 用户数据目录可用，若这里返回「文件不存在」，整条写入链就直接失败，
   * 于是 size 永远是 0。所以必须把所有「有子文件的路径」以及几个根目录
   * 都识别成目录。
   */
  var FS_ROOTS = { usr: 1, temp: 1, store: 1, cache: 1, downloaded: 1, wasmcode: 1, wasmcode1: 1, wasmcode2: 1 };

  function fsIsDir(k) {
    if (!k || k === '.') return true;
    if (FS_ROOTS[k]) return true;
    var prefix = k + '/';
    var keys = Object.keys(memFS);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(prefix) === 0) return true;
    }
    return false;
  }

  function fsSize(p) {
    var rec = fsFind(p);
    if (!rec) return 0;
    if (typeof rec.size === 'number') return rec.size;
    try { return rec.data.byteLength || rec.data.length || 0; } catch (e) { return 0; }
  }

  function fsPut(p, data) {
    var k = normalizeFsPath(p) || p;
    // 统一成 ArrayBuffer 语义，保证 size 可算、后续读取不乱
    var size = 0;
    if (data == null) {
      data = new Uint8Array(0);
    } else if (typeof data === 'string') {
      var enc = new TextEncoder().encode(data);
      size = enc.byteLength; data = enc.buffer;
    } else if (data instanceof ArrayBuffer) {
      size = data.byteLength;
    } else if (data && data.buffer instanceof ArrayBuffer) {
      // Uint8Array / DataView 等
      size = data.byteLength != null ? data.byteLength : data.length;
      if (data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength) {
        data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      } else {
        data = data.buffer;
      }
    } else {
      try { size = data.length || 0; } catch (e) { size = 0; }
    }
    memFS[k] = { data: data, size: size };
    // 同时用原路径登记一份，避免调用方换写法后找不到
    if (k !== p) memFS[p] = memFS[k];
    fsPersist(k, memFS[k]);
    // 登记父目录，让 readdirSync 能列出内容、fsIsDir 能识别目录
    var idx = k.lastIndexOf('/');
    while (idx > 0) {
      var dir = k.slice(0, idx);
      (dirSets[dir] || (dirSets[dir] = Object.create(null)))[k.slice(idx + 1)] = 1;
      idx = dir.lastIndexOf('/');
    }
    return size;
  }

  function fsDel(p) {
    var k = normalizeFsPath(p) || p;
    delete memFS[k];
    if (p !== k) delete memFS[p];
    fsUnpersist(p);
  }

  var dirSets = Object.create(null);

  // 启动时把上次会话持久化的小文件装回内存（游戏存档 / 引导标记等）
  (function restoreFS() {
    try {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var kk = localStorage.key(i);
        if (kk && kk.indexOf(FS_PERSIST_PREFIX) === 0) keys.push(kk);
      }
      keys.forEach(function (kk) {
        var path = kk.slice(FS_PERSIST_PREFIX.length);
        try {
          var b64 = localStorage.getItem(kk);
          var bin = atob(b64);
          var u8 = new Uint8Array(bin.length);
          for (var j = 0; j < bin.length; j++) u8[j] = bin.charCodeAt(j);
          fsPut(path, u8.buffer);
        } catch (e) {
          console.warn('[wx-shim] 恢复存档失败:', path, e && e.message);
        }
      });
      if (keys.length) console.log('[wx-shim] 已恢复持久化文件', keys.length, '个');
    } catch (e) { /* ignore */ }
  })();

  var FileSystemManager = {
    // --- 读 ---
    readFile: function (o) {
      var rec = fsFind((o.path || o.filePath));
      if (rec) {
        // 命中内存缓存：直接返回，且保持异步语义
        setTimeout(function () {
          var d = rec.data;
          if (o.encoding && o.encoding !== 'binary') {
            try { d = new TextDecoder(o.encoding).decode(d); } catch (e) { d = String(d); }
          }
          okCb(o, { data: d }); doneCb(o);
        }, 0);
        return;
      }
      // 回落到本地静态资源（.br / .bundle 等都在 web/assets 下）
      readFileAsync((o.path || o.filePath))
        .then(function (buf) {
          var data = o.encoding ? new TextDecoder(o.encoding === 'binary' ? 'utf-8' : o.encoding).decode(buf) : buf;
          okCb(o, { data: data });
          doneCb(o);
        })
        .catch(function (e) { failCb(o, 'readFile:fail ' + e.message); doneCb(o); });
    },
    readFileSync: function (path, encoding, position, length) {
      var rec = fsFind(path);
      var buf;
      if (rec) {
        buf = rec.data;
        if (typeof buf === 'string') buf = new TextEncoder().encode(buf);
        if (position || length) {
          buf = buf.slice(position || 0, length ? (position || 0) + length : undefined);
        }
      } else {
        buf = readFileSyncSafe(path);
      }
      if (encoding && encoding !== 'binary') return new TextDecoder(encoding).decode(buf);
      return buf;
    },
    readCompressedFile: function (o) {
      // compressionAlgorithm: 'br' | 'deflate'
      Promise.resolve(rec ? rec.data : readFileAsync((o.path || o.filePath)))
        .then(function (buf) {
          // 微信这个 API 返回【已解压】的数据。离线版本我们没有原生 brotli，
          // 上层若真的需要解压会自己处理，这里原样返回。
          okCb(o, { data: buf }); doneCb(o);
        })
        .catch(function (e) { failCb(o, 'readCompressedFile:fail ' + e.message); doneCb(o); });
    },
    readCompressedFileSync: function (p) {
      var k = normalizeFsPath(p);
      var rec = memFS[k] || memFS[p];
      return rec ? rec.data : FileSystemManager.readFileSync(p);
    },
    // --- 写（内存）---
    writeFile: function (o) {
      fsPut(o.filePath, o.data);
      okCb(o); doneCb(o);
    },
    writeFileSync: function (p, data) { fsPut(p, data); },
    appendFile: function (o) {
      var k = normalizeFsPath(o.filePath);
      var rec = memFS[k];
      if (rec) {
        try {
          var a = rec.data, b = o.data;
          var out = new Uint8Array((a.byteLength || a.length || 0) + (b.byteLength || b.length || 0));
          out.set(a, 0); out.set(b, a.byteLength || a.length || 0);
          fsPut(o.filePath, out);
        } catch (e) { fsPut(o.filePath, o.data); }
      } else fsPut(o.filePath, o.data);
      okCb(o); doneCb(o);
    },
    appendFileSync: function (p, d) {
      var o = { filePath: p, data: d, success: null };
      FileSystemManager.appendFile(o);
    },
    unlink: function (o) { fsDel((o.path || o.filePath)); okCb(o); doneCb(o); },
    unlinkSync: function (p) { fsDel(p); },
    mkdir: function (o) { okCb(o); doneCb(o); },
    mkdirSync: function () {},
    rmdir: function (o) {
      var k = normalizeFsPath(o.filePath);
      Object.keys(memFS).forEach(function (key) {
        if (key === k || key.indexOf(k + '/') === 0) {
          delete memFS[key];
          fsUnpersist(key);
        }
      });
      okCb(o); doneCb(o);
    },
    rmdirSync: function (p) { FileSystemManager.rmdir({ filePath: p }); },
    readdir: function (o) {
      var k = normalizeFsPath(o.filePath);
      var prefix = k ? k + '/' : '';
      var set = Object.create(null);
      Object.keys(memFS).forEach(function (key) {
        if (key.indexOf(prefix) === 0) {
          var rest = key.slice(prefix.length);
          set[rest.split('/')[0]] = 1;
        }
      });
      var list = Object.keys(set);
      okCb(o, { files: list }); doneCb(o);
    },
    readdirSync: function (p) {
      var out = [];
      FileSystemManager.readdir({ filePath: p, success: function (r) { out = r.files; } });
      return out;
    },
    // --- 元信息 ---
    stat: function (o) {
      // ⚠️ 微信 FileSystemManager.stat 的参数名是 path（不是 filePath），
      // 而插件（plugin.js 的 statAsyncCatch）正是用 path 调用的。
      // 两个名字都要接受，否则 stat 永远失败 → 插件判定缓存大小为 0。
      var p = o.path || o.filePath;
      var k = normalizeFsPath(p);
      if (fsIsDir(k) && !fsFind(p)) {
        okCb(o, { stats: makeStats(0, p, true) }); doneCb(o); return;
      }
      var size = fsSize(p);
      if (!fsExists(p)) { failCb(o, 'stat:fail no such file or directory ' + p); doneCb(o); return; }
      okCb(o, { stats: makeStats(size, p) }); doneCb(o);
    },
    statSync: function (p) {
      var k = normalizeFsPath(p);
      if (fsIsDir(k) && !memFS[k]) return makeStats(0, p, true);
      if (!fsExists(p)) throw new Error('statSync:fail no such file or directory ' + p);
      return makeStats(fsSize(p), p);
    },
    fstat: function (o) { okCb(o, { stats: makeStats(0) }); doneCb(o); },
    fstatSync: function () { return makeStats(0); },
    access: function (o) {
      if (fsExists(o.path || o.filePath)) { okCb(o); }
      else { failCb(o, 'access:fail no such file or directory'); }
      doneCb(o);
    },
    accessSync: function (p) {
      if (!fsExists(p)) throw new Error('accessSync:fail no such file or directory ' + p);
    },
    // --- 复制 / 移动 / 解压 ---
    copyFile: function (o) {
      try {
        var d = FileSystemManager.readFileSync(o.srcPath);
        fsPut(o.destPath, d);
        okCb(o);
      } catch (e) { failCb(o, 'copyFile:fail ' + e.message); }
      doneCb(o);
    },
    copyFileSync: function (a, b) {
      var d = FileSystemManager.readFileSync(a);
      fsPut(b, d);
    },
    saveFile: function (o) { okCb(o, { savedFilePath: o.tempFilePath }); doneCb(o); },
    saveFileSync: function (p) { return p; },
    getSavedFileList: function (o) { okCb(o, { fileList: [] }); doneCb(o); },
    removeSavedFile: function (o) { fsDel(o.filePath); okCb(o); doneCb(o); },
    getFileInfo: function (o) {
      okCb(o, { size: fsSize((o.path || o.filePath)) }); doneCb(o);
    },
    open: function (o) { okCb(o, { fd: 'fd_' + (++fsFdSeq) }); doneCb(o); },
    close: function (o) { okCb(o); doneCb(o); },
    write: function (o) {
      fsPut(o.filePath || ('fd_' + o.fd), o.data);
      var n = 0; try { n = o.data.byteLength || o.data.length || 0; } catch (e) {}
      okCb(o, { bytesWritten: n }); doneCb(o);
    },
    read: function (o) { okCb(o, { bytesRead: 0, arrayBuffer: new ArrayBuffer(0) }); doneCb(o); },
    ftruncate: function (o) { okCb(o); doneCb(o); },
    truncate: function (o) { okCb(o); doneCb(o); },
    /**
     * rename 必须是「真搬」：插件下载完临时文件后会 rename 到正式路径，
     * 若这里空实现，正式路径永远不存在，stat 就判定缓存未命中。
     */
    rename: function (o) {
      try {
        var k = normalizeFsPath(o.oldPath);
        var rec = memFS[k] || memFS[o.oldPath];
        if (!rec) { failCb(o, 'rename:fail no such file ' + o.oldPath); doneCb(o); return; }
        fsPut(o.newPath, rec.data);
        fsDel(o.oldPath);
        okCb(o);
      } catch (e) { failCb(o, 'rename:fail ' + e.message); }
      doneCb(o);
    },
    renameSync: function (a, b) {
      var k = normalizeFsPath(a);
      var rec = memFS[k] || memFS[a];
      if (!rec) throw new Error('renameSync:fail no such file ' + a);
      fsPut(b, rec.data);
      fsDel(a);
    },
    isFileExist: function (p) { return fsExists(p); },
    isDir: function () { return false; },
    // --- zip（本游戏包内没有，但保留接口）---
    unzip: function (o) { failCb(o, 'unzip:unsupported'); doneCb(o); },
    getFileSystemManagerData: function () {
      var total = 0, n = 0;
      Object.keys(memFS).forEach(function (k) { total += memFS[k].size || 0; n++; });
      return { totalSize: total, currentSize: total, fileCount: n };
    },
    // 调试用：把内存 FS 快照出来
    __dump: function () {
      var o = {};
      Object.keys(memFS).forEach(function (k) { o[k] = memFS[k].size; });
      return o;
    }
  };

  var fsFdSeq = 0;

  /**
   * 预置资源：把本地 assets 里的成品文件直接放进虚拟文件系统。
   *
   * 为什么要这么做？
   *   plugin.js 的加载策略是「先看缓存，没缓存就下载，下载失败再回退」。
   *   离线环境里 CDN 一定失败，虽然插件有回退逻辑，但会走很多弯路
   *   （重试、解压失败、临时文件校验失败……），最终极易半途而废。
   *
   *   直接把 data 包和 wasm 以插件期望的路径写进 FS，它就会判定
   *   「资源有缓存」，走最短路径直接读文件 → 实例化 Unity。
   *
   * 注意：这里写入的是【未压缩】的产物。微信的 .br 是 brotli 压缩包，
   * 插件读出来后会自己解压；如果直接给已解压数据但路径带 .br，
   * 插件解压会失败。所以关掉压缩（见 pluginConfig 里的压缩开关）。
   */
  function preloadIntoFS(done) {
    // 插件(UserDataPathManager)实际使用的根目录是
    //   wxfile://usr/__GAME_FILE_CACHE
    // normalizeFsPath 会把它折成 "usr"，所以这里统一按 "usr/..." 登记。
    var USER = 'usr/';
    var jobs = [];

    // 1) 首包 data（UnityWebData1.0 容器，本身就是未压缩的）
    jobs.push({
      url: ASSET_ROOT + '3e69ea94faae18bb.webgl.data.unityweb.bin',
      targets: [
        USER + 'downloaded/3e69ea94faae18bb.webgl.data.unityweb.bin',
        USER + '3e69ea94faae18bb.webgl.data.unityweb.bin'
      ]
    });

    // 2) wasm 主模块（用已解压的 .wasm，不是 .br）
    jobs.push({
      url: ASSET_ROOT + 'wasmcode_decompressed.wasm',
      targets: [
        USER + 'wasmcode/6e2b8d04a1488f5b.webgl.wasm.code.unityweb.wasm',
        USER + 'downloaded/6e2b8d04a1488f5b.webgl.wasm.code.unityweb.wasm',
        USER + '6e2b8d04a1488f5b.webgl.wasm.code.unityweb.wasm'
      ]
    });

    var pending = jobs.length;
    if (!pending) return done();

    jobs.forEach(function (job) {
      // 用 fetch 异步取：文件有 20MB+，同步 XHR 在部分浏览器上会直接失败
      fetch(job.url, { credentials: 'same-origin' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.arrayBuffer();
        })
        .then(function (buf) {
          job.targets.forEach(function (t) { fsPut(t, buf); });
          log('预置资源:', job.url, buf.byteLength, 'bytes ->', job.targets.join(' | '));
        })
        .catch(function (e) {
          console.warn('[wx-shim] 预置资源失败:', job.url, e && e.message);
        })
        .then(function () {
          if (--pending === 0) done();
        });
    });
  }

  function makeStats(size, path, isDir) {
    return {
      mode: isDir ? 16822 : 33206, size: size || 0,
      lastAccessedTime: Date.now() / 1000, lastModifiedTime: Date.now() / 1000,
      isDirectory: function () { return !!isDir; },
      isFile: function () { return !isDir; },
      path: path || ''
    };
  }

  // ---------------------------------------------------------------------
  // 5. 存储（localStorage 后端，容量放大到 200MB 声明值以避免 Unity 拒绝缓存）
  // ---------------------------------------------------------------------
  var STORAGE_PREFIX = 'wxgame:';
  // ★ GravityEngine 启动时读 gravity_RANDOM_DEVICE_ID 生成 clientId，
  //   为空会抛 ArgumentException(clientId must be required) 并中断初始化链，
  //   连带 Delegate null 'this' 异常 → 场景加载卡死。这里预置一个稳定 UUID。
  function ensureGravityDeviceId() {
    try {
      var mk = function () {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
          var r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
      };
      ['gravity_RANDOM_DEVICE_ID', 'clientId', 'GravityClientId', 'gravity_clientId',
        'GE_CLIENT_ID', 'currentClientId', 'SI.UserId'].forEach(function (k) {
          if (!localStorage.getItem(STORAGE_PREFIX + k)) localStorage.setItem(STORAGE_PREFIX + k, mk());
        });
      var u = localStorage.getItem(STORAGE_PREFIX + 'gravity_RANDOM_DEVICE_ID');
      localStorage.setItem(STORAGE_PREFIX + 'gravity_RANDOM_DEVICE_IDS', JSON.stringify([u]));
    } catch (e) { /* ignore */ }
  }
  ensureGravityDeviceId();
  var Storage = {
    getStorageSync: function (k) {
      if (window.__storageProbe !== false) console.log('[storage-probe] get "' + k + '"');
      var v = localStorage.getItem(STORAGE_PREFIX + k);
      return v == null ? '' : v;
    },
    setStorageSync: function (k, v) {
      try { localStorage.setItem(STORAGE_PREFIX + k, v); } catch (e) {}
      return undefined;
    },
    removeStorageSync: function (k) { localStorage.removeItem(STORAGE_PREFIX + k); },
    clearStorageSync: function () {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var kk = localStorage.key(i);
        if (kk && kk.indexOf(STORAGE_PREFIX) === 0) keys.push(kk);
      }
      keys.forEach(function (k) { localStorage.removeItem(k); });
    },
    getStorageInfoSync: function () {
      var n = 0;
      for (var i = 0; i < localStorage.length; i++) if (localStorage.key(i).indexOf(STORAGE_PREFIX) === 0) n++;
      return { keys: [], currentSize: n, limitSize: 200 * 1024 };
    },
    getStorage: function (o) {
      var v = Storage.getStorageSync(o.key);
      okCb(o, { data: v }); doneCb(o);
    },
    setStorage: function (o) { Storage.setStorageSync(o.key, o.data); okCb(o); doneCb(o); },
    removeStorage: function (o) { Storage.removeStorageSync(o.key); okCb(o); doneCb(o); },
    clearStorage: function (o) { Storage.clearStorageSync(); okCb(o); doneCb(o); }
  };

  // ---------------------------------------------------------------------
  // 6. 音频
  // ---------------------------------------------------------------------
  function createInnerAudioContext() {
    var src = '';
    var listeners = { play: [], pause: [], stop: [], ended: [], error: [], canplay: [], waiting: [], seeking: [], seeked: [], timeupdate: [] };
    var el = null;
    var ac = {
      _src: '', volume: 1, loop: false, autoplay: false, startTime: 0, playbackRate: 1,
      duration: 0, currentTime: 0, paused: true, buffered: 0,
      onCanplay: function (f) { listeners.canplay.push(f); },
      onPlay: function (f) { listeners.play.push(f); },
      onPause: function (f) { listeners.pause.push(f); },
      onStop: function (f) { listeners.stop.push(f); },
      onEnded: function (f) { listeners.ended.push(f); },
      onError: function (f) { listeners.error.push(f); },
      onWaiting: function (f) { listeners.waiting.push(f); },
      onSeeking: function (f) { listeners.seeking.push(f); },
      onSeeked: function (f) { listeners.seeked.push(f); },
      onTimeUpdate: function (f) { listeners.timeupdate.push(f); },
      offCanplay: function () { listeners.canplay.length = 0; },
      offPlay: function () { listeners.play.length = 0; },
      offPause: function () { listeners.pause.length = 0; },
      offStop: function () { listeners.stop.length = 0; },
      offEnded: function () { listeners.ended.length = 0; },
      offError: function () { listeners.error.length = 0; },
      offWaiting: function () { listeners.waiting.length = 0; },
      offSeeking: function () { listeners.seeking.length = 0; },
      offSeeked: function () { listeners.seeked.length = 0; },
      offTimeUpdate: function () { listeners.timeupdate.length = 0; },
      play: function () { if (el) { el.play().catch(function () {}); } ac.paused = false; },
      pause: function () { if (el) el.pause(); ac.paused = true; },
      stop: function () { if (el) { el.pause(); el.currentTime = 0; } ac.paused = true; },
      seek: function (t) { if (el) el.currentTime = t; },
      destroy: function () { if (el) { el.pause(); el.src = ''; } el = null; }
    };
    function attach() {
      if (el) return;
      var node = new Audio();          // 闭包持有真实节点：即使 el 被置空，回调也不会 NPE
      el = node;
      node.crossOrigin = 'anonymous';
      node.preload = 'auto';
      // 所有回调都只操作 node，绝不解引用外层的 el（destroy 后会置 null）
      function dur() { var d = node.duration; return isFinite(d) ? d : 0; }
      node.addEventListener('canplay', function () { ac.duration = dur(); listeners.canplay.forEach(function (f) { try { f(); } catch (e) {} }); });
      node.addEventListener('loadedmetadata', function () { ac.duration = dur(); });
      node.addEventListener('play', function () { ac.paused = false; listeners.play.forEach(function (f) { try { f(); } catch (e) {} }); });
      node.addEventListener('pause', function () { ac.paused = true; listeners.pause.forEach(function (f) { try { f(); } catch (e) {} }); });
      node.addEventListener('ended', function () { listeners.ended.forEach(function (f) { try { f(); } catch (e) {} }); });
      node.addEventListener('error', function () { listeners.error.forEach(function (f) { try { f(ac._src); } catch (e) {} }); });
      node.addEventListener('timeupdate', function () { ac.currentTime = node.currentTime || 0; ac.duration = dur(); listeners.timeupdate.forEach(function (f) { try { f(); } catch (e) {} }); });
      node.addEventListener('seeking', function () { listeners.seeking.forEach(function (f) { try { f(); } catch (e) {} }); });
      node.addEventListener('seeked', function () { listeners.seeked.forEach(function (f) { try { f(); } catch (e) {} }); });
    }
    Object.defineProperty(ac, 'src', {
      get: function () { return ac._src; },
      set: function (v) {
        ac._src = v || '';
        if (!v) return;
        attach();
        var u = v;
        if (!/^(https?:|data:|blob:)/.test(u)) {
          u = ASSET_ROOT + normalizePath(u).replace(/^audios\//, 'audios/');
        }
        el.src = u;
        el.loop = ac.loop;
        el.volume = ac.volume;
        log('InnerAudio src =', u);
      }
    });
    Object.defineProperty(ac, 'loop', { get: function () { return el ? el.loop : ac._loop; }, set: function (v) { ac._loop = v; if (el) el.loop = v; } });
    Object.defineProperty(ac, 'volume', { get: function () { return el ? el.volume : 1; }, set: function (v) { if (el) el.volume = v; } });
    return ac;
  }

  // WebAudioContext：直接返回浏览器 AudioContext（Unity 音频全靠它）
  var WXAudioContextCtor = null;
  function createWebAudioContext() {
    var Native = window.__NativeAudioContext;
    if (!Native) Native = window.AudioContext || window.webkitAudioContext;
    var ctx = new Native();
    // 微信的 WebAudioContext 有 resume/suspend，浏览器原生也有；补齐 onstatechange
    return ctx;
  }

  // ---------------------------------------------------------------------
  // 7. 广告 —— 关键：全部 mock 为「秒过」，从而跳过看广告解锁
  // ---------------------------------------------------------------------
  var AD_AUTO_COMPLETE = true;
  var adStats = { rewarded: 0, interstitial: 0, banner: 0, custom: 0 };

  function makeRewardedVideoAd(opts) {
    var loadCbs = [], errCbs = [], closeCbs = [];
    var ad = {
      adUnitId: (opts && opts.adUnitId) || 'adunit-mock',
      _loaded: true,
      load: function () { ad._loaded = true; loadCbs.forEach(function (f) { try { f(); } catch (e) {} }); return Promise.resolve(); },
      show: function () {
        adStats.rewarded++;
        logAlways('🎬 激励视频已跳过（mock），直接发放奖励');
        showAdOverlay('激励视频 · 已跳过（免广告）');
        // 微信行为：show 成功 -> onClose 回调 { isEnded: true }
        setTimeout(function () {
          hideAdOverlay();
          closeCbs.forEach(function (f) {
            try { f({ isEnded: true, count: 1 }); } catch (e) { console.error(e); }
          });
        }, AD_AUTO_COMPLETE ? 350 : 0);
        return Promise.resolve();
      },
      destroy: function () { loadCbs.length = errCbs.length = closeCbs.length = 0; },
      offLoad: function (f) { var i = loadCbs.indexOf(f); if (i >= 0) loadCbs.splice(i, 1); },
      offError: function (f) { var i = errCbs.indexOf(f); if (i >= 0) errCbs.splice(i, 1); },
      offClose: function (f) { var i = closeCbs.indexOf(f); if (i >= 0) closeCbs.splice(i, 1); },
      onLoad: function (f) { loadCbs.push(f); },
      onError: function (f) { errCbs.push(f); },
      onClose: function (f) { closeCbs.push(f); }
    };
    ad.onError(function () {});
    // 首次调度 onLoad
    setTimeout(function () { loadCbs.forEach(function (f) { try { f(); } catch (e) {} }); }, 0);
    return ad;
  }

  // ---------------------------------------------------------------------
  // ⚠️ 插屏/横幅等广告：必须有完整的 onLoad/onClose 生命周期！
  //   真实微信行为：interstitialAd.show() → 用户关闭 → onClose 回调。
  //   游戏侧链路（il2cpp 逆向确认）：
  //     SIADManager.ShowInterstitialAd
  //       → SkyIsland.IAA.Impl.Wx.InterstitialAd.Show（注册 OnClose）
  //       → SkyIsland.IAA.IAA.OnInterstitialAdClose / ResetIsShowingInterstitialAd
  //   结算界面点【放弃】后：关闭结算 → ShowInterstitialAd → 等待 onClose
  //   → 才会执行 ContinueToMainMenu 切回主城。
  //   之前 mock 的 onClose 是空函数（注册即丢弃），onClose 永远不触发
  //   → IsShowingInterstitialAd 状态无法复位 → 结算框关闭后永久卡死。
  // ---------------------------------------------------------------------
  function makeOtherAd(kind) {
    var loadCbs = [], errCbs = [], closeCbs = [], resizeCbs = [];
    function fire(list, arg) {
      // 拷贝一份再遍历：回调里可能注册/注销监听
      var arr = list.slice(0);
      for (var i = 0; i < arr.length; i++) {
        try { arr[i](arg); } catch (e) { console.error('[ad-mock] callback error', e); }
      }
    }
    var ad = {
      adUnitId: 'adunit-mock',
      style: { left: 0, top: 0, width: 0, height: 0, realWidth: 0, realHeight: 0 },
      load: function () {
        // 微信行为：load 成功 → onLoad
        setTimeout(function () { fire(loadCbs); }, 0);
        return Promise.resolve();
      },
      show: function () {
        adStats[kind] = (adStats[kind] || 0) + 1;
        if (kind === 'interstitial') {
          logAlways('📺 插屏广告已跳过（mock），350ms 后自动关闭');
          showAdOverlay('插屏广告 · 已跳过（免广告）');
          // 微信行为：show 成功 →（用户关闭）→ onClose
          setTimeout(function () {
            hideAdOverlay();
            fire(closeCbs, {});
          }, 350);
        } else {
          log(kind + ' ad show -> mocked');
        }
        return Promise.resolve();
      },
      hide: function () { return Promise.resolve(); },
      destroy: function () { loadCbs.length = errCbs.length = closeCbs.length = resizeCbs.length = 0; },
      onLoad: function (f) { if (f) loadCbs.push(f); },
      offLoad: function (f) { var i = loadCbs.indexOf(f); if (i >= 0) loadCbs.splice(i, 1); },
      onError: function (f) { if (f) errCbs.push(f); },
      offError: function (f) { var i = errCbs.indexOf(f); if (i >= 0) errCbs.splice(i, 1); },
      onClose: function (f) { if (f) closeCbs.push(f); },
      offClose: function (f) { var i = closeCbs.indexOf(f); if (i >= 0) closeCbs.splice(i, 1); },
      onResize: function (f) { if (f) resizeCbs.push(f); },
      offResize: function (f) { var i = resizeCbs.indexOf(f); if (i >= 0) resizeCbs.splice(i, 1); }
    };
    return ad;
  }

  // 广告提示浮层
  var adOverlayEl = null;
  function showAdOverlay(text) {
    if (!adOverlayEl) {
      adOverlayEl = document.createElement('div');
      adOverlayEl.id = 'wx-ad-overlay';
      adOverlayEl.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.82);' +
        'display:flex;align-items:center;justify-content:center;z-index:99999;color:#fff;' +
        'font:600 15px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;text-align:center;pointer-events:none;';
      document.body.appendChild(adOverlayEl);
    }
    adOverlayEl.textContent = text;
    adOverlayEl.style.display = 'flex';
  }
  function hideAdOverlay() { if (adOverlayEl) adOverlayEl.style.display = 'none'; }

  // ---------------------------------------------------------------------
  // 8. 触摸 —— DOM 事件 -> wx 回调
  // ---------------------------------------------------------------------
  var touchHandlers = { start: [], move: [], end: [], cancel: [] };
  var touchEl = null;

  function toTouchList(ev) {
    var list = [];
    var src = ev.changedTouches || ev.touches || [];
    for (var i = 0; i < src.length; i++) {
      var t = src[i];
      var xy = mapToCanvas(t.clientX, t.clientY);
      list.push({
        identifier: t.identifier || 0,
        pageX: xy[0], pageY: xy[1],
        clientX: xy[0], clientY: xy[1],
        x: xy[0], y: xy[1],
        // Unity 需要的是 canvas 后备存储坐标
        force: t.force || 1
      });
    }
    return list;
  }

  function bindTouchEvents() {
    if (touchEl) return;
    touchEl = mainCanvas || document.body;
    var opts = { passive: false };
    var lastTapLog = 0;
    function emit(kind, ev) {
      try {
        var list = toTouchList(ev);
        if (kind === 'start' && list[0]) {
          var now = Date.now();
          if (now - lastTapLog > 120) {          // 拖动时限流
            lastTapLog = now;
            ringPush('[tap] x=' + Math.round(list[0].x) + ' y=' + Math.round(list[0].y));
          }
        }
        if (window.__touchProbe) console.log('[touch-probe] ' + kind + ' handlers=' + touchHandlers[kind].length + ' pts=' + list.length + ' xy=' + (list[0] ? list[0].x + ',' + list[0].y : '-'));
        touchHandlers[kind].forEach(function (f) {
          try { f({ touches: list, changedTouches: list, timeStamp: performance.now() }); } catch (e) { console.error(e); }
        });
      } catch (e) { /* ignore */ }
    }
    window.addEventListener('touchstart', function (e) { if (e.target === mainCanvas || mainCanvas.contains(e.target)) { e.preventDefault(); emit('start', e); } }, opts);
    window.addEventListener('touchmove', function (e) { if (e.target === mainCanvas || mainCanvas.contains(e.target)) { e.preventDefault(); emit('move', e); } }, opts);
    window.addEventListener('touchend', function (e) { if (e.target === mainCanvas || mainCanvas.contains(e.target)) { e.preventDefault(); emit('end', e); } }, opts);
    window.addEventListener('touchcancel', function (e) { emit('cancel', e); }, opts);

    // 鼠标 / 指针事件 -> 触摸事件（桌面浏览器可玩）
    var mouseDown = false;
    function mouseToList(ev) {
      var xy = mapToCanvas(ev.clientX, ev.clientY);
      return [{ identifier: 0, pageX: xy[0], pageY: xy[1], clientX: xy[0], clientY: xy[1], x: xy[0], y: xy[1], force: 1 }];
    }
    function emitMouse(kind, ev) {
      var list = mouseToList(ev);
      touchHandlers[kind].forEach(function (f) {
        try { f({ touches: kind === 'end' ? [] : list, changedTouches: list, timeStamp: performance.now() }); } catch (e) { console.error(e); }
      });
    }
    (mainCanvas || document.body).addEventListener('mousedown', function (e) { mouseDown = true; e.preventDefault(); emitMouse('start', e); });
    window.addEventListener('mousemove', function (e) { if (mouseDown) emitMouse('move', e); });
    window.addEventListener('mouseup', function (e) { if (mouseDown) { mouseDown = false; emitMouse('end', e); } });
    (mainCanvas || document.body).addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // ── 自动玩输入注入 ────────────────────────────────────────────────
    // 为什么需要它：weapp-adapter 会把 canvas 原型链上的 addEventListener /
    // dispatchEvent 替换成基于 WeakMap 的假实现。页面内 dispatchEvent(new
    // MouseEvent(...)) 因此不会进入本 shim 的监听器，而是打给游戏自己的
    // 'mousedown' 监听器，触发 removeEventListener 里 r.get(this) 为 undefined
    // 的崩溃。所以自动玩改为直接调用 touchHandlers，投递与真实玩家输入
    // 结构完全一致的数据（与 toTouchList/emitMouse 同构）。
    //
    // 坐标：nx/ny 为画布归一化坐标(0..1)，内部换算为画布 CSS 局部像素。
    function injectTouch(kind, nx, ny) {
      var c = mainCanvas || document.querySelector('canvas');
      if (!c) return 0;
      var w = c.clientWidth || c.width || 1;
      var h = c.clientHeight || c.height || 1;
      var cx = Math.max(0, Math.min(w, nx * w));
      var cy = Math.max(0, Math.min(h, ny * h));
      var list = [{ identifier: 0, pageX: cx, pageY: cy, clientX: cx, clientY: cy, x: cx, y: cy, force: 1 }];
      var handlers = touchHandlers[kind] || [];
      for (var i = 0; i < handlers.length; i++) {
        try {
          handlers[i]({ touches: kind === 'end' ? [] : list, changedTouches: list, timeStamp: performance.now() });
        } catch (e) { console.error('[inject:' + kind + ']', e); }
      }
      return handlers.length;
    }
    window.__wxInjectTouch = injectTouch;
    window.__wxTouchHandlerCount = function () {
      return { start: touchHandlers.start.length, move: touchHandlers.move.length, end: touchHandlers.end.length };
    };

    // Pointer 事件（触屏笔记本 / 移动端浏览器）
    var pointerDown = false;
    function pointerToList(ev) {
      var xy = mapToCanvas(ev.clientX, ev.clientY);
      return [{ identifier: ev.pointerId || 0, pageX: xy[0], pageY: xy[1], clientX: xy[0], clientY: xy[1], x: xy[0], y: xy[1], force: ev.pressure || 1 }];
    }
    function emitPointer(kind, ev) {
      var list = pointerToList(ev);
      touchHandlers[kind].forEach(function (f) {
        try { f({ touches: kind === 'end' ? [] : list, changedTouches: list, timeStamp: performance.now() }); } catch (e) { console.error(e); }
      });
    }
    if (window.PointerEvent) {
      (mainCanvas || document.body).addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'mouse') return; // 鼠标已由上面处理
        pointerDown = true; e.preventDefault(); emitPointer('start', e);
      });
      window.addEventListener('pointermove', function (e) { if (pointerDown && e.pointerType !== 'mouse') emitPointer('move', e); });
      window.addEventListener('pointerup', function (e) { if (pointerDown && e.pointerType !== 'mouse') { pointerDown = false; emitPointer('end', e); } });
      window.addEventListener('pointercancel', function (e) { if (pointerDown) { pointerDown = false; emitPointer('cancel', e); } });
    }

    // 键盘 -> wx.onKeyboardInput（部分玩法可能用到，仅做透传）
    window.addEventListener('keydown', function (e) {
      keyboardInputHandlers.forEach(function (f) { try { f({ value: e.key }); } catch (err) {} });
    });
  }

  var keyboardInputHandlers = [];
  var keyboardConfirmHandlers = [];
  var keyboardCompleteHandlers = [];

  // ---------------------------------------------------------------------
  // 9. 其它能力（云开发 / 蓝牙 / 陀螺仪 / 聊天 / 开放数据域 ...）
  // ---------------------------------------------------------------------
  function noop() {}
  function emptyObj() { return {}; }

  function makeSafeClass(name) {
    // 返回一个可以任意调用（链式）且不会抛错的桩对象。
    // 用 Proxy 包住一个普通函数；函数自带的 length/name/prototype 会被转发。
    var target = function () { return makeSafeClass(name); };
    return new Proxy(target, {
      get: function (t, prop) {
        // 内部约定：任何 Symbol 一律交回原生行为，否则 map/迭代/类型判断全会坏
        if (typeof prop === 'symbol') return t[prop];
        if (prop === 'then') return undefined;   // 不要被 Promise 同化
        if (prop === 'length') return 0;
        if (prop === 'name') return name;
        if (prop === 'prototype') return t.prototype;
        if (prop === 'constructor') return target;
        if (prop === 'toString' || prop === 'valueOf' || prop === 'toJSON') {
          return function () { return 0; };
        }
        return function () { return makeSafeClass(name + '.' + String(prop)); };
      },
      has: function () { return true; },
      set: function () { return true; },          // 允许赋值，静默忽略
      apply: function () { return makeSafeClass(name + '()'); },
      construct: function () { return makeSafeClass('new ' + name); }
    });
  }

  // 游戏性能巡检（getGameAudits）的共享状态。
  // 插件除了 new BaseTask / new CustomCheckType 之外，还会读 messenger 和
  // EventType（DetectEventMessageType.BeforeResult 等）来做事件订阅，
  // 这里给出一份完整但永不触发的实现。
  var AUDIT_SHIM = {
    stateCbs: [],
    registered: [],
    EventType: {
      DetectEventMessageType: {
        BeforeResult: 'detect:before-result',
        AfterResult: 'detect:after-result',
        Result: 'detect:result'
      },
      AuditState: { Start: 0, Stop: 1, Finish: 2 }
    },
    messenger: {
      on: function () {}, off: function () {}, emit: function () {},
      once: function () {}, send: function () {}, post: function () {}
    },
    base: function (BaseTask, CustomCheckType) {
      return {
        messenger: AUDIT_SHIM.messenger,
        EventType: AUDIT_SHIM.EventType,
        BaseTask: BaseTask,
        CustomCheckType: CustomCheckType,
        // 插件注册巡检任务；本地不执行任何检测，仅记录以便排查
        register: function (types) {
          try { AUDIT_SHIM.registered = AUDIT_SHIM.registered.concat(types || []); } catch (e) {}
        },
        unregister: function () { AUDIT_SHIM.registered.length = 0; },
        start: noop, stop: noop, finish: noop,
        report: noop, getResult: function () { return []; },
        isSupported: function () { return false; }
      };
    }
  };

  function makeEventListenerRegistrar(list) {    return function (cb) {
      if (typeof cb === 'function') list.push(cb);
      // 微信 onXxx 允许重复注册，返回值无意义
    };
  }
  function makeEventListenerUnregistrar(list) {
    return function (cb) {
      if (typeof cb !== 'function') { list.length = 0; return; }
      var i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
  }

  // ---------------------------------------------------------------------
  // 10. 组装 wx 对象
  // ---------------------------------------------------------------------
  // 保存浏览器原生 AudioContext，供 framework 包装前使用
  window.__NativeAudioContext = window.AudioContext || window.webkitAudioContext;

  var onShowList = [], onHideList = [], onErrorList = [], onUnhandledList = [];
  var onAudioInterruptBegin = [], onAudioInterruptEnd = [];
  var onNetworkList = [], onMemoryWarnList = [];
  var onShareAppMessageList = [], onShareTimelineList = [], onAddToFavoritesList = [];
  var onCopyUrlList = [], onHandoffList = [], onGameLiveStateList = [];
  var realtimeLogErrors = [];

  var wx = {
    // ===== 环境信息 =====
    env: WX_ENV,
    getSystemInfoSync: getSystemInfoSync,
    getSystemInfo: function (o) { okCb(o, getSystemInfoSync()); doneCb(o); },
    getDeviceInfo: function () {
      var v = computeGameViewport();
      return { brand: 'iPhone', model: 'iPhone14,2', system: FAKE_SYSTEM, platform: FAKE_PLATFORM,
        memorySize: 4096, abi: 'arm64-v8a', cpuType: 'arm64', benchmarkLevel: 50 };
    },
    getAppBaseInfo: function () {
      return { SDKVersion: '3.5.0', language: 'zh_CN', version: '8.0.50', theme: 'light',
        enableDebug: false, host: { env: 'WeChat', version: 587405312 }, fontSizeSetting: 16 };
    },
    getWindowInfo: function () {
      // 同样返回活值对象（游戏侧可能按引用缓存）
      var o = {};
      [['pixelRatio', function () { return DPR(); }],
       ['screenWidth', function () { return computeGameViewport().width; }],
       ['screenHeight', function () { return computeGameViewport().height; }],
       ['windowWidth', function () { return computeGameViewport().width; }],
       ['windowHeight', function () { return computeGameViewport().height; }],
       ['statusBarHeight', function () { return 0; }],
       ['screenTop', function () { return 0; }]
      ].forEach(function (p) { defineLive(o, { key: p[0], get: p[1] }); });
      var safe = {};
      [['left', function () { return 0; }],
       ['top', function () { return 0; }],
       ['right', function () { return computeGameViewport().width; }],
       ['bottom', function () { return computeGameViewport().height; }],
       ['width', function () { return computeGameViewport().width; }],
       ['height', function () { return computeGameViewport().height; }]
      ].forEach(function (p) { defineLive(safe, { key: p[0], get: p[1] }); });
      defineLive(o, { key: 'safeArea', get: function () { return safe; } });
      return o;
    },
    getSystemSetting: function () { return { bluetoothEnabled: false, locationEnabled: false, wifiEnabled: true, deviceOrientation: 'portrait' }; },
    getAppAuthorizeSetting: function () { return { albumAuthorized: 'authorized', cameraAuthorized: 'authorized', microphoneAuthorized: 'authorized', notificationAuthorized: 'authorized', locationAuthorized: 'authorized' }; },
    getLaunchOptionsSync: function () { return { scene: 1001, query: {}, referrerInfo: {}, apiCategory: 'default' }; },
    getEnterOptionsSync: function () { return { scene: 1001, query: {} }; },
    getAccountInfoSync: function () {
      return { miniProgram: { appId: 'wx97389648b73dfeca', envVersion: 'release', version: '' },
        plugin: { appId: '', version: '' } };
    },
    getPerformance: function () {
      return { now: function () { return performance.now(); } };
    },
    getNetworkType: function (o) { okCb(o, { networkType: 'wifi', signalStrength: 4 }); },
    onNetworkStatusChange: makeEventListenerRegistrar(onNetworkList),
    offNetworkStatusChange: makeEventListenerUnregistrar(onNetworkList),

    // ===== 生命周期 =====
    onShow: makeEventListenerRegistrar(onShowList),
    offShow: makeEventListenerUnregistrar(onShowList),
    onHide: makeEventListenerRegistrar(onHideList),
    offHide: makeEventListenerUnregistrar(onHideList),
    onError: makeEventListenerRegistrar(onErrorList),
    offError: makeEventListenerUnregistrar(onErrorList),
    onUnhandledRejection: makeEventListenerRegistrar(onUnhandledList),
    offUnhandledRejection: makeEventListenerUnregistrar(onUnhandledList),
    onAudioInterruptionBegin: makeEventListenerRegistrar(onAudioInterruptBegin),
    offAudioInterruptionBegin: makeEventListenerUnregistrar(onAudioInterruptBegin),
    onAudioInterruptionEnd: makeEventListenerRegistrar(onAudioInterruptEnd),
    offAudioInterruptionEnd: makeEventListenerUnregistrar(onAudioInterruptEnd),
    // 浏览器里由真实 window 的 resize 事件驱动（见 onBrowserResize）
    onWindowResize: makeEventListenerRegistrar(winResizeCbs),
    offWindowResize: makeEventListenerUnregistrar(winResizeCbs),
    onMemoryWarning: makeEventListenerRegistrar(onMemoryWarnList),
    offMemoryWarning: makeEventListenerUnregistrar(onMemoryWarnList),
    onNeedPrivacyAuthorization: function (cb) { /* 授权 UI 由我们自动同意 */ setTimeout(function () { try { cb && cb({ event: 'agree', buttonId: '' }); } catch (e) {} }, 0); },
    requirePrivacyAuthorize: function (o) { okCb(o); doneCb(o); },
    onPrivacyAuthorize: noop,

    // ===== 运行时 =====
    setPreferredFramesPerSecond: noop,
    triggerGC: noop,
    getRealtimeLogManager: function () {
      return {
        info: noop, warn: noop, error: function () { realtimeLogErrors.push(Array.prototype.slice.call(arguments)); console.warn.apply(console, ['[rtlog]'].concat(Array.prototype.slice.call(arguments))); },
        setFilterMsg: noop, addFilterMsg: noop
      };
    },
    getLogManager: function () {
      return { log: noop, info: noop, warn: noop, debug: noop, error: function () { console.error.apply(console, arguments); }, setFilterMsg: noop, addFilterMsg: noop, start: noop, stop: noop };
    },
    updateWeChatApp: function () { location.reload(); },
    restartMiniProgram: function () { location.reload(); },
    exitMiniProgram: function (o) { okCb(o); },
    getUpdateManager: function () { return makeSafeClass('UpdateManager'); },
    reportUserBehaviorBranchAnalytics: noop,
    reportEvent: noop,
    reportMonitor: noop,
    reportPerformance: noop,

    // ===== 画布 / 图像 =====
    createCanvas: createCanvas,
    createImage: createImage,
    createOffscreenCanvas: function (o) {
      var c = document.createElement('canvas');
      if (o) { c.width = o.width || 1; c.height = o.height || 1; }
      return c;
    },
    createBufferURL: function (buf, type) {
      try { return URL.createObjectURL(new Blob([buf], { type: type || 'application/octet-stream' })); }
      catch (e) { return ''; }
    },
    revokeBufferURL: function (u) { try { URL.revokeObjectURL(u); } catch (e) {} },

    // ===== 文件系统 =====
    getFileSystemManager: function () { return FileSystemManager; },

    // ===== 存储 =====
    getStorageSync: Storage.getStorageSync,
    setStorageSync: Storage.setStorageSync,
    removeStorageSync: Storage.removeStorageSync,
    clearStorageSync: Storage.clearStorageSync,
    getStorageInfoSync: Storage.getStorageInfoSync,
    getStorage: Storage.getStorage,
    setStorage: Storage.setStorage,
    removeStorage: Storage.removeStorage,
    clearStorage: Storage.clearStorage,
    getStorageInfo: function (o) { okCb(o, Storage.getStorageInfoSync()); doneCb(o); },

    // ===== 网络 =====
    request: function (o) {
      var url = o.url || '';
      var abs = /^https?:/.test(url) ? url : (ASSET_ROOT + normalizePath(url));
      fetch(abs, { method: o.method || 'GET', headers: o.header || {}, credentials: 'same-origin' })
        .then(function (r) {
          var ct = r.headers.get('content-type') || '';
          if (o.responseType === 'arraybuffer') return r.arrayBuffer().then(function (b) { return { data: b, statusCode: r.status, header: {}, contentType: ct }; });
          return r.text().then(function (t) { return { data: t, statusCode: r.status, header: {}, contentType: ct }; });
        })
        .then(function (res) {
          if (/openid|login/i.test(url) && typeof res.data === 'string') console.log('[wx.request] ' + url.slice(0, 110) + ' -> ' + res.data.slice(0, 200));
          okCb(o, res); doneCb(o);
        })
        .catch(function (e) { failCb(o, 'request:fail ' + e.message); doneCb(o); });
      return { abort: noop, onHeadersReceived: noop, offHeadersReceived: noop };
    },
    downloadFile: function (o) {
      var url = o.url || '';

      /**
       * 离线重定向：微信原版从 CDN 拉
       *   https://voodoo.ali.landintheair.com/SniperSiege/wx/<ver>/<md5>.webgl.data.unityweb.bin.br
       * 本地把同名文件放在 web/assets/ 下，直接回本地，绝不联网。
       * 注意返回的 tempFilePath 必须是「虚拟 FS 里真实存在、且 size 正确」的路径，
       * 否则插件 writeFileSafe 之后的 getFileSize 会读到 0，判定缓存损坏。
       */
      var name = (url.split('?')[0].split('/').pop()) || 'file';
      var candidates = [];
      if (/^https?:/.test(url)) {
        candidates.push(ASSET_ROOT + name);              // 同名 .br
        candidates.push(ASSET_ROOT + name.replace(/\.br$/, ''));
      } else {
        candidates.push(ASSET_ROOT + normalizePath(url));
        candidates.push(ASSET_ROOT + name);
      }

      (function tryNext(i) {
        if (i >= candidates.length) {
          console.warn('[wx-shim] downloadFile 无本地对应资源:', url);
          failCb(o, 'downloadFile:fail 404'); doneCb(o);
          return;
        }
        fetch(candidates[i], { credentials: 'same-origin' })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.arrayBuffer();
          })
          .then(function (buf) {
            var p = 'temp/' + name;
            fsPut(p, buf);
            log('downloadFile 本地命中:', candidates[i], buf.byteLength, 'bytes');
            okCb(o, { tempFilePath: p, statusCode: 200, filePath: p });
            doneCb(o);
            if (typeof o.progress === 'function') o.progress({ progress: 100, totalBytesWritten: buf.byteLength, totalBytesExpectedToWrite: buf.byteLength });
          })
          .catch(function () { tryNext(i + 1); });
      })(0);

      return { abort: noop, onProgressUpdate: noop, offProgressUpdate: noop, onHeadersReceived: noop, offHeadersReceived: noop };
    },
    uploadFile: function (o) { okCb(o, { statusCode: 200, data: '{}' }); doneCb(o); return { abort: noop, onProgressUpdate: noop }; },
    connectSocket: function () { return makeSafeClass('SocketTask'); },
    createTCPSocket: function () { return makeSafeClass('TCPSocket'); },
    createUDPSocket: function () { return makeSafeClass('UDPSocket'); },

    // ===== 分包（本地直接成功） =====
    loadSubpackage: function (o) {
      var name = o.name || '';
      logAlways('📦 加载分包(mock):', name, '-> 直接从本地 assets/ 读取');
      var progressCbs = [];
      var task = {
        onProgressUpdate: function (cb) { if (typeof cb === 'function') progressCbs.push(cb); },
        offProgressUpdate: function (cb) { var i = progressCbs.indexOf(cb); if (i >= 0) progressCbs.splice(i, 1); },
        await: function () {
          // waiterMode 时微信返回 await()，阻塞到分包就绪；本地已就绪，直接返回
          return Promise.resolve();
        }
      };
      setTimeout(function () {
        okCb(o, { errMsg: 'loadSubpackage:ok' });
        doneCb(o);
      }, 0);
      return task;
    },

    // ===== 音频 =====
    createInnerAudioContext: createInnerAudioContext,
    createWebAudioContext: createWebAudioContext,
    getAvailableAudioSources: function (o) { okCb(o, { audioSources: ['album', 'camera', 'microphone'] }); doneCb(o); },
    createAudioContext: function (o) { return makeSafeClass('AudioContext'); },
    setInnerAudioOption: function (o) { okCb(o); doneCb(o); },
    getSetting: function (o) { okCb(o, { authSetting: {} }); doneCb(o); },

    // ===== 触摸 =====
    onTouchStart: makeEventListenerRegistrar(touchHandlers.start),
    onTouchMove: makeEventListenerRegistrar(touchHandlers.move),
    onTouchEnd: makeEventListenerRegistrar(touchHandlers.end),
    onTouchCancel: makeEventListenerRegistrar(touchHandlers.cancel),
    offTouchStart: makeEventListenerUnregistrar(touchHandlers.start),
    offTouchMove: makeEventListenerUnregistrar(touchHandlers.move),
    offTouchEnd: makeEventListenerUnregistrar(touchHandlers.end),
    offTouchCancel: makeEventListenerUnregistrar(touchHandlers.cancel),

    // ===== 键盘 =====
    onKeyboardInput: makeEventListenerRegistrar(keyboardInputHandlers),
    offKeyboardInput: makeEventListenerUnregistrar(keyboardInputHandlers),
    onKeyboardConfirm: makeEventListenerRegistrar(keyboardConfirmHandlers),
    offKeyboardConfirm: makeEventListenerUnregistrar(keyboardConfirmHandlers),
    onKeyboardComplete: makeEventListenerRegistrar(keyboardCompleteHandlers),
    offKeyboardComplete: makeEventListenerUnregistrar(keyboardCompleteHandlers),
    showKeyboard: function (o) { okCb(o); doneCb(o); },
    hideKeyboard: function (o) { okCb(o); doneCb(o); },
    updateKeyboard: function (o) { okCb(o); doneCb(o); },
    getKeyboardFrame: function (o) { okCb(o, { top: 0, bottom: 0, left: 0, right: 0, width: CSS_W(), height: 0 }); doneCb(o); },
    onKeyboardHeightChange: noop,

    // ===== 广告（★ 免广告核心）=====
    createRewardedVideoAd: makeRewardedVideoAd,
    createInterstitialAd: function () { return makeOtherAd('interstitial'); },
    createBannerAd: function () { return makeOtherAd('banner'); },
    createCustomAd: function () { return makeOtherAd('custom'); },
    createGridAd: function () { return makeOtherAd('grid'); },
    createVideoAd: function () { return makeOtherAd('video'); },
    createGameBannerAd: function () { return makeOtherAd('gameBanner'); },

    // ===== 分享 / 收藏 =====
    shareAppMessage: function (o) { log('shareAppMessage', o); okCb(o); },
    onShareAppMessage: makeEventListenerRegistrar(onShareAppMessageList),
    offShareAppMessage: makeEventListenerUnregistrar(onShareAppMessageList),
    showShareMenu: function (o) { okCb(o); },
    hideShareMenu: function (o) { okCb(o); },
    onShareTimeline: makeEventListenerRegistrar(onShareTimelineList),
    offShareTimeline: makeEventListenerUnregistrar(onShareTimelineList),
    onAddToFavorites: makeEventListenerRegistrar(onAddToFavoritesList),
    offAddToFavorites: makeEventListenerUnregistrar(onAddToFavoritesList),
    onCopyUrl: makeEventListenerRegistrar(onCopyUrlList),
    offCopyUrl: makeEventListenerUnregistrar(onCopyUrlList),
    onHandoff: makeEventListenerRegistrar(onHandoffList),
    offHandoff: makeEventListenerUnregistrar(onHandoffList),
    onGameLiveStateChange: makeEventListenerRegistrar(onGameLiveStateList),
    offGameLiveStateChange: makeEventListenerUnregistrar(onGameLiveStateList),

    // ===== UI =====
    showModal: function (o) {
      var msg = (o && (o.content || o.title)) || '';
      logAlways('⚠️ showModal:', msg);
      // 自动确认，避免游戏流程被阻塞（原版用于网络异常提示）
      setTimeout(function () {
        okCb(o, { confirm: true, cancel: false });
        doneCb(o);
      }, 0);
    },
    showToast: function (o) { log('toast:', o && o.title); okCb(o); doneCb(o); },
    hideToast: function (o) { okCb(o); doneCb(o); },
    showLoading: function (o) { okCb(o); },
    hideLoading: function (o) { okCb(o); },
    showActionSheet: function (o) { okCb(o, { tapIndex: 0 }); doneCb(o); },
    createUserInfoButton: function () { return makeSafeClass('UserInfoButton'); },
    createFeedbackButton: function () { return makeSafeClass('FeedbackButton'); },
    createGameClubButton: function () { return makeSafeClass('GameClubButton'); },
    createOpenSettingButton: function () { return makeSafeClass('OpenSettingButton'); },

    // ===== 用户 =====
    authorize: function (o) { okCb(o); doneCb(o); },
    login: function (o) {
      // ★ 离线 mock：返回稳定 code（真机由后端 code2Session 换 openid；
      //   GravityEngine clientId 依赖登录链路，fail 会导致 clientId must be required）
      okCb(o, { code: 'offline-mock-code-' + Date.now() });
      doneCb(o);
    },
    checkSession: function (o) { okCb(o); doneCb(o); },
    getUserInfo: function (o) { failCb(o, 'getUserInfo:fail mock'); doneCb(o); },
    getUserProfile: function (o) { failCb(o, 'getUserProfile:fail mock'); doneCb(o); },
    getUserInteractiveStorage: function (o) { okCb(o, { KVDataList: [] }); doneCb(o); },

    // ===== 开放数据域 =====
    getOpenDataContext: function () {
      return { postMessage: noop, canvas: null, onMessage: noop, offMessage: noop };
    },
    setUserCloudStorage: function (o) { okCb(o); doneCb(o); },
    removeUserCloudStorage: function (o) { okCb(o); doneCb(o); },
    getFriendCloudStorage: function (o) { okCb(o, { data: [] }); doneCb(o); },
    getGroupCloudStorage: function (o) { okCb(o, { data: [] }); doneCb(o); },
    getUserCloudStorage: function (o) { okCb(o, { KVDataList: [] }); doneCb(o); },
    getPotentialFriendList: function (o) { okCb(o, { list: [] }); doneCb(o); },
    getRealtimeLogManager: function () { return { info: noop, warn: noop, error: noop, setFilterMsg: noop, addFilterMsg: noop }; },

    // ===== 录像 / 相册 / 相机 =====
    getGameRecorder: function () { return makeSafeClass('GameRecorder'); },
    getRecorderManager: function () { return makeSafeClass('RecorderManager'); },
    operateGameRecorderVideo: function (o) { okCb(o); doneCb(o); },
    createCamera: function () { return makeSafeClass('Camera'); },
    createVideo: function () { return makeSafeClass('Video'); },
    createVideoDecoder: function () { return makeSafeClass('VideoDecoder'); },
    chooseImage: function (o) { failCb(o, 'chooseImage:fail mock'); doneCb(o); },
    saveImageToPhotosAlbum: function (o) { failCb(o, 'saveImageToPhotosAlbum:fail mock'); doneCb(o); },

    // ===== 传感器 =====
    startAccelerometer: function (o) { okCb(o); doneCb(o); },
    stopAccelerometer: function (o) { okCb(o); doneCb(o); },
    onAccelerometerChange: noop, offAccelerometerChange: noop,
    startCompass: function (o) { okCb(o); doneCb(o); },
    stopCompass: function (o) { okCb(o); doneCb(o); },
    onCompassChange: noop, offCompassChange: noop,
    startDeviceMotionListening: function (o) { okCb(o); doneCb(o); },
    stopDeviceMotionListening: function (o) { okCb(o); doneCb(o); },
    onDeviceMotionChange: noop, offDeviceMotionChange: noop,
    startGyroscope: function (o) { okCb(o); doneCb(o); },
    stopGyroscope: function (o) { okCb(o); doneCb(o); },
    onGyroscopeChange: noop, offGyroscopeChange: noop,

    // ===== 调色板 / 震动 =====
    setKeepScreenOn: function (o) { okCb(o); doneCb(o); },
    vibrateShort: function (o) { if (navigator.vibrate) navigator.vibrate(15); okCb(o); doneCb(o); },
    vibrateLong: function (o) { if (navigator.vibrate) navigator.vibrate(400); okCb(o); doneCb(o); },

    // ===== 云开发 =====
    cloud: {
      init: function () { return this; },
      callFunction: function (o) { if (o && o.fail) setTimeout(function () { o.fail({ errMsg: 'cloud.callFunction:fail mock' }); }, 0); return Promise.reject(new Error('cloud disabled')); },
      database: function () { return makeSafeClass('cloud.database'); },
      uploadFile: function () { return Promise.reject(new Error('cloud disabled')); },
      downloadFile: function () { return Promise.reject(new Error('cloud disabled')); },
      getTempFileURL: function () { return Promise.reject(new Error('cloud disabled')); },
      deleteFile: function () { return Promise.reject(new Error('cloud disabled')); }
    },

    // ===== 蓝牙 / NFC / 定位 / 信标 =====
    openBluetoothAdapter: function (o) { failCb(o, 'openBluetoothAdapter:fail mock'); doneCb(o); },
    closeBluetoothAdapter: function (o) { okCb(o); doneCb(o); },
    getBluetoothAdapterState: function (o) { okCb(o, { discovering: false, available: false }); doneCb(o); },
    startBluetoothDevicesDiscovery: function (o) { failCb(o, 'fail mock'); doneCb(o); },
    stopBluetoothDevicesDiscovery: function (o) { okCb(o); doneCb(o); },
    getBluetoothDevices: function (o) { okCb(o, { devices: [] }); doneCb(o); },
    getConnectedBluetoothDevices: function (o) { okCb(o, { devices: [] }); doneCb(o); },
    createBLEConnection: function (o) { failCb(o, 'fail mock'); doneCb(o); },
    closeBLEConnection: function (o) { okCb(o); doneCb(o); },
    getBLEDeviceServices: function (o) { okCb(o, { services: [] }); doneCb(o); },
    getBLEDeviceCharacteristics: function (o) { okCb(o, { characteristics: [] }); doneCb(o); },
    readBLECharacteristicValue: function (o) { failCb(o, 'fail mock'); doneCb(o); },
    writeBLECharacteristicValue: function (o) { failCb(o, 'fail mock'); doneCb(o); },
    notifyBLECharacteristicValueChange: function (o) { failCb(o, 'fail mock'); doneCb(o); },
    onBLECharacteristicValueChange: noop, offBLECharacteristicValueChange: noop,
    onBLEConnectionStateChange: noop, offBLEConnectionStateChange: noop,
    onBluetoothDeviceFound: noop, offBluetoothDeviceFound: noop,
    onBluetoothAdapterStateChange: noop, offBluetoothAdapterStateChange: noop,

    // ===== 文件 / 内存信息 =====
    getFileSystemManagerSync: function () { return FileSystemManager; },
    getBatteryInfoSync: function () { return { level: 100, isCharging: true }; },
    getBatteryInfo: function (o) { okCb(o, { level: 100, isCharging: true }); doneCb(o); },

    // ===== 聊天 / 好友互动 =====
    openChatTool: noop, joinVoIPChat: function (o) { failCb(o, 'fail mock'); }, exitVoIPChat: function (o) { okCb(o); },

    // ===== 信号量（代码分包用）=====
    // 微信基础库 wx.createSignal 用于「阻塞等待分包」。本地分包已就绪，
    // 返回空实现让插件走不阻塞分支。
    createSignal: function () {
      return { wait: function () {}, notify: function () {} };
    },

    // ===== 游戏审核 / 性能合规检测（getGameAudits）=====
    // 微信 Unity 适配插件启动时会调用 wx.getGameAudits().register(...) 注册
    // 一组 Unity 性能巡检任务（启动耗时、wasm 分包、预下载列表、帧耗时…）。
    // 这个能力只在微信客户端里存在，本地离线版没有任何审核语义，
    // 但仍然必须提供一个【结构完整】的对象：
    //   - BaseTask 必须是可以被 class 继承的真类（插件会 extends 它）
    //   - messenger / EventType 会被拷到子类实例上，不能缺
    //   - register / unregister / CustomCheckType 要被插件直接 new / 调用
    // 只要给全，插件就会安静地走完初始化，不会上报也不会弹任何 UI。
    getGameAudits: function () {
      function BaseTask() {
        this.messenger = AUDIT_SHIM.messenger;
        this.EventType = AUDIT_SHIM.EventType;
        this.taskType = '';
        this.ruleId = '';
        this.disable = true;   // 全部标记为 disabled → 插件不会真正执行检测
        this.threshold = 0;
        this.metaInfo = { name: '', description: '', document: [], weight: 0 };
        this.headers = [];
      }
      BaseTask.prototype.addFailedItem = noop;
      BaseTask.prototype.check = function () { return true; };
      BaseTask.prototype.generateItem = emptyObj;
      BaseTask.prototype.init = noop;
      BaseTask.prototype.off = noop;
      BaseTask.prototype.handler = noop;

      function CustomCheckType(opts) {
        var o = opts || {};
        this.type = o.type;
        this.name = o.name || '';
        this.description = o.description || '';
        this.tasks = o.tasks || [];
      }
      CustomCheckType.prototype.getResult = function () { return { type: this.type, tasks: [] }; };
      CustomCheckType.prototype.check = function () { return true; };
      CustomCheckType.prototype.destroy = noop;

      return AUDIT_SHIM.base(BaseTask, CustomCheckType);
    },
    onGameAuditStateChange: function (cb) {
      if (typeof cb === 'function') AUDIT_SHIM.stateCbs.push(cb);
    },
    offGameAuditStateChange: function (cb) {
      if (typeof cb !== 'function') { AUDIT_SHIM.stateCbs.length = 0; return; }
      var i = AUDIT_SHIM.stateCbs.indexOf(cb);
      if (i >= 0) AUDIT_SHIM.stateCbs.splice(i, 1);
    },

    // ===== 未列出的 API 统一兜底 =====
    __mock: makeSafeClass
  };

  // ---------------------------------------------------------------------
  // 10.5 wx 回调看门狗
  // ---------------------------------------------------------------------
  /**
   * 微信 API 是「传 success/fail/complete 的回调对象」风格。只要某次调用里
   * 这三个回调一个都没触发，C# 侧 await 的 Task 就永远不完成 ——
   * 表现就是「画面还在动（主循环正常）但点什么都没反应」，纯黑盒极难定位。
   * （用户反馈的「点【升级】卡住、画面还在动」正是这一类症状。）
   *
   * 这里给所有回调式 API 加一次性看门狗：
   *   - 超时后往错误环里记一条 [wx-hang]，附 API 名，下次一按 F9 就能看到
   *     究竟卡在哪个 API 上；
   *   - 同时补一个 fail 回调，让游戏的 await 能继续往下走，不至于永久卡死。
   * 已知本来就慢的接口（下载/网络/分包）不参与。
   */
  var WATCHDOG_MS = 20000;
  var WATCHDOG_SKIP = /^(on|off)[A-Z]|^(request|downloadFile|uploadFile|loadSubpackage|connectSocket|createWorker)$/;
  (function installApiWatchdog() {
    Object.keys(wx).forEach(function (name) {
      var fn = wx[name];
      if (typeof fn !== 'function') return;
      if (WATCHDOG_SKIP.test(name)) return;
      wx[name] = function (opts) {
        var args = arguments;
        var self = this;
        var hasCb = opts && typeof opts === 'object' &&
          (typeof opts.success === 'function' || typeof opts.fail === 'function' || typeof opts.complete === 'function');
        if (!hasCb) return fn.apply(self, args);

        var settled = false;
        var patched = {};
        ['success', 'fail', 'complete'].forEach(function (k) {
          if (typeof opts[k] !== 'function') return;
          patched[k] = function () {
            settled = true;
            return opts[k].apply(opts, arguments);
          };
        });

        var rest = [];
        for (var i = 1; i < args.length; i++) rest.push(args[i]);
        var ret;
        try {
          ret = fn.apply(self, [patched].concat(rest));
        } catch (e) {
          throw e;
        }

        setTimeout(function () {
          if (settled) return;
          settled = true;
          ringPush('[wx-hang] ' + name + ' 的回调 ' + WATCHDOG_MS + 'ms 未触发 → 已补 fail（游戏本会永久等待）');
          try {
            if (patched.fail) patched.fail({ errMsg: name + ':fail shim watchdog timeout' });
            else if (patched.complete) patched.complete({ errMsg: name + ':ok', __watchdog: true });
          } catch (e) { /* ignore */ }
        }, WATCHDOG_MS);

        return ret;
      };
    });
  })();

  // 兜底：任何未显式实现的 wx.xxx 都返回安全桩，避免 undefined 崩溃
  var wxProxy = new Proxy(wx, {
    get: function (t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop !== 'string') return undefined;
      if (prop === 'then') return undefined;
      // 常见命名规律：onXxx/offXxx 事件、createXxx 工厂、getXxx 查询
      if (/^on[A-Z]/.test(prop)) { var l = []; return makeEventListenerRegistrar(l); }
      if (/^off[A-Z]/.test(prop)) return noop;
      if (/^create[A-Z]/.test(prop)) return function () { return makeSafeClass(prop); };
      if (/Sync$/.test(prop)) return function () { return undefined; };
      return function (o) {
        log('mock api:', prop);
        if (o && typeof o === 'object') { setTimeout(function () { okCb(o); doneCb(o); }, 0); }
        return makeSafeClass(prop);
      };
    }
  });

  // ---------------------------------------------------------------------
  // 11. 挂到全局
  // ---------------------------------------------------------------------
  window.wx = wxProxy;
  try { GameGlobal.wx = wxProxy; } catch (e) {}
  // 微信小游戏里 wx 是全局变量，不是 window 属性；这里两者都指向同一实现
  if (typeof globalThis !== 'undefined') globalThis.wx = wxProxy;

  // GameGlobal 基础属性（真实小游戏由宿主注入）
  if (!G.navigator) {
    G.navigator = {
      platform: 'iPhone',
      language: 'zh-cn',
      languages: ['zh-cn'],
      appVersion: '5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15',
      userAgent: navigator.userAgent,
      onLine: true,
      geolocation: { getCurrentPosition: noop, watchPosition: noop, clearWatch: noop }
    };
  }
  if (!G.performance) G.performance = { now: function () { return performance.now(); } };
  if (!G.requestAnimationFrame) G.requestAnimationFrame = NATIVE.raf;
  if (!G.cancelAnimationFrame) G.cancelAnimationFrame = NATIVE.caf;

  // iOS 高性能模式 / Metal / GLX 一律关掉：那是微信原生渲染增强路径，
  // 浏览器里统一走标准 WebGL。
  G.isIOSHighPerformanceMode = false;
  G.isIOSHighPerformanceModePlus = false;
  G.canUseH5Renderer = false;
  G.canUseiOSAutoGC = false;
  G.mtl = false;
  G.useCanvasRenderer = false;
  G.USED_TEXTURE_COMPRESSION = false;
  G.TextureCompressedFormat = '';

  // 首个 canvas（weapp-adapter 会立即调用 wx.createCanvas()）
  G.canvas = createMainCanvas();
  bindTouchEvents();
  // game.js 的引导代码无条件引用**裸全局** canvas：
  //   Object.defineProperty(canvas, "clientWidth", ...)
  // 在微信里 canvas 是宿主注入的真全局；浏览器里必须显式挂到 window 上，
  // 否则偶发 "canvas is not defined" 直接打断 game.js 模块执行。
  try {
    if (!window.canvas) window.canvas = G.canvas;
    if (typeof globalThis !== 'undefined' && !globalThis.canvas) globalThis.canvas = G.canvas;
  } catch (e) { /* ignore */ }

  // ---------------------------------------------------------------------
  // 12. 建立「伪 window」全局环境
  // ---------------------------------------------------------------------
  /*
   * Unity 的 Emscripten 运行时把全局量（canvas / document / navigator /
   * XMLHttpRequest / Image / Audio / location / performance / localStorage）
   * 当成自由变量直接引用，即隐式读取 globalThis.xxx。
   *
   * 在微信小游戏里这些都是宿主注入到 GameGlobal 上的；
   * 在浏览器里我们先造一个伪 window 对象，再把这些键同时写到
   * GameGlobal 与 globalThis（window）上。
   */
  var fakeDocument = null;
  var fakeWindow = null;

  function buildFakeEnv() {
    var canvas = G.canvas;

    // ---- 伪 HTMLElement ----
    function FakeElement(tag) {
      this.tagName = String(tag || 'div').toUpperCase();
      this.nodeName = this.tagName;
      this.style = {};
      this.children = [];
      this.childNodes = [];
      this.parentNode = null;
      this.dataset = {};
      this.id = '';
      this.className = '';
      this.innerHTML = '';
      this.textContent = '';
      this.width = 0;
      this.height = 0;
    }
    FakeElement.prototype.appendChild = function (c) { this.children.push(c); this.childNodes.push(c); if (c) c.parentNode = this; return c; };
    FakeElement.prototype.removeChild = function (c) {
      var i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); this.childNodes.splice(i, 1); }
      return c;
    };
    FakeElement.prototype.insertBefore = function (c) { return this.appendChild(c); };
    FakeElement.prototype.setAttribute = function (k, v) { this[k] = v; };
    FakeElement.prototype.getAttribute = function (k) { return this[k]; };
    FakeElement.prototype.removeAttribute = function (k) { delete this[k]; };
    FakeElement.prototype.hasAttribute = function (k) { return k in this; };
    FakeElement.prototype.addEventListener = noop;
    FakeElement.prototype.removeEventListener = noop;
    FakeElement.prototype.dispatchEvent = noop;
    FakeElement.prototype.getBoundingClientRect = function () {
      return { left: 0, top: 0, right: CSS_W(), bottom: CSS_H(), width: CSS_W(), height: CSS_H(), x: 0, y: 0 };
    };
    FakeElement.prototype.focus = noop;
    FakeElement.prototype.blur = noop;
    FakeElement.prototype.click = noop;
    FakeElement.prototype.contains = function () { return false; };

    // ---- 事件系统 ----
    var listeners = Object.create(null);
    function dispatch(type, ev) {
      var l = listeners[type];
      if (!l) return;
      for (var i = 0; i < l.length; i++) { try { l[i](ev); } catch (e) { console.error(e); } }
    }
    G.__fakeDispatch = dispatch;

    var head = new FakeElement('head');
    var body = new FakeElement('body');
    head.appendChild(body);

    // ---- 伪 document ----
    var doc = {
      readyState: 'complete',
      visibilityState: 'visible',
      hidden: false,
      style: {},
      location: { href: location.href, protocol: location.protocol, host: location.host, origin: location.origin },
      documentElement: new FakeElement('html'),
      head: head,
      body: body,
      // Unity 的 locateFile 会读 document.currentScript.src 推断基准路径
      currentScript: { src: location.href.replace(/[^/]*$/, '') },
      title: document.title,
      cookie: '',
      createElement: function (tag) {
        tag = String(tag).toLowerCase();
        if (tag === 'canvas') {
          var c = document.createElement('canvas');
          c.width = 1; c.height = 1;
          c.toTempFilePath = function (o) {
            try {
              var u = c.toDataURL();
              if (o && o.success) o.success({ tempFilePath: u, errMsg: 'toTempFilePath:ok' });
            } catch (e) { if (o && o.fail) o.fail({ errMsg: 'fail' }); }
          };
          c.toTempFilePathSync = function () { return c.toDataURL(); };
          c.getBoundingClientRect = function () {
            return { left: 0, top: 0, right: c.width, bottom: c.height, width: c.width, height: c.height, x: 0, y: 0 };
          };
          return c;
        }
        if (tag === 'img' || tag === 'image') {
          var im = new Image();
          im.crossOrigin = 'anonymous';
          return im;
        }
        if (tag === 'audio') return new Audio();
        return new FakeElement(tag);
      },
      createElementNS: function (ns, tag) { return doc.createElement(tag); },
      createTextNode: function (t) { var e = new FakeElement('#text'); e.textContent = t; return e; },
      getElementById: function (id) {
        if (canvas && canvas.id === id) return canvas;
        return null;
      },
      getElementsByTagName: function (t) {
        t = String(t).toLowerCase();
        if (t === 'head') return [head];
        if (t === 'body') return [body];
        if (t === 'canvas') return [canvas];
        return [];
      },
      getElementsByClassName: function () { return []; },
      getElementsByName: function () { return []; },
      querySelector: function (sel) {
        if (sel === 'canvas' || sel === '#' + (canvas && canvas.id)) return canvas;
        if (sel === 'head') return head;
        if (sel === 'body') return body;
        if (sel && sel.charAt(0) === '#') return document.getElementById(sel.slice(1));
        return null;
      },
      querySelectorAll: function (sel) { var r = doc.querySelector(sel); return r ? [r] : []; },
      addEventListener: function (t, f) { (listeners[t] = listeners[t] || []).push(f); },
      removeEventListener: function (t, f) {
        var l = listeners[t]; if (!l) return;
        var i = l.indexOf(f); if (i >= 0) l.splice(i, 1);
      },
      dispatchEvent: function (ev) { dispatch(ev && ev.type, ev); return true; },
      hasFocus: function () { return true; },
      exitPointerLock: noop,
      exitFullscreen: function () { return document.exitFullscreen ? document.exitFullscreen() : undefined; },
      fullscreenEnabled: true,
      fullscreenElement: null,
      createRange: function () { return { selectNodeContents: noop, setStart: noop, setEnd: noop }; },
      execCommand: function () { return false; },
      getSelection: function () { return { removeAllRanges: noop, addRange: noop }; }
    };

    // ---- 伪 navigator ----
    var nav = {
      platform: 'iPhone',
      language: 'zh-CN',
      languages: ['zh-CN', 'zh'],
      appVersion: '5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) MiniGame/1.0',
      onLine: true,
      hardwareConcurrency: (navigator.hardwareConcurrency || 4),
      deviceMemory: 4,
      maxTouchPoints: 5,
      vendor: 'WeChat',
      product: 'MiniGame',
      geolocation: {
        getCurrentPosition: function (ok) { if (ok) ok({ coords: { latitude: 0, longitude: 0, accuracy: 0 } }); },
        watchPosition: function () { return 0; },
        clearWatch: noop
      },
      mediaDevices: undefined,          // 关掉摄像头枚举，避免 Unity 弹权限
      permissions: { query: function () { return Promise.resolve({ state: 'denied' }); } },
      vibrate: function () { return true; },
      getGamepads: function () { return []; }
    };

    fakeDocument = doc;

    // ---- 伪 window ----
    var win = {
      document: doc,
      navigator: nav,
      canvas: canvas,
      location: {
        href: location.href, protocol: location.protocol, host: location.host,
        hostname: location.hostname, port: location.port, pathname: location.pathname,
        search: location.search, hash: location.hash, origin: location.origin,
        reload: function () { location.reload(); },
        replace: function (u) { location.replace(u); },
        assign: function (u) { location.assign(u); },
        toString: function () { return location.href; }
      },
      // ⚠️ 这里必须是 getter，不能是固定数字：
      //   lib/game.js 用 window.innerWidth 计算 canvas.clientWidth /
      //   getBoundingClientRect()，而 wasm 侧的 JS_SystemInfo_GetCanvasClientSize
      //   正是通过 getBoundingClientRect() 拿到画布尺寸的。
      //   写成固定值的话，用户改变浏览器窗口大小后引擎仍按启动时那一次尺寸
      //   布局和渲染（画面缩在左上角 / 不跟随窗口）。
      get innerWidth() { return CSS_W(); },
      get innerHeight() { return CSS_H(); },
      get outerWidth() { return CSS_W(); },
      get outerHeight() { return CSS_H(); },
      get devicePixelRatio() { return DPR(); },
      screen: (function () {
        var s = { orientation: { type: 'portrait-primary', angle: 0 } };
        try {
          Object.defineProperty(s, 'width', { get: CSS_W, enumerable: true, configurable: true });
          Object.defineProperty(s, 'height', { get: CSS_H, enumerable: true, configurable: true });
          Object.defineProperty(s, 'availWidth', { get: CSS_W, enumerable: true, configurable: true });
          Object.defineProperty(s, 'availHeight', { get: CSS_H, enumerable: true, configurable: true });
        } catch (e) { s.width = CSS_W(); s.height = CSS_H(); s.availWidth = CSS_W(); s.availHeight = CSS_H(); }
        return s;
      })(),
      performance: { now: function () { return performance.now(); } },
      requestAnimationFrame: function (cb) { return NATIVE.raf(cb); },
      cancelAnimationFrame: function (id) { return NATIVE.caf(id); },
      setTimeout: NATIVE.setTimeout,
      setInterval: NATIVE.setInterval,
      clearTimeout: NATIVE.clearTimeout,
      clearInterval: NATIVE.clearInterval,
      addEventListener: function (t, f) { (listeners[t] = listeners[t] || []).push(f); },
      removeEventListener: function (t, f) {
        var l = listeners[t]; if (!l) return; var i = l.indexOf(f); if (i >= 0) l.splice(i, 1);
      },
      dispatchEvent: function (ev) { dispatch(ev && ev.type, ev); return true; },
      localStorage: {
        getItem: function (k) { return localStorage.getItem(k); },
        setItem: function (k, v) { localStorage.setItem(k, v); },
        removeItem: function (k) { localStorage.removeItem(k); },
        clear: function () { localStorage.clear(); },
        key: function (i) { return localStorage.key(i); },
        get length() { return localStorage.length; }
      },
      XMLHttpRequest: XMLHttpRequest,
      WebSocket: WebSocket,
      Image: Image,
      Audio: Audio,
      HTMLElement: FakeElement,
      HTMLCanvasElement: HTMLCanvasElement,
      HTMLImageElement: HTMLImageElement,
      HTMLVideoElement: HTMLVideoElement,
      CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
      Event: function (type) { this.type = type; },
      Blob: Blob,
      URL: URL,
      fetch: window.fetch ? window.fetch.bind(window) : undefined,
      Worker: window.Worker,
      OffscreenCanvas: window.OffscreenCanvas,
      WebAssembly: WebAssembly,
      Math: Math,
      Date: Date,
      Promise: Promise,
      console: console,
      alert: function (m) { logAlways('alert:', m); },
      confirm: function () { return true; },
      prompt: function () { return ''; },
      getComputedStyle: function () { return { getPropertyValue: function () { return ''; } }; },
      matchMedia: function () { return { matches: false, addListener: noop, removeListener: noop, addEventListener: noop }; },
      open: function (u) { window.open(u, '_blank'); return null; },
      close: noop,
      focus: noop,
      scrollTo: noop,
      parent: null,
      top: null,
      self: null,
      frameElement: null,
      crypto: window.crypto,
      btoa: window.btoa.bind(window),
      atob: window.atob.bind(window)
    };
    win.self = win;
    win.window = win;
    win.parent = win;
    win.top = win;
    win.globalThis = win;

    fakeWindow = win;

    // ---- 关键：把伪环境同时铺到 GameGlobal 与 globalThis ----
    // Unity 的自由变量查找走 globalThis；微信 API 走 GameGlobal。两边都要有。
    var expose = [
      'document', 'navigator', 'canvas', 'location',
      'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'devicePixelRatio',
      'screen', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame',
      'XMLHttpRequest', 'WebSocket', 'Image', 'Audio', 'HTMLElement'
    ];

    expose.forEach(function (k) {
      var v = win[k];
      // GameGlobal 上的直接赋值
      try { G[k] = v; } catch (e) {}
      // globalThis 上的赋值：只覆盖 configurable 的，或不存在的
      try {
        var d = Object.getOwnPropertyDescriptor(window, k);
        if (!d) {
          Object.defineProperty(window, k, { value: v, writable: true, configurable: true, enumerable: false });
        } else if (d.configurable && d.writable !== false && !d.set) {
          Object.defineProperty(window, k, { value: v, writable: true, configurable: true, enumerable: d.enumerable });
        } else {
          // 浏览器原生不可覆盖（如 innerWidth / document / location）——
          // 用局部变量遮蔽它们对 Unity 没有意义，只能接受并使用原生值。
          log('保留原生全局:', k);
        }
      } catch (e) { /* 不可覆盖，忽略 */ }
    });

    // 单独处理：window 上必须能读到伪 document 的地方我们已经在 G 上做了
    // 再补几个 Unity 常读的别名
    G.window = win;
    G.document = doc;
    G.top = win;
    G.parent = win;
    G.self = win;

    // GameGlobal 上的视口尺寸也要是活值：部分适配层直接读 GameGlobal.innerWidth
    // ⚠️ 必须带 setter：lib/game.js 里有一句 `for (var a in r) i[a] = r[a]`
    //    （把伪 window 的所有可枚举属性拷到 GameGlobal），如果这里只给 getter，
    //    这句赋值会抛 "Cannot set property innerWidth of #<Object> which has only a getter"，
    //    整个 game.js 模块执行失败 → 彻底起不来。setter 收下值但忽略即可。
    var G_VIEW_GET = {
      innerWidth: CSS_W, outerWidth: CSS_W,
      innerHeight: CSS_H, outerHeight: CSS_H,
      devicePixelRatio: DPR
    };
    Object.keys(G_VIEW_GET).forEach(function (k) {
      try {
        Object.defineProperty(G, k, {
          configurable: true, enumerable: true,
          get: G_VIEW_GET[k],
          set: function () { /* 忽略适配层的静态拷贝，保留活值 */ }
        });
      } catch (e) { /* 保持静态值 */ }
    });

    logAlways('伪环境就绪 · document/canvas/navigator 已挂到 GameGlobal');
    return win;
  }

  buildFakeEnv();

  // 调试出口
  window.__wxShim = {
    assetRoot: ASSET_ROOT,
    viewport: function () { return computeGameViewport(); },
    stats: adStats,
    fileCache: fileCache,
    readFileSync: readFileSyncSafe,
    showAdOverlay: showAdOverlay,
    hideAdOverlay: hideAdOverlay,
    // 供 wx-loader 在启动游戏前预置资源、并在出问题时查看虚拟文件系统
    preloadIntoFS: preloadIntoFS,
    dumpFS: function () {
      var o = {};
      Object.keys(memFS).forEach(function (k) { o[k] = memFS[k].size || 0; });
      return o;
    },
    // 供「重置游戏进度」使用：只清存档类文件，绝不碰资源缓存
    // （资源缓存都是大文件，落在 StreamingAssets / downloaded / wasmcode 下，
    //   或被 FS_PERSIST_SKIP_EXT 排除，这里按路径白名单反向排除）
    clearSaveFiles: function () {
      var RES_RE = /StreamingAssets|^usr\/downloaded|^usr\/wasmcode|\.(bundle|wasm|br|dat|bin|unityweb|png|jpg|jpeg|ogg|mp3|wav)$/i;
      var removed = 0;
      Object.keys(memFS).forEach(function (k) {
        if (!RES_RE.test(k)) { delete memFS[k]; removed++; }
      });
      try {
        var lsKeys = [];
        for (var i = 0; i < localStorage.length; i++) lsKeys.push(localStorage.key(i));
        lsKeys.forEach(function (k) {
          if (k && k.indexOf(FS_PERSIST_PREFIX) === 0) localStorage.removeItem(k);
        });
      } catch (e) { /* ignore */ }
      return removed;
    },
    verbose: function (v) { if (v) localStorage.setItem('wxshim.verbose', '1'); else localStorage.removeItem('wxshim.verbose'); location.reload(); }
  };

  logAlways('wx-shim ready · assets =', ASSET_ROOT, '· dpr =', DPR(), '· fit =', FIT_MODE);
})();
