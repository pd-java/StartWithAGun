/*
 * wx-loader.js —— 微信小游戏模块运行时（在浏览器里复刻）
 * ---------------------------------------------------------------
 * game.js 是微信开发者工具打出来的单文件 bundle，结构是：
 *
 *     define("<模块名>", function(require, module, exports){ ... });
 *     define(...);
 *     ...
 *     require("game.js");
 *
 * 真正的入口只有最后一行 require("game.js")，前面全是注册。
 * 所以我们只需要实现 define / require / requirePlugin，然后 require 入口即可。
 *
 * 与微信宿主的三处差异需要补齐：
 *   1. requirePlugin("UnityPlugin") —— 微信从独立插件包加载。这里把
 *      plugin-333/plugin.js（微信官方 Unity 适配插件）也当作模块注册进同一张表，
 *      并把模块名前缀 "__plugin__/wxe5a48f1ed5f544b7" 转成 "UnityPlugin"。
 *   2. UnityPlugin 内部依赖 GameGlobal.manager.wasmsplit.* —— 这些方法由另一个
 *      官方插件 code-split 提供。本地 wasm 是完整的（不需要按需下载函数分片），
 *      所以我们用「直通」实现覆盖掉，绕过代码分包机制。
 *   3. 微信的 WXWebAssembly 只是标准 WebAssembly 的包装 —— 直接映射过去即可。
 */
(function () {
  'use strict';

  var V = (location.search.indexOf('verbose') >= 0) || localStorage.getItem('wxshim.verbose') === '1';
  function log() {
    if (!V) return;
    console.log.apply(console, ['%c[wx-loader]', 'color:#1677ff;font-weight:bold'].concat(Array.prototype.slice.call(arguments)));
  }

  var G = window.GameGlobal || (window.GameGlobal = {});

  // ---------------------------------------------------------------------
  // 1. WXWebAssembly / WXWebAssembly2：微信对标准 WebAssembly 的封装
  // ---------------------------------------------------------------------
  function makeWasmNamespace() {
    return {
      Memory: WebAssembly.Memory,
      Table: WebAssembly.Table,
      Global: WebAssembly.Global,
      Module: WebAssembly.Module,
      Instance: WebAssembly.Instance,
      CompileError: WebAssembly.CompileError,
      LinkError: WebAssembly.LinkError,
      RuntimeError: WebAssembly.RuntimeError,
      instantiate: function () { return WebAssembly.instantiate.apply(WebAssembly, arguments); },
      compile: function () { return WebAssembly.compile.apply(WebAssembly, arguments); },
      validate: function () { return WebAssembly.validate.apply(WebAssembly, arguments); }
    };
  }
  if (!window.WXWebAssembly) window.WXWebAssembly = makeWasmNamespace();
  if (!window.WXWebAssembly2) window.WXWebAssembly2 = makeWasmNamespace();
  if (!G.WXWebAssembly) G.WXWebAssembly = window.WXWebAssembly;

  // ---------------------------------------------------------------------
  // 2. 模块系统
  // ---------------------------------------------------------------------
  var defs = Object.create(null);   // name -> factory
  var cache = Object.create(null);  // name -> module.exports

  var PLUGIN_PROVIDER = 'wxe5a48f1ed5f544b7';
  var PLUGIN_PREFIX = '__plugin__/' + PLUGIN_PROVIDER;
  var PLUGIN_ALIAS = 'UnityPlugin';

  /**
   * 名字规范化。
   * 注意：游戏 bundle 里的模块名形如 "@swc/runtime/_class_call_check.js"、
   * "unity-sdk/index.js"，都带 .js 后缀；但 require 时经常写成
   * `require("./mobileKeyboard/index")`（不带后缀）。
   * 所以查找时要两个方向都试：
   *   - 传入带 .js → 再试去后缀的
   *   - 传入不带  → 再试补 .js 的
   * 另外 unity-sdk 里有 `require("./video/index")` 这种目录导入，
   * 真实微信打包器也会产出 "unity-sdk/video/index.js"，补后缀同样能命中。
   */
  function aliasKeys(name) {
    var keys = [name];
    if (/\.js$/.test(name)) keys.push(name.slice(0, -3));
    else keys.push(name + '.js');
    return keys;
  }

  function normName(name) {
    if (typeof name !== 'string') return name;
    name = name.replace(/^\.\//, '');
    if (name === PLUGIN_PREFIX) return PLUGIN_ALIAS + '/index';
    if (name.indexOf(PLUGIN_PREFIX + '/') === 0) return PLUGIN_ALIAS + '/' + name.slice(PLUGIN_PREFIX.length + 1);
    return name;
  }

  function resolve(from, req) {
    if (req.charAt(0) !== '.') return normName(req);
    var base = from.split('/');
    base.pop();
    var parts = req.split('/');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === '.' || p === '') continue;
      if (p === '..') base.pop(); else base.push(p);
    }
    return normName(base.join('/'));
  }

  function lookup(key) {
    var keys = aliasKeys(key);
    for (var i = 0; i < keys.length; i++) if (defs[keys[i]]) return defs[keys[i]];
    return null;
  }

  /**
   * 插件包内部的绝对导入。
   * 微信插件用 webpack 打包，源码里 `require("@babel/runtime/helpers/typeof")`
   * 这种不是相对路径，但它其实指向插件自己的命名空间
   * （真实键名是 "__plugin__/<appid>/@babel/runtime/helpers/typeof.js"）。
   * 这里在 from 属于插件时自动补前缀再查一次。
   */
  function lookupIn(prefix, key) {
    // prefix 为空：直接查（可能命中插件命名空间的完整键）
    var f = lookup(prefix ? prefix + key : key);
    if (f) return f;
    // 插件内绝对导入（如 "@babel/runtime/helpers/typeof"）也要试一次带前缀
    if (prefix) {
      if (key.indexOf(PLUGIN_ALIAS + '/') === 0) return null;
      return lookup(prefix + key);
    }
    return null;
  }

  /** 生成一个 require 函数，绑定到 from 模块的解析上下文 */
  function makeRequire(from) {
    // from 可能是插件命名空间下的键（"UnityPlugin/@babel/runtime/helpers/typeof"）。
    // 解析相对路径时要去掉这层前缀，否则 "./setPrototypeOf" 会解析成
    // "UnityPlugin/@babel/runtime/helpers/setPrototypeOf" 而查不到
    // （真实键是 "UnityPlugin/@babel/runtime/helpers/setPrototypeOf.js"，
    //   aliasKeys 能补 .js，但 base 路径必须一致）。
    var fromBase = from || '';
    var inPlugin = fromBase.indexOf(PLUGIN_ALIAS + '/') === 0;
    var fromKey = inPlugin ? fromBase.slice(PLUGIN_ALIAS.length + 1) : fromBase;

    function require(req) {
      var key = resolve(fromKey, req);
      // 缓存键统一用「不带插件前缀」的相对键，查找时再补前缀
      var cacheKey = inPlugin ? PLUGIN_ALIAS + '/' + key : key;
      if (cache[cacheKey]) return cache[cacheKey].exports;
      var f = lookupIn(inPlugin ? PLUGIN_ALIAS + '/' : '', key);
      if (!f) {
        // 未定义模块：返回一个「什么都能调」的兜底对象，避免整条链崩掉。
        // 这种模块通常是平台独占能力（云开发 / 蓝牙 / 开放数据域），本移植用不到。
        console.warn('[wx-loader] 未找到模块 "' + req + '"（解析为 "' + key + '"，from "' + from + '"），返回空实现');
        var empty = makeEmptyModule(req);
        cache[cacheKey] = { exports: empty, loaded: true };
        return empty;
      }
      // 子模块自己的名字（不带插件前缀）作为它的相对基准
      var childFrom = inPlugin ? PLUGIN_ALIAS + '/' + key : key;
      var module = { exports: {}, loaded: false, id: cacheKey };
      cache[cacheKey] = module;
      var childRequire = makeRequire(childFrom);
      try {
        f(childRequire, module, module.exports);
      } catch (e) {
        console.error('[wx-loader] 模块执行出错: ' + cacheKey, e);
        throw e;
      }
      module.loaded = true;
      return module.exports;
    }
    return require;
  }

  function makeEmptyModule(name) {
    var fn = function () { return makeEmptyModule(name); };
    return new Proxy({ __emptyModule: name }, {
      get: function (t, p) {
        if (p === 'then') return undefined;
        if (p === '__esModule') return true;
        if (p in t) return t[p];
        if (p === 'default') return makeEmptyModule(name + '.default');
        return function () { return makeEmptyModule(name + '.' + String(p)); };
      }
    });
  }

  // define(name, factory) / define(name, deps, factory) / define(name, f1, f2)
  //
  // ⚠️ 微信打包器对 workers.js 这类模块会生成：
  //     define("name", function(require, module, exports){...},
  //                          function(...){...})     ← 第三个参数是 worker 版本
  // 或者
  //     define("name", function(require, module, exports){...})
  // 所以「factory 永远是第二个参数」，后面的参数一律忽略（不能当成 factory）。
  window.define = function (name, deps, factory) {
    var f = (typeof deps === 'function') ? deps
          : (typeof factory === 'function') ? factory
          : function () {};
    var n = normName(name);
    aliasKeys(n).forEach(function (k) { defs[k] = f; });
  };
  window.define.amd = false;

  // 微信宿主提供的 requirePlugin。
  // 注意：game.js 末尾会自己定义一个 fallback requirePlugin（依赖 pluginInfoMap，
  // 而且是在最外层作用域里调用 require —— 在那里没有 require），所以我们必须在
  // game.js 执行前就把它替换掉，并且不允许它再覆盖回来。
  var nativeRequire = makeRequire('');
  var requirePluginImpl = function (name, opts) {
    var key = (name === PLUGIN_ALIAS) ? PLUGIN_ALIAS + '/index' : normName(name);
    if (opts && opts.customEnv) {
      window.__pluginCustomEnv = opts.customEnv;
      // 微信把插件的运行环境注入到 pluginEnv，插件内部大量读取它
      // （customEnv / gameTransfer / coverview / getPrivateFileSystemManager ...）。
      // 缺少 pluginEnv 会直接 TypeError，所以这里补齐。
      G.pluginEnv = buildPluginEnv(opts.customEnv);
    }
    var mod = nativeRequire(key);
    if (mod && mod.__emptyModule) {
      throw new Error('Plugin ' + name + ' is not defined.');
    }
    return mod;
  };

  /**
   * 构造微信插件运行环境。
   * 关键字段：
   *   customEnv      —— 宿主传给插件的自定义环境（wx / canvas / document / unityNamespace ...）
   *   gameTransfer   —— 游戏域名/接口转发（联网营销能力，本移植不需要）
   *   coverview      —— 原生覆盖视图（加载页 UI），我们用自己的 HTML 遮罩替代
   *   getPrivateFileSystemManager —— 插件私有文件系统
   */
  function buildPluginEnv(customEnv) {
    var env = customEnv || {};
    var pluginEnv = {
      customEnv: env,
      instanceId: 'local-' + Date.now().toString(36),
      // 联网类能力（游戏域名转发）。
      // 不能 reject —— 插件在构造阶段 await 它，reject 会中断整个初始化链。
      // 给一个「永不产生副作用」的假响应：success 回调收到空数据，
      // 插件走到正常分支后继续用本地资源。
      gameTransfer: function (opts) {
        var o = opts || {};
        return new Promise(function (resolve) {
          setTimeout(function () {
            var payload = { errcode: 0, errmsg: 'ok', json_data: '{}', resp_data: '{}', data: {} };
            if (typeof o.success === 'function') { try { o.success(payload); } catch (e) {} }
            if (typeof o.complete === 'function') { try { o.complete(payload); } catch (e) {} }
            resolve(payload);
          }, 0);
        });
      },
      reportKeyValue: function () {},
      setFileSpaceStatistics: function () {},
      getPrivateFileSystemManager: function () {
        return env.wx ? env.wx.getFileSystemManager() : null;
      },
      getWxCommonFont: function () { return {}; },
      coverview: null,          // 关掉原生覆盖层（我们用 HTML 遮罩）
      isMiniGamePlugin: true,
      navigateToMiniProgramDirectly: function () {}
    };

    // ⚠️ 插件内部用 `typeof pluginEnv !== "undefined"` 判断运行环境，
    // 也就是说它读的是【全局变量 pluginEnv】，不是 GameGlobal.pluginEnv。
    // 三家都要挂上，避免任何一处拿不到。
    try {
      Object.defineProperty(window, 'pluginEnv', {
        configurable: true, writable: true, value: pluginEnv
      });
    } catch (e) { window.pluginEnv = pluginEnv; }
    G.pluginEnv = pluginEnv;
    if (typeof globalThis !== 'undefined') globalThis.pluginEnv = pluginEnv;
    return pluginEnv;
  }
  Object.defineProperty(window, 'requirePlugin', {
    configurable: false,
    get: function () { return requirePluginImpl; },
    set: function () { /* game.js 想覆盖？忽略，保留我们的实现 */ }
  });
  // 同时挂到 GameGlobal（game.js 用的是 global.requirePlugin）
  try {
    Object.defineProperty(G, 'requirePlugin', {
      configurable: false,
      get: function () { return requirePluginImpl; },
      set: function () {}
    });
  } catch (e) { G.requirePlugin = requirePluginImpl; }

  // ---------------------------------------------------------------------
  // 3. 对 game.js 做两处「定点手术」
  // ---------------------------------------------------------------------
  /*
   * 手术 1：weapp-adapter 的全局注入分支
   * -------------------------------------
   * 原代码：
   *   if ("devtools" === platform) { ...Object.defineProperty(window, 'document'...) }
   *   else { for (var a in r) i[a] = r[a];   // i = GameGlobal
   *          i.window = r,                    // ← 把 GameGlobal.window 指向伪 window
   *          (window = i).top = window.parent = window }   // ← 给真 window 赋值 → 浏览器抛错
   *
   * 这两个分支在浏览器里都走不通：
   *   devtools 分支：window.document 是 [Unforgeable]，defineProperty 直接抛错；
   *   其它分支：window 是 [Replaceable] 只读属性，`window = i` 也抛错。
   *
   * 我们改成「只做数据搬运，不动 window」：
   *   把伪 document / navigator / XMLHttpRequest / Image / Audio / localStorage
   *   等挂到 GameGlobal 上（Unity 运行时通过 GameGlobal 取这些全局量，
   *   而 GameGlobal 在真实小游戏里就等于 globalThis）。
   *
   * 手术 2：game.js 自带的 requirePlugin 兜底实现
   * ---------------------------------------------
   * 原代码在 IIFE 之外、模块作用域里调用 `require(...)`，浏览器中 `require`
   * 未定义 → 必然抛 ReferenceError。虽然它前面有 `||` 保护，但游戏会显式
   * 调 requirePlugin("UnityPlugin")，一旦落到这条分支就是硬崩。
   * 直接把这段字符串替换成空操作，保留我们自己的实现。
   */
  var PATCHES = [
    {
      name: 'weapp-adapter/global-inject',
      find: /else\{for\(var a in r\)i\[a\]=r\[a\];i\.window=r,\(window=i\)\.top=window\.parent=window\}/,
      replace: 'else{for(var a in r)i[a]=r[a];i.window=r;i.top=i.parent=i}'
    },
    {
      // 整段删掉：global.requirePlugin = global.requirePlugin || function(path){...};
      // 源码里这段用了大量制表符/空格混排，所以用宽松匹配 + 括号配平来定位结尾。
      name: 'game.js/requirePlugin-fallback',
      find: /global\.requirePlugin\s*=\s*global\.requirePlugin\s*\|\|\s*function\s*\(path\)\s*\{/,
      replace: 'void 0;/* patched: requirePlugin fallback removed */',
      balance: true
    },
    {
      // 文件最末尾的引导语句 `require("game.js");` 在浏览器里没有 require，
      // 删掉它 —— 我们在 boot() 里会显式调用。
      name: 'game.js/bootstrap-require',
      find: /(^|[\s;])\s*require\(\s*["']game\.js["']\s*\)\s*;?\s*$/,
      replace: ';/* bootstrap require handled by wx-loader */'
    }
  ];

  function patchSource(src) {
    var applied = [];
    PATCHES.forEach(function (p) {
      var m = p.find.exec(src);
      if (!m) {
        console.warn('[wx-loader] 补丁未命中（源码可能已变化）:', p.name);
        return;
      }
      var start = m.index;
      var end = start + m[0].length;
      var replacement = p.replace;

      if (p.balance) {
        // 从已匹配到的 '{' 开始做括号配平，找到函数体真正的结尾。
        // 只需处理字符串里的括号，本段代码不含模板字符串。
        var depth = 0, i = end - 1, inStr = null, esc = false;
        for (; i < src.length; i++) {
          var ch = src.charAt(i);
          if (inStr) {
            if (esc) { esc = false; }
            else if (ch === '\\') { esc = true; }
            else if (ch === inStr) { inStr = null; }
            continue;
          }
          if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) { i++; break; }
          }
        }
        end = i;
        // 吞掉结尾分号
        while (end < src.length && /[\s;]/.test(src.charAt(end)) && src.charAt(end) !== '\n') end++;
        // 用 (0) 当作占位表达式，既完成语句又不会引用 require
        replacement = 'void 0;';
      }

      src = src.slice(0, start) + replacement + src.slice(end);
      applied.push(p.name);
    });
    if (applied.length) log('已应用补丁:', applied.join(', '));
    return src;
  }

  // ---------------------------------------------------------------------
  // 4. 加载脚本
  // ---------------------------------------------------------------------
  /** 同步读取二进制（绕过「同步 XHR 不能设 responseType」的限制） */
  function xhrBinarySync(url) {
    var x = new XMLHttpRequest();
    try { x.overrideMimeType('text/plain; charset=x-user-defined'); } catch (e) {}
    x.open('GET', url, false);
    x.send(null);
    if (!(x.status >= 200 && x.status < 300 || x.status === 0)) return null;
    var txt = x.responseText;
    if (!txt || !txt.length) return null;
    var out = new Uint8Array(txt.length);
    for (var i = 0; i < txt.length; i++) out[i] = txt.charCodeAt(i) & 0xff;
    return out;
  }

  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.async = false;
      s.onload = function () { log('loaded', url); resolve(); };
      s.onerror = function () { reject(new Error('加载失败: ' + url)); };
      document.head.appendChild(s);
    });
  }

  /** 拉取 game.js 源码 → 打补丁 → 以 inline script 注入执行 */
  function loadPatchedScript(url) {
    return fetch(url, { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
        return r.text();
      })
      .then(function (src) {
        var patched = patchSource(src);
        var s = document.createElement('script');
        s.textContent = patched;
        // sourceURL 让 DevTools 能看到原始文件名
        s.textContent += '\n//# sourceURL=' + url;
        document.head.appendChild(s);
        log('已注入（打过补丁）', url, patched.length, 'bytes');
      });
  }

  // ---------------------------------------------------------------------
  // 4. 代码分包直通实现（绕过 wasmsplit）
  // ---------------------------------------------------------------------
  function installWasmSplitBypass() {
    var mgr = G.manager = G.manager || {};

    // 被 plugin / wasm-split.js 调用的一堆运维方法，全部空实现
    var passthrough = {
      subWasmDownloaded: function () {}, subWasmDownloadError: function () {},
      subWasmCompiled: function () {}, beforeLoadSubWasm: function () {},
      reportInitFuncSplitWasm: function () {}, reportCalledFuncs: function () {},
      reportWaitTime: function () {}, reportWasmSplitPerformance: function () {},
      reportInvokeWasmFuncInfo: function () {}, startFetchJsCode: function () {},
      instantiatePatch: function () { return Promise.resolve(); },
      createWKVideo: function () { return null; },
      getGameDataMonitor: function () { return { start: function () {}, stop: function () {} }; },
      checkNeedReportMissPatchFunc: function () {}
    };
    Object.keys(passthrough).forEach(function (k) { if (!mgr[k]) mgr[k] = passthrough[k]; });

    if (!mgr.Logger) {
      mgr.Logger = {
        pluginLog: function () { if (V) console.log.apply(console, ['[plugin]'].concat(Array.prototype.slice.call(arguments))); },
        pluginError: function () { console.error.apply(console, ['[plugin:error]'].concat(Array.prototype.slice.call(arguments))); }
      };
    }
    if (!mgr.TimeLogger) {
      mgr.TimeLogger = {
        timeStart: function () {}, timeEnd: function () { return 0; },
        printTime: function () {}, storeTime: function () {}, getRuntime: function () { return 0; }
      };
    }
    if (!mgr.reporter) {
      mgr.reporter = { wxAssetBundle: { reportEmptyContent: function () {} } };
    }

    // 关键：WASM code-split 的桩。
    // 真实场景下函数体分布在 wasmcode2 里，需要按需拉取；而本机 wasm 是完整产物，
    // 所以让 features 只声明 0（表示没有需要外挂的函数表项）即可跳过整个机制。
    mgr.wasmsplit = mgr.wasmsplit || {};
    mgr.wasmsplit.getFeatures = function () {
      // delayInitTime 默认 30s，delayFuncInitTime 默认 0 —— 都是安全的
      return { delayInitTime: 0, reportStrategy: 0, reportInterval: 60000, delayFuncInitTime: 0 };
    };
    mgr.wasmsplit.innerInitFuncSplitWasm = function (o) {
      log('wasmsplit.innerInitFuncSplitWasm -> bypass');
      try { o && o.success && o.success(); } catch (e) {}
    };
    mgr.wasmsplit.innerInvokeWasmBuffer = function (o) {
      log('wasmsplit.innerInvokeWasmBuffer -> bypass');
      try { o && o.success && o.success(0); } catch (e) {}
    };
    mgr.wasmsplit.innerInvokeWasmFunc = function (o) {
      o && o.invokeWasmFunc && o.invokeWasmFunc({});
    };
    mgr.wasmsplit.innerInvokeWasmExtractor = function () {};
    mgr.wasmsplit.instantiatePatch = function () { return Promise.resolve(); };
    mgr.wasmsplit.checkNeedReportMissPatchFunc = function () {};

    G.wasm_split_info = G.wasm_split_info || {
      primary: { memory: null, table: null },
      env: {},
      asm2wasm: { 'f64-to-int': function (x) { return x | 0; }, 'f64-rem': function (a, b) { return a % b; } },
      wasm_split: { wait: function () {}, logCall: function () {} }
    };

    /**
     * 关键：wasm-split.js 会在 game.js 执行时设置
     *   GameGlobal.unityNamespace.instantiateWasm = function(a, e){
     *     var t = GameGlobal.manager.gameInstance.Module.wasmPath;
     *     WebAssembly.instantiate(t, a).then(...)
     *   }
     * 其中 wasmPath 是【微信虚拟文件系统里的字符串路径】，浏览器原生
     * WebAssembly.instantiate 拿到字符串会返回一个永不 resolve 的 Promise，
     * 于是 Unity 初始化永远挂住 —— 表现为「invoke UnityModule 之后就没了」。
     *
     * 我们本地提供的是完整的 22MB wasm（Module.wasmBin），完全不需要分包，
     * 所以把这个钩子抹掉，让 framework 回落到标准分支：
     *   if (Module.instantiateWasm) {...}  ← 跳过
     *   WebAssembly.instantiate(Module.wasmBin, imports)   ← 走这条
     */
    if (!mgr.__wasmSplitCleaned) {
      mgr.__wasmSplitCleaned = true;

      /**
       * 核心拦截：wasm-split.js 在 game.js 执行期间会做
       *   GameGlobal.unityNamespace.instantiateWasm = function(a,e){ ... }
       * 这个实现拿 Module.wasmPath（微信 FS 里的字符串路径）去调浏览器原生
       * WebAssembly.instantiate，结果是「永不 resolve 的 Promise」，
       * 于是 Unity 卡在 addRunDependency('wasm-instantiate') 上，永不结束。
       *
       * 我们本地有完整 wasm（Module.wasmBin），不需要任何分包，
       * 所以要在 unityNamespace 一出现时就把它变成「instantiateWasm 只读黑洞」。
       *
       * 时序上必须用 defineProperty 抓住 GameGlobal.unityNamespace 的赋值，
       * 因为 game.js 是在运行时才创建这个对象的，用定时器清理来不及。
       */
      var trapNs = function (ns) {
        if (!ns || ns.__instantiateTrapped) return ns;
        try {
          Object.defineProperty(ns, '__instantiateTrapped', { value: true, enumerable: false });
          // 用访问器顶掉原来的数据属性
          Object.defineProperty(ns, 'instantiateWasm', {
            configurable: true,
            enumerable: false,
            get: function () { return undefined; },
            set: function () {
              log('已拦截 unityNamespace.instantiateWasm 赋值（代码分包旁路生效）');
            }
          });
        } catch (e) {
          console.warn('[wx-loader] 拦截 instantiateWasm 失败:', e);
        }
        return ns;
      };

      try {
        var curNs = G.unityNamespace;
        if (curNs) trapNs(curNs);
        Object.defineProperty(G, 'unityNamespace', {
          configurable: true,
          enumerable: true,
          get: function () { return curNs; },
          set: function (v) { curNs = trapNs(v); }
        });
      } catch (e) {
        console.warn('[wx-loader] 无法劫持 GameGlobal.unityNamespace:', e);
      }
    }

    installInstantiateWasmShim();
  }

  // ---------------------------------------------------------------------
  // 4.1 wasm 实例化补丁 —— 为 imports 补齐 wasm-split 需要的命名空间
  // ---------------------------------------------------------------------
  /**
   * 问题背景（必须理解，否则改动会破坏启动）
   * ---------------------------------------------------------------
   * 官方 wasm-split.js 的正常链路是：
   *
   *   GameGlobal.unityNamespace.instantiateWasm = function(imports, done){
   *       var p = GameGlobal.manager.gameInstance.Module.wasmPath;   // 微信FS字符串
   *       preInstantiateWasm(0, imports);        // ← 关键：把 primary / wasm_split
   *                                              //   灌进 imports 对象
   *       WebAssembly.instantiate(p, imports)    // 微信侧用 WXWebAssembly，能吃字符串
   *           .then(function(r){ postInstantiateWasm(imports, r, done) })
   *       return {};
   *   }
   *
   *   preInstantiateWasm 做的事：
   *     imports.primary = {table: Table(183185), memory: undefined, __stack_*}
   *     imports.wasm_split = { wait(), logCall(), __wasm_split_waitTableId,
   *                            __wasm_split_logCallBaseAddr }
   *     imports.asm2wasm = { 'f64-to-int', 'f64-rem' }
   *
   * 我们为了绕开「wasmPath 字符串喂给浏览器 WebAssembly.instantiate 会永远挂住」
   * 的问题，把这个 instantiateWasm 抹掉了，让 framework 走自己的 fallback 分支。
   * 但 framework 的 fallback 只组装了 env / wx / wasi_snapshot_preview1 三个
   * 命名空间（见 lib/game.js 里 `var i={env:e4,wx:{...},wasi_snapshot_preview1:e4}`），
   * 于是 wasm 的 import #889 报：
   *   Import #889 "wasm_split": module is not an object or function
   *
   * 官方 wasm 实际需要的非 env import（实测 WebAssembly.Module.imports）：
   *   wasi_snapshot_preview1 : 7 个 function   ← framework 已提供
   *   wasm_split.wait                         : function
   *   wasm_split.__wasm_split_waitTableId     : global i32
   *   primary.__stack_pointer / __stack_end / __stack_base : global i32
   *   primary.__indirect_function_table       : table funcref(183185)
   *
   * 解法：给 Module.instantiateWasm 装一个我们自己的实现。
   * framework 的调用方式是 `if (j.instantiateWasm) return j.instantiateWasm(i, n)`，
   * 也就是由我们负责实例化并回调 done(instance[, module])。
   * 我们只补 imports 里【确实缺失】的命名空间，绝不覆盖已有项，
   * 然后走标准 WebAssembly.instantiate —— 完全离线、完全在浏览器里。
   */
  var TABLE_SIZE = 183185;   // 与 import-func-index.js 的 tableSize 一致

  /**
   * wasmcode1 的预编译缓存。
   *
   * 为什么必须预编译：
   *   wasm_split.wait() 是被 wasm 内部【同步】调进来的，只能做同步操作，
   *   没法 await。而 Chromium 有一条硬策略：
   *     RangeError: WebAssembly.Compile is disallowed on the main thread,
   *                 if the buffer size is larger than 8MB
   *   即主线程上同步创建 >8MB 的 WebAssembly.Module 会被直接拒绝。
   *   wasmcode1 有 38MB，所以 `new WebAssembly.Module(buf)` 在 wait() 里
   *   必然抛这个 RangeError。
   *
   * 解法：
   *   在启动早期（页面加载、wasm 实例化之前）就用异步的
   *   WebAssembly.compile() 把这个包编译好并缓存 Module 对象。
   *   异步编译不受 8MB 限制（在后台线程编译）。
   *   等到 wait() 被调用时，只做同步的 `new WebAssembly.Instance(module, imports)`
   *   —— 实例化（链接 + 执行 elem/data 段）是同步且允许的，不涉及编译。
   */
  var SUB_WASM_URL = 'assets/wasmcode1_decompressed.wasm';
  var subWasm = { promise: null, module: null, bytes: 0, error: null };

  function precompileSubWasm() {
    if (subWasm.promise) return subWasm.promise;
    var t0 = Date.now();
    console.log('[wx-loader] 开始预编译 wasmcode1（' + SUB_WASM_URL + '）…');
    subWasm.promise = fetch(SUB_WASM_URL, { credentials: 'same-origin', cache: 'force-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (ab) {
        subWasm.bytes = ab.byteLength;
        return WebAssembly.compile(ab);   // 异步：允许 >8MB
      })
      .then(function (m) {
        subWasm.module = m;
        subWasm.error = null;
        console.log('[wx-loader] wasmcode1 预编译完成：' +
          Math.round(subWasm.bytes / 1048576) + 'MB，耗时 ' + (Date.now() - t0) + 'ms' +
          '，导入项 ' + WebAssembly.Module.imports(m).length + ' 个');
        return m;
      })
      .catch(function (e) {
        subWasm.error = e;
        console.error('[wx-loader] wasmcode1 预编译失败:', e);
        throw e;
      });
    return subWasm.promise;
  }

  // 立刻启动预编译（与 22MB 主 wasm 的实例化并行，互不阻塞）
  try { precompileSubWasm(); } catch (e) { /* 忽略：fetch 不可用时降级到同步 XHR */ }

  /**
   * 异步实例化 wasmcode1 并回填「就绪」标志。
   *
   * 必须由 __installInstantiateWasmOnModule 的 afterInstantiate 调用 ——
   * 那时主 wasm 的 exports 已经拿到，primary.memory / primary.table /
   * primary['wasm_split.initGlobal'] 都已回填，wasmcode1 才能成功链接
   * （它的 active elem 段要把函数写进 primary.table，data 段要写 primary.memory）。
   *
   * 用异步 WebAssembly.instantiate（不是 new Instance），
   * 因为 Chromium 只拦截主线程上的【同步】实例化 >8MB 模块。
   */
  function awaitSubWasm(imports) {
    if (G.__subWasmPromise) return G.__subWasmPromise;
    var t0 = Date.now();
    G.__subWasmPromise = precompileSubWasm()
      .then(function (mod) {
        return WebAssembly.instantiate(mod, imports);
      })
      .then(function (inst) {
        G.__wasmCode1Instance = inst;
        // 通知 wait()：表已经填好了，可以继续
        if (imports.wasm_split) imports.wasm_split.__ready = true;
        G.__subWasmReady = true;
        console.log('[wx-loader] wasmcode1 实例化完成：' +
          Math.round((subWasm.bytes || 0) / 1048576) + 'MB，总耗时 ' + (Date.now() - t0) + 'ms' +
          '，table 长度 ' + (imports.primary && imports.primary.table ? imports.primary.table.length : '?'));
        return inst;
      });
    return G.__subWasmPromise;
  }
  G.__awaitSubWasm = awaitSubWasm;

  /**
   * 主动建立 Emscripten WebGL 上下文（只在 Unity 自己没建的情况下动手）。
   *
   * 判断「没建」的依据：`Module.GL.currentContext` 为空。
   *
   * 建的方式与 Emscripten GL 库的 `createContext` + `makeContextCurrent` 一致，
   * 但强制 majorVersion = 2（WebGL2 / GLES 3.0）——
   * 这正是 Unity 判定 graphicsShaderLevel = 35 的必要条件。
   *
   * 注意顺序：
   *   1. createContext(canvas, attrs) → 拿到 handle，内部 registerContext
   *   2. makeContextCurrent(handle)   → 设置 GL.currentContext 与 Module.ctx
   *   3. 让 Unity 后续的 shader 编译能拿到真实的 GLctx
   */
  function ensureGLContext(Module) {
    try {
      var GL = Module && Module.GL;
      if (!GL || typeof GL.createContext !== 'function') {
        log('ensureGLContext：Module.GL 尚不可用，跳过');
        return;
      }
      if (GL.currentContext) {
        log('ensureGLContext：Unity 已自建上下文，跳过');
        return;
      }
      var canvas = Module.canvas;
      if (!canvas) {
        console.warn('[wx-loader] ensureGLContext：Module.canvas 为空，跳过');
        return;
      }

      // 先看画布上是否已被插件绑定过 webgl2（插件在 initGlobal 阶段就 getContext 了）。
      // 若已绑定，直接复用同一个 context 对象，避免「同类型二次 getContext」被规范拒绝。
      var existingGL = null;
      try {
        existingGL = canvas.getContext('webgl2') || canvas.getContext('webgl');
      } catch (e) { /* 忽略 */ }

      var attrs = {
        alpha: true,
        depth: true,
        stencil: true,
        antialias: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
        failIfMajorPerformanceCaveat: false,
        majorVersion: 2,          // ★ GLES 3.0 / WebGL2，Unity 据此判 graphicsShaderLevel=35
        minorVersion: 0,
        enableExtensionsByDefault: true,
        explicitSwapControl: false,
        proxyContextToMainThread: 0,
        renderViaOffscreenBackBuffer: false
      };

      var handle = GL.createContext(canvas, attrs);
      if (!handle) {
        console.error('[wx-loader] ensureGLContext：GL.createContext 返回 0（创建失败）' +
          (existingGL ? '；画布上已有 context，可能是类型冲突' : ''));
        return;
      }
      GL.makeContextCurrent(handle);

      // ── 关键补丁：同步 Module 上 Unity 会读的标志 ──────────────────
      //
      // Unity 的 wasm 判定 WebGL 版本时会看这几个 JS 侧标志，
      // 如果它们缺失/为假，就按最低端（GLES2 / shader level 30）处理：
      //   Module.useWebGL  —— 表示当前上下文是 GL（而不是 2d）
      //   Module.ctx       —— 当前 GLctx（makeContextCurrent 已设，这里确保不被覆盖）
      Module.useWebGL = true;
      try {
        var cur0 = GL.currentContext;
        if (cur0 && cur0.GLctx && !Module.ctx) Module.ctx = cur0.GLctx;
      } catch (e2) { /* 忽略 */ }

      var cur = GL.currentContext;
      var ctxOk = !!(cur && cur.GLctx);
      console.log('[wx-loader] 已建立 WebGL 上下文：handle=' + handle +
        '，版本=' + (cur ? cur.version : '?') +
        '，GLctx=' + (ctxOk ? 'ok' : 'null') +
        '，Module.ctx=' + (Module.ctx ? 'set' : 'null'));
      if (ctxOk) {
        try {
          var v = cur.GLctx.getParameter(cur.GLctx.VERSION);
          var sl = cur.GLctx.getParameter(cur.GLctx.SHADING_LANGUAGE_VERSION);
          console.log('[wx-loader]   VERSION =', v, '| SHADING_LANGUAGE_VERSION =', sl);
          G.__glctxReady = true;
        } catch (e) { /* 忽略 */ }
      }
    } catch (e) {
      console.warn('[wx-loader] ensureGLContext 异常（不影响后续流程）:', e);
    }
  }

  // 供 unity-shim 在 UnityModule 的最早时机调用
  window.__ensureGLContextEarly = ensureGLContext;

  function makeSplitNamespaces(imports) {    var need = imports || {};

    // ---- 【修复】glTexImage3D 的字节数计算漏乘 depth ----
    //
    // ── 问题 ────────────────────────────────────────────────────────
    // framework 的 GL 桥接实现是：
    //     texImage3D(t, lv, ifmt, w, h, depth, border, fmt, type, ptr) {
    //       D.texImage3D(t, lv, ifmt, w, h, depth, border, fmt, type,
    //                    eV(ptr, fmt, w, h, size, 0));
    //     }
    // 而 eV(ptr, format, type, width, size, offset) 内部算的是：
    //     bytes = width * bytesPerPixel(format) * size
    // 代进实参：width=w, size=h  →  bytes = w * bpp * h
    //
    //   → 少乘了 depth！
    //
    // 后果：只要 depth > 1（即 Texture2DArray / Texture3D，GLES3 专属），
    //   传给 GL 的 ArrayBufferView 就只有应有大小的 1/depth，
    //   浏览器直接拒绝：
    //     WebGL: INVALID_OPERATION: texImage3D:
    //            ArrayBufferView not big enough for request
    //   纹理没上传成功 → 后续引用该纹理的绘制状态错乱 → 最终 wasm 越界。
    //
    // 为什么真机上不炸：微信原生路径走的是 wxwebgl2 / GLX 绑定，
    //   根本不经过这段 JS 的 eV()。这是浏览器移植独有的缺陷。
    //
    // ── 修法 ────────────────────────────────────────────────────────
    // 在 env 层重新实现 texImage3D：自己按 w*h*depth*bpp 建 view，
    // 不再依赖那套参数错位的 eV()。
    if (need.env && typeof need.env.glTexImage3D === 'function' &&
        !need.env.__texImage3DFixed) {
      need.env.__texImage3DFixed = true;
      var _ti3 = need.env.glTexImage3D;
      // GL 枚举 → 每像素字节数（只覆盖 Unity 实际会用的格式）
      var FORMAT_BPP = {
        6403: 1, 6404: 1, 6405: 2, 6406: 1, 6407: 3, 6408: 4, 6409: 1, 6410: 2,
        33319: 2, 33320: 2, 36244: 1, 36248: 2, 36249: 4,
        6402: 2, 34041: 4, 33779: 4, 36269: 4
      };
      var TYPE_SIZE = {
        5120: 1, 5121: 1, 5122: 2, 5123: 2, 5124: 4, 5125: 4,
        5126: 4, 36193: 2, 33635: 2, 34042: 4
      };
      need.env.glTexImage3D = function (target, level, internalFormat,
                                        width, height, depth, border,
                                        format, type, pixelsPtr) {
        if (!pixelsPtr) {
          return _ti3.apply(this, arguments);
        }
        try {
          var mem = need.env.memory ||
                    (G.__wasmSplitInfo && G.__wasmSplitInfo.primary && G.__wasmSplitInfo.primary.memory);
          if (!mem || !mem.buffer) return _ti3.apply(this, arguments);

          var bpp = FORMAT_BPP[format] || 4;
          var tsz = TYPE_SIZE[type] || 1;
          var bytes = width * height * depth * bpp * tsz;
          if (!(bytes > 0) || pixelsPtr + bytes > mem.buffer.byteLength) {
            return _ti3.apply(this, arguments);
          }

          // 走框架自己的 WebGL 上下文（D 在闭包里，用 Module.ctx）
          var glctx = Module && Module.ctx;
          if (!glctx || typeof glctx.texImage3D !== 'function') {
            return _ti3.apply(this, arguments);
          }
          var view = new Uint8Array(mem.buffer, pixelsPtr, bytes);
          glctx.texImage3D(target, level, internalFormat, width, height, depth,
                           border, format, type, view);
          if (!window.__tex3dFixedCount) window.__tex3dFixedCount = 0;
          window.__tex3dFixedCount++;
          return;
        } catch (e) {
          return _ti3.apply(this, arguments);
        }
      };
      log('已修正 glTexImage3D 的字节数计算（补乘 depth）');
    }

    // ---- 【诊断+修复】3D 纹理家族全部加计数，定位真正报错的那个 ----
    //
    // 现象：texImage3D 报 "ArrayBufferView not big enough"，
    //      但我们补的 glTexImage3D 一次都没被调到。
    // 说明实际走的是同族的另一个入口（Compressed / SubImage）。
    // 这几个函数的字节数计算在 framework 里同样有「漏乘 depth」的问题，
    // 统一在这里拦一层：能修的直接修正，修不了的至少留下调用记录。
    if (need.env && !need.env.__tex3dProbed) {
      need.env.__tex3dProbed = true;
      window.__tex3dCalls = {};
      // 压缩格式 → 每块字节数 / 块像素尺寸
      var COMPRESSED = {
        33776: [8, 4, 4], 33777: [8, 4, 4], 33778: [16, 4, 4], 33779: [16, 4, 4],
        35916: [16, 4, 4], 35917: [16, 4, 4],
        36196: [8, 4, 4], 37492: [8, 4, 4], 37496: [16, 4, 4],
        37808: [16, 4, 4], 36492: [16, 4, 4],
        37497: [16, 4, 4], 37498: [16, 4, 4],
        0x8D64: [8, 4, 4]
      };
      // ── 直接修正 glTexImage3D ────────────────────────────────────
      //
      // 实测参数（崩溃前的真实调用）：
      //   glTexImage3D(target=32879 TEXTURE_2D_ARRAY, level=0,
      //                internalformat=6406 RGBA, w=4, h=4, depth=16,
      //                border=0, format=6406 RGBA, type=5121 UNSIGNED_BYTE,
      //                ptr=47887712)
      //   正确字节数 = 4*4*16*4 = 1024
      //   framework 算的 = w * bpp * h = 4*4*4 = 64   ← 漏乘 depth=16
      //
      // 这就是 "texImage3D: ArrayBufferView not big enough" 的唯一成因。
      // 修法：绕开框架的 eV()，自己按 w*h*depth*bpp*typeSize 建 view。
      var FORMAT_BPP = {
        6403: 1, 6404: 1, 6405: 2, 6406: 4, 6407: 3, 6408: 4, 6409: 1, 6410: 2,
        33319: 2, 33320: 2, 36244: 1, 36248: 2, 36249: 4,
        6402: 2, 34041: 4, 33779: 4, 36269: 4
      };
      var TYPE_SIZE = {
        5120: 1, 5121: 1, 5122: 2, 5123: 2, 5124: 4, 5125: 4,
        5126: 4, 36193: 2, 33635: 2, 34042: 4
      };
      need.env.__tex3dFix = function (orig, fnName) {
        return function (target, level, internalFormat,
                       width, height, depth, border, format, type, pixelsPtr) {
          if (!pixelsPtr) return orig.apply(this, arguments);
          var why = '';
          try {
            // 取 Unity 的 Module：wx-loader 作用域里没有 Module 变量，
            // 必须经由 GameGlobal.manager.gameInstance.Module 拿到。
            var M = (G.manager && G.manager.gameInstance && G.manager.gameInstance.Module) ||
                    G.Module || null;
            var mem = need.env.memory ||
                      (G.__wasmSplitInfo && G.__wasmSplitInfo.primary && G.__wasmSplitInfo.primary.memory) ||
                      (M && M.asm && M.asm.memory);
            // GL 上下文：优先 Module.ctx，退回框架自带的 GL.currentContext
            var glctx = (M && M.ctx) ||
                        (M && M.GL && M.GL.currentContext && M.GL.currentContext.GLctx) || null;
            if (!mem || !mem.buffer) { why = 'no-memory'; }
            else if (!glctx) { why = 'no-glctx'; }
            else if (typeof glctx.texImage3D !== 'function') { why = 'no-texImage3D'; }
            else {
              var bpp = FORMAT_BPP[format] || 4;
              var tsz = TYPE_SIZE[type] || 1;
              var bytes = width * height * depth * bpp * tsz;
              if (!(bytes > 0)) { why = 'bytes=0'; }
              else if (pixelsPtr + bytes > mem.buffer.byteLength) { why = 'oob ptr+bytes=' + (pixelsPtr + bytes); }
              else {
                glctx.texImage3D(target, level, internalFormat, width, height, depth,
                                 border, format, type,
                                 new Uint8Array(mem.buffer, pixelsPtr, bytes));
                window.__tex3dFixedCount = (window.__tex3dFixedCount || 0) + 1;
                if (window.__tex3dFixedCount <= 2) {
                  console.log('[wx-loader][tex3d] 已修正 ' + fnName + ': ' +
                    width + 'x' + height + 'x' + depth + ' fmt=' + format +
                    ' type=' + type + ' -> ' + bytes + ' bytes');
                }
                return;
              }
            }
          } catch (e) {
            why = 'exception: ' + (e && e.message);
          }
          if (!window.__tex3dFailLogged) {
            window.__tex3dFailLogged = true;
            console.warn('[wx-loader][tex3d] 修正失败，回退框架实现。原因: ' + why);
          }
          return orig.apply(this, arguments);
        };
      };

      var names3d = ['glTexImage3D', 'glTexSubImage3D',
                     'glCompressedTexImage3D', 'glCompressedTexSubImage3D'];
      names3d.forEach(function (fn) {
        if (typeof need.env[fn] !== 'function') return;
        var orig = need.env[fn];
        // glTexImage3D 做真实修正；其余先只计数观察
        need.env[fn] = (fn === 'glTexImage3D')
          ? need.env.__tex3dFix(orig, fn)
          : orig;
        var target = need.env[fn];
        need.env[fn] = function () {
          var a = arguments;
          window.__tex3dCalls[fn] = (window.__tex3dCalls[fn] || 0) + 1;
          if (window.__tex3dCalls[fn] === 1) {
            console.log('[wx-loader][tex3d] 首次调用 ' + fn + ' 参数 = ' +
              Array.prototype.slice.call(a).join(', '));
          }
          return target.apply(this, arguments);
        };
      });
      log('已给 3D 纹理家族装计数探针（glTexImage3D 已修正 depth 字节计算）');
    }

    // ---- 【诊断】C++ / IL2CPP 异常链配平监控 ----
    //
    // 目的：验证「Gravity 抛的 ArgumentException 导致越界」这个假设。
    //   · __cxa_throw / __cxa_begin_catch / __cxa_end_catch 必须配平；
    //   · 若 throw 多于 catch，说明异常没有被正确接住，
    //     IL2CPP 的 unwind 会继续往上走，最终踩到失效的 MethodInfo。
    if (need.env && !need.env.__excProbed) {
      need.env.__excProbed = true;
      var exc = window.__excStats = {
        throw: 0, beginCatch: 0, endCatch: 0, rethrow: 0,
        resume: 0, alloc: 0, free: 0, findCatch: 0,
        lastThrowAt: 0, throwAtFrame: null
      };
      var EXC_MAP = {
        '__cxa_throw': 'throw',
        '__cxa_begin_catch': 'beginCatch',
        '__cxa_end_catch': 'endCatch',
        '__cxa_rethrow': 'rethrow',
        '__resumeException': 'resume',
        '__cxa_allocate_exception': 'alloc',
        '__cxa_free_exception': 'free',
        '__cxa_find_matching_catch_2': 'findCatch',
        '__cxa_find_matching_catch_3': 'findCatch',
        '__cxa_find_matching_catch_4': 'findCatch'
      };
      Object.keys(EXC_MAP).forEach(function (fn) {
        if (typeof need.env[fn] !== 'function') return;
        var k = EXC_MAP[fn];
        var orig = need.env[fn];
        need.env[fn] = function () {
          exc[k]++;
          if (k === 'throw') {
            exc.lastThrowAt = Date.now();
            exc.throwAtFrame = window.__frameNo || 0;
            console.log('[wx-loader][exc] __cxa_throw 第 ' + exc.throw + ' 次，帧号 ' +
              (window.__frameNo || 0) + '，指针=' + arguments[0]);
          }
          return orig.apply(this, arguments);
        };
      });
      log('已挂异常链监控（throw/catch/rethrow）');
    }

    // ---- 【诊断】env 全量调用轨迹（崩溃定位用）----
    //
    // 目的：崩溃在第 7 帧，栈全在 wasm 内部，看不到是哪个 JS 桥接触发的。
    // 做法：把 imports.env 上每个函数都包一层，只保留最近 200 条调用记录
    //       （环形缓冲，几乎零开销），崩溃后可以从 window.__envTrace 取到
    //       「崩溃前最后触发的 JS 桥接序列」。
    // 注意：这个包装必须在 WebAssembly.instantiate 之前装好（即此处），
    //      因为 import object 一旦实例化就被固化。
    if (need.env && !need.env.__envTraceInstalled) {
      need.env.__envTraceInstalled = true;
      var ring = [];
      var RING_MAX = 200;
      window.__envTrace = ring;
      Object.keys(need.env).forEach(function (k) {
        var orig = need.env[k];
        if (typeof orig !== 'function') return;
        need.env[k] = function () {
          // 只记名字和第一个参数（指针/枚举值最关键），控制开销
          ring.push(k + '(' + (arguments.length ? String(arguments[0]).slice(0, 24) : '') + ')');
          if (ring.length > RING_MAX) ring.shift();
          return orig.apply(this, arguments);
        };
      });
      log('已安装 env 调用轨迹（' + Object.keys(need.env).length + ' 个函数，环形缓冲 ' + RING_MAX + '）');
    }

    // ---- wasm_split 命名空间 ----
    if (!need.wasm_split) {
      var waitTableId = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
      var logCallBaseAddr = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);

      // 记下来，后面同步到 unityNamespace（插件里 reportCalledFunc 会读它）
      G.__wasmSplitGlobals = { waitTableId: waitTableId, logCallBaseAddr: logCallBaseAddr };

      /**
       * wasm_split.wait(tableId) —— wasm-split 机制的核心。
       *
       * 背景：这个游戏的主 wasm（primary，23MB）只是一部分函数体；
       * 剩下约 36MB 的函数体在第二包 wasmcode1 里（无导出，
       * 靠 active elem 段在实例化时把函数引用写进导入的 primary.table）。
       * primary 里被拆出去的函数调用点是一个桩：
       *   先调 wasm_split.wait(tableId)，等表项就位后再经表间接调用。
       *
       * ── 浏览器上的核心矛盾 ──────────────────────────────────────────
       * 真实微信环境里 wait() 是【同步】读 wasmcode1 并用 WXWebAssembly 同步实例化。
       * 但 Chromium 有两条硬限制（third_party/blink/.../v8_initializer.cc）：
       *   WasmModuleOverride   : 主线程同步 new WebAssembly.Module(buf) ，
       *                          buf > 8MB → RangeError
       *   WasmInstanceOverride : 主线程同步 new WebAssembly.Instance(mod, ...)，
       *                          mod 的 wire bytes > 8MB → RangeError
       * 而 wasmcode1 有 36MB —— 同步路径彻底不可行，异步 WebAssembly.instantiate
       * 又返回 Promise，无法在同步的 wait() 里使用。
       *
       * ── 解法：把 wait() 变成「纯断言」，实例化提前到 done() 之前 ────────
       * wait() 之所以必须同步，唯一原因是它被 wasm main() 内部同步调用。
       * 但 main() 什么时候被调用，完全由我们控制 ——
       * framework 的调用链是：
       *   Module.instantiateWasm(imports, done)
       *     → 我们 WebAssembly.instantiate(主 wasm)  // 异步，拿到 memory/table
       *     → 我们 await WebAssembly.instantiate(wasmcode1)  // 异步，主线程允许
       *     → done(instance) → removeRunDependency → callMain → main()
       *
       * 也就是说：只要我们在回调 done() 之前把 wasmcode1 那份异步实例化做完，
       * 等 main() 真正跑到 wait() 时，表项早就填好了，wait() 直接 return 即可。
       * 同步限制被彻底绕开，而且没有任何 hack。
       */
      var subWasmReady = false;
      need.wasm_split = {
        wait: function (tableId) {
          if (G.__subWasmReady || subWasmReady) {
            // 记录被调用的函数 ID，用于确认桩到底在分发什么
            try {
              var tid = waitTableId.value;
              window.__waitCalls = window.__waitCalls || [];
              if (window.__waitCalls.length < 60) {
                window.__waitCalls.push(tid + '(arg=' + tableId + ')');
              }
              // 自检：这个 ID 指向的表项必须是有效函数
              var tbl = need.primary && (need.primary.table || need.primary.__indirect_function_table);
              if (tbl) {
                var fn = tbl.get(tid);
                if (!fn) {
                  console.error('[wx-loader][wait] ⚠️ 函数 ID ' + tid +
                    ' 对应的表项为空！这就是越界的根源');
                }
              }
            } catch (e) {}
            return;   // 正常路径：已完成
          }
          // 走到这里说明 afterInstantiate 的异步实例化没做完（不应该发生）。
          // 主线程同步编译/实例化 36MB 必然被 Chrome 拒绝，只能抛出清晰错误。
          var msg = 'wasm_split.wait(' + tableId + ') 在 wasmcode1 就绪之前被调用：' +
            '主线程无法同步实例化 36MB 模块' +
            (subWasm.error ? '（预编译错误：' + subWasm.error + '）' : '');
          console.error('[wx-loader] ' + msg);
          throw new Error(msg);
        },
        logCall: function () { /* 仅用于调用统计上报，离线环境无意义 */ },
        __wasm_split_waitTableId: waitTableId,
        __wasm_split_logCallBaseAddr: logCallBaseAddr
      };
      log('已补齐 imports.wasm_split');
    }

    // ---- primary 命名空间：3 个栈全局 + 函数表 ----
    if (!need.primary) {
      need.primary = {
        __stack_pointer: new WebAssembly.Global({ value: 'i32', mutable: true }, 0),
        __stack_end: new WebAssembly.Global({ value: 'i32', mutable: true }, 0),
        __stack_base: new WebAssembly.Global({ value: 'i32', mutable: true }, 0)
      };
      log('已补齐 imports.primary');
    }
    if (!need.primary.__indirect_function_table && !need.primary.table) {
      need.primary.__indirect_function_table = new WebAssembly.Table({
        initial: TABLE_SIZE, maximum: TABLE_SIZE, element: 'anyfunc'
      });
      // 插件内部用 a.primary.table 这个名字取值填充 window.FUNCTION_TABLE
      need.primary.table = need.primary.__indirect_function_table;
      log('已补齐 imports.primary.__indirect_function_table（' + TABLE_SIZE + ' 项）');
    }

    // ---- asm2wasm：老版 Emscripten 的数学辅助函数 ----
    if (!need.asm2wasm) {
      need.asm2wasm = {
        'f64-to-int': function (x) { return x | 0; },
        'f64-rem': function (a, b) { return a % b; }
      };
    }

    G.__wasmSplitInfo = need;

    // ---- 主循环守门员 ----
    //
    // wasm 的 main() 里会调 env.emscripten_set_main_loop(frameCb, fps, simulate)，
    // framework 收到后走 n6() → 建立 mainLoop.runner/scheduler。
    // 但 n6 末尾的写法是：
    //     if (!r) {                       // r = simulateInfiniteLoop
    //       n && n > 0 ? n4(0, 1000/n) : n4(1, 1);
    //       if (!GameGlobal.unityNamespace.isLoopRunnerEnable) return;
    //       mainLoop.scheduler();
    //     }
    // 也就是说：当 simulate=1（Unity 的常规做法）时，n6 只负责建好 func/runner，
    // 并不会启动循环；启动是靠之后 plugin 的 calledMainCb → mainLoop.resume()。
    //
    // 我们在 UnityModule 层已经补了 unityNamespace.requestAnimationFrame，
    // resume 现在能正常建 scheduler 并驱动 runner 了。
    // 这里额外记录一下 set_main_loop 是否真的被 wasm 调到，便于排障。
    try {
      log('imports keys =', Object.keys(need).join(','), '| env keys 数 =', need.env ? Object.keys(need.env).length : 'no env');
      // 【诊断】统计 GL 桥接的真实调用情况：
      // Unity 判 graphicsShaderLevel 之前一定会做 GL 能力探测，
      // 我们包一层计数器来确认这条路径到底有没有被走到。
      if (need.env && !need.env.__glCounters) {
        need.env.__glCounters = { calls: {}, t0: Date.now() };
        var cnt = need.env.__glCounters.calls;
        var WATCH = ['glGetString', 'glGetIntegerv', 'glGetStringi', 'glCreateShader',
                     'glCompileShader', 'glShaderSource', 'glGetShaderiv', 'glGetProgramiv',
                     'glLinkProgram', 'glBindFramebuffer', 'glClear', 'glDrawElements',
                     'glDrawArrays', 'glEnable', 'glViewport', 'emscripten_webgl_create_context',
                     'emscripten_webgl_make_context_current', 'emscripten_webgl_enable_extension'];
        WATCH.forEach(function (k) {
          var orig = need.env[k];
          if (typeof orig !== 'function') return;
          need.env[k] = function () {
            cnt[k] = (cnt[k] || 0) + 1;
            return orig.apply(this, arguments);
          };
        });
        // 30 秒后 dump
        setTimeout(function () {
          try {
            console.log('[wx-loader][glcount] GL 调用统计：' + JSON.stringify(cnt));
          } catch (e) {}
        }, 12000);
      }

      // ── 修复 GL_NUM_EXTENSIONS 与 glGetStringi 数量不一致导致的越界崩溃 ──
      //
      // 现象：hasWebGL=2（WebGL2/GLES3）后，游戏主循环第 6 帧就
      //       RuntimeError: memory access out of bounds
      // 根因（framework lib/game.js 的 GL 粘合层自带的不一致）：
      //   glGetIntegerv(0x821D = GL_NUM_EXTENSIONS) 返回
      //       l = 2 * f.length          （扩展数 × 2）
      //   而 glGetStringi(0x1F03 = GL_EXTENSIONS, i) 的索引表只有
      //       e = f.map(i4)             （扩展数 × 1）
      //   wasm 侧按 [0, 2N) 遍历扩展，访问 [N, 2N) 时拿到 undefined，
      //   空指针继续参与字符串拼接 → wasm 堆越界。
      //
      // 修法：包一层 glGetIntegerv，把 GL_NUM_EXTENSIONS 修正为与
      // glGetStringi 实际可返回的数量一致（f.length）。两侧自洽后不再越界。
      if (need.env && typeof need.env.glGetIntegerv === 'function' &&
          !need.env.__numExtFixed) {
        need.env.__numExtFixed = true;
        var _gi = need.env.glGetIntegerv;
        need.env.glGetIntegerv = function (pname, paramsPtr) {
          // 0x821D = 33309 = GL_NUM_EXTENSIONS
          if (pname === 33309) {
            try {
              var GLO = (Module && Module.GL) || G.unityNamespace && G.unityNamespace.Browser;
              // 从 canvas 直接拿扩展列表（与 glGetStringi 的数据源一致）
              var c = Module && Module.canvas;
              var glctx = c && (c.getContext('webgl2') || c.getContext('webgl'));
              var n = ((glctx && glctx.getSupportedExtensions()) || []).length;
              // 写到 wasm 内存
              var mem = (G.__wasmSplitInfo && G.__wasmSplitInfo.primary && G.__wasmSplitInfo.primary.memory) ||
                        (need.env && need.env.memory);
              if (mem && mem.buffer) {
                var dv = new DataView(mem.buffer);
                dv.setInt32(paramsPtr, n, true);
              }
              return;
            } catch (e) { /* 出错就退回原实现 */ }
          }
          return _gi.apply(this, arguments);
        };
      }
      // 【诊断】GL_VERSION(7938) / GL_SHADING_LANGUAGE_VERSION(35724) / GL_RENDERER(7937)
      // Unity 靠这些字符串判定 graphicsShaderLevel，必须看它们实际返回什么
      if (need.env && typeof need.env.glGetString === 'function' && !need.env.__glGetStringWrapped) {
        need.env.__glGetStringWrapped = true;
        var _gs = need.env.glGetString;
        need.env.glGetString = function (name) {
          var r = _gs.apply(this, arguments);
          try {
            var txt = null;
            if (r) {
              var mem = need.env.memory || (Module && Module.asm && Module.asm.memory);
              if (!mem) { var m = (G.__wasmSplitInfo && G.__wasmSplitInfo.primary && G.__wasmSplitInfo.primary.memory); mem = m; }
              if (mem && mem.buffer) {
                var u8 = new Uint8Array(mem.buffer, r, 160);
                txt = '';
                for (var i = 0; i < u8.length && u8[i]; i++) txt += String.fromCharCode(u8[i]);
              }
            }
            console.log('[wx-loader][probe] glGetString(' + name + ') = "' + txt + '"');
          } catch (e) { /* 忽略 */ }
          return r;
        };
      }
      // 【诊断】GL 能力探测：Unity 判 graphicsShaderLevel 的关键路径
      if (need.env && typeof need.env.emscripten_webgl_enable_extension === 'function' &&
          !need.env.__glExtWrapped) {
        need.env.__glExtWrapped = true;
        var _en = need.env.emscripten_webgl_enable_extension;
        need.env.emscripten_webgl_enable_extension = function (ctx, namePtr) {
          var r = _en.apply(this, arguments);
          try {
            var nm = namePtr;
            var mem2 = need.env.memory || (G.__wasmSplitInfo && G.__wasmSplitInfo.primary && G.__wasmSplitInfo.primary.memory);
            if (mem2 && mem2.buffer) {
              var u8b = new Uint8Array(mem2.buffer, namePtr, 64);
              nm = '';
              for (var k = 0; k < u8b.length && u8b[k]; k++) nm += String.fromCharCode(u8b[k]);
            }
            console.log('[wx-loader][probe] webgl_enable_extension("' + nm + '") = ' + r);
          } catch (e) { /* 忽略 */ }
          return r;
        };
      }
      if (need.env && typeof need.env.emscripten_webgl_create_context === 'function' &&
          !need.env.__glCCWrapped) {
        need.env.__glCCWrapped = true;
        var _cc = need.env.emscripten_webgl_create_context;
        need.env.emscripten_webgl_create_context = function (target, attrsPtr) {
          var r = _cc.apply(this, arguments);
          try {
            var mm = need.env.memory || (G.__wasmSplitInfo && G.__wasmSplitInfo.primary && G.__wasmSplitInfo.primary.memory);
            var info = '';
            if (mm && mm.buffer) {
              var dv = new DataView(mm.buffer, attrsPtr, 60);
              info = 'majorVersion=' + dv.getInt32(32, true) + ' minor=' + dv.getInt32(36, true) +
                ' alpha=' + dv.getInt32(0, true) + ' depth=' + dv.getInt32(4, true);
            }
            console.log('[wx-loader][probe] webgl_create_context("' + target + '", ' + info + ') => ' + r);
          } catch (e) { /* 忽略 */ }
          return r;
        };
      }
      if (need.env && !need.env.__smlWrapped) {
        need.env.__smlWrapped = true;
        // 【诊断】记录 GL 上下文创建/切换的全部轨迹，
        // 判断 Unity 是不是在我们建好之后又自己建了一个 version=1 的上下文。
        if (!window.__glTraceInstalled) {
          window.__glTraceInstalled = true;
          var _poll = setInterval(function () {
            var M = G.Module || (G.manager && G.manager.gameInstance && G.manager.gameInstance.Module);
            if (!M || !M.GL) return;
            var GLO = M.GL;
            if (GLO.__traced) return;
            GLO.__traced = true;
            clearInterval(_poll);
            ['createContext', 'makeContextCurrent', 'registerContext'].forEach(function (fn) {
              var o = GLO[fn];
              if (typeof o !== 'function') return;
              GLO[fn] = function () {
                var r = o.apply(this, arguments);
                console.log('[wx-loader][gltrace] GL.' + fn + '(' +
                  Array.prototype.slice.call(arguments).map(function (a) {
                    return a && a.majorVersion !== undefined ? '{majorVersion:' + a.majorVersion + '}' : String(a && a.id ? a.id : a);
                  }).join(', ') + ') => ' + r +
                  ' | currentContext=' + (GLO.currentContext ? ('v' + GLO.currentContext.version) : 'null') +
                  ' | contexts=' + (GLO.contexts || []).map(function (c) { return c ? 'v' + c.version : 'x'; }).join('/'));
                return r;
              };
            });
            console.log('[wx-loader][gltrace] 已挂上 GL 轨迹探针');
          }, 30);
        }
        ['emscripten_set_main_loop', 'emscripten_cancel_main_loop',
         'emscripten_set_main_loop_timing', 'emscripten_force_exit',
         'glCreateShader', 'JS_Log', 'UnitySetRuntimeInfo', '_JS_SystemInfo_GetCanvasDimensions'].forEach(function (k) {
          var orig = need.env[k];
          if (typeof orig !== 'function') return;
          need.env[k] = function () {
            console.log('[wx-loader][probe] wasm -> env.' + k +
              '(' + Array.prototype.slice.call(arguments).map(function (a) { return typeof a === 'function' ? 'fn' : a; }).join(', ') + ')');
            try { if (k === 'emscripten_set_main_loop') window.__smlCalled = (window.__smlCalled || 0) + 1; } catch (e) {}
            return orig.apply(this, arguments);
          };
        });
      }
    } catch (e) { /* 不影响主流程 */ }

    return need;
  }

  function installInstantiateWasmShim() {
    if (installInstantiateWasmShim.__done) return;
    installInstantiateWasmShim.__done = true;

    // unity-shim 在 UnityModule 被调用时会把 Module 交给这个队列，
    // 我们把钩子挂在 Module 上（而不是 unityNamespace），粒度最准确。
    window.__installInstantiateWasmOnModule = function (Module) {
      if (!Module || Module.__wasmShimInstalled) return;
      Module.__wasmShimInstalled = true;

      Module.instantiateWasm = function (imports, done) {
        var buf = Module.wasmBinary || Module.wasmBin || ((G.manager && G.manager.gameInstance &&
          G.manager.gameInstance.Module && G.manager.gameInstance.Module.wasmBinary)) || null;

        if (!buf) {
          // 没有 buffer 就不要插手，让 framework 自己报错，便于定位
          console.error('[wx-loader] instantiateWasm：Module.wasmBinary 为空');
          return false;
        }

        makeSplitNamespaces(imports);

        // 【诊断】拦截 Module.ctx / Module.GL 的 setter，看 wasm 侧到底走哪条 GL 初始化路径
        try {
          ['ctx', 'GL'].forEach(function (prop) {
            var _v = Module[prop];
            Object.defineProperty(Module, prop, {
              configurable: true,
              enumerable: true,
              get: function () { return _v; },
              set: function (val) {
                console.log('[wx-loader][probe] Module.' + prop + ' = ' +
                  (val && val.constructor ? val.constructor.name : typeof val));
                _v = val;
                // GL 对象出现后，立刻包一层 createContext
                if (prop === 'GL' && val && !val.__probed && typeof val.createContext === 'function') {
                  val.__probed = true;
                  var origCC = val.createContext;
                  val.createContext = function (canvas, attrs) {
                    var hint = attrs ? ('majorVersion=' + attrs.majorVersion +
                      ' alpha=' + attrs.alpha + ' depth=' + attrs.depth) : 'no-attrs';
                    console.log('[wx-loader][probe] GL.createContext(' +
                      (canvas && canvas.id) + ', ' + hint + ')');
                    // 先探测画布上已绑定的 context 类型
                    var existing = null;
                    try {
                      if (canvas && canvas.getContext) {
                        var g2 = canvas.getContext('webgl2');
                        var g1 = canvas.getContext('webgl');
                        existing = g2 ? 'webgl2' : (g1 ? 'webgl' : 'none');
                      }
                    } catch (e) { existing = 'err:' + e.message; }
                    console.log('[wx-loader][probe]   画布已绑定 context =', existing);
                    var r = origCC.apply(this, arguments);
                    console.log('[wx-loader][probe]   => 返回', r,
                      '| currentContext =', val.currentContext ? 'set' : 'null');
                    return r;
                  };
                }
              }
            });
          });
        } catch (e) { console.warn('[wx-loader] ctx/GL 探针安装失败', e); }

        // 【诊断】拦截 Module._main（framework 稍后会赋值 j._main = wrapper）
        try {
          var realMain = null;
          Object.defineProperty(Module, '_main', {
            configurable: true,
            get: function () {
              return function () {
                console.log('[wx-loader][probe] >>> wasm main() 进入');
                try {
                  var r = realMain.apply(this, arguments);
                  console.log('[wx-loader][probe] <<< wasm main() 正常返回 =', r);
                  return r;
                } catch (e) {
                  console.error('[wx-loader][probe] !!! wasm main() 抛出:',
                    e && (e.stack || e.message || String(e)));
                  throw e;
                }
              };
            },
            set: function (v) { realMain = v; }
          });
        } catch (e) { console.warn('[wx-loader] _main 拦截失败', e); }

        // 与官方 postInstantiateWasm 对齐：把真实的 memory / table 回填，
        // 否则 wasm_split.logCall 之类的回调没有可读内存。
        function afterInstantiate(res) {
          try {
            var exp = res.instance.exports;
            if (exp.memory) {
              imports.primary.memory = exp.memory;
              if (imports.wasm_split) imports.wasm_split.memory = exp.memory;
            }
            if (exp.__indirect_function_table) {
              imports.primary.table = exp.__indirect_function_table;
            }
            // wasmcode1 会导入 primary['wasm_split.initGlobal']（即主模块导出的
            // initGlobal），必须在这里回填，否则 split 包无法实例化。
            if (exp.initGlobal) {
              imports.primary['wasm_split.initGlobal'] = exp.initGlobal;
            }
            // 与官方 postInstantiateWasm 对齐：主模块实例化后立刻 initGlobal
            if (exp.initGlobal) exp.initGlobal();
            // 把全局同步到 unityNamespace，插件的统计代码会读它们
            var ns = G.unityNamespace;
            var gl = G.__wasmSplitGlobals;
            if (ns && gl) {
              ns.waitTableId = gl.waitTableId;
              ns.logCallBaseAddr = gl.logCallBaseAddr;
              ns.logCallBasePtr = 0;
              ns.logCallMemorySize = 0;
            }
            // wasm_split_info 供插件后续读取（instantiatePatch 分支等）
            G.wasm_split_info = imports;
            window.wasm_split_info = imports;
          } catch (e) {
            console.warn('[wx-loader] postInstantiate 回填异常（不影响运行）:', e);
          }

          // ── 关键顺序：先把 wasmcode1 异步实例化完，再回调 done ──────────
          //
          // 为什么能这样做：
          //   done() 才会让 framework 触发 callMain → wasm main()，
          //   而 main() 内部才可能调到 wasm_split.wait()。
          //   所以「回调 done 之前」是我们唯一也是充足的窗口期，
          //   可以放心用异步 WebAssembly.instantiate 实例化 36MB 的 wasmcode1
          //   （异步路径不受主线程 8MB 同步限制）。
          //   等 main() 跑到 wait() 时，表项已被 elem 段填好，wait() 直接返回。
          G.__awaitSubWasm(imports)
            .catch(function (e) {
              // split 包失败不阻塞启动：主 wasm 大部分逻辑仍可用，
              // 只是被拆到 wasmcode1 的那部分函数会走 wait() 的报错分支。
              console.error('[wx-loader] wasmcode1 实例化失败（继续启动）:', e);
            })
            .then(function () {
              // ── 表完整性自检 ────────────────────────────────────────
              // wasm-split 的关键契约是：
              //   主包 elem 先把整张表填成「桩函数」，
              //   第二包 elem 再把桩位置覆盖成真实实现。
              // 若覆盖没发生（或覆盖错位），call_indirect 就会调到桩，
              // 桩里解引用的是未初始化的元数据 → memory access out of bounds。
              // 这里抽查若干关键表项，确认它们确实指向第二包的函数。
              try {
                var tbl = imports.primary.table;
                if (tbl) {
                  var probes = [670, 133116, 131, 157, 158, 214];
                  var info = probes.map(function (i) {
                    var f = tbl.get(i);
                    return i + '->' + (f ? (f.name || 'anon') : 'null');
                  });
                  console.log('[wx-loader][table] 关键表项: ' + info.join(', '));
                  // 统计有多少表项是 null（可能是桩没被覆盖）
                  var nulls = 0;
                  for (var i = 1; i < tbl.length; i++) {
                    if (!tbl.get(i)) nulls++;
                  }
                  console.log('[wx-loader][table] 表长 ' + tbl.length + '，空表项 ' + nulls +
                    '，已就绪 = ' + !!G.__subWasmReady);

                  // ── 崩溃点参数采样 ──────────────────────────────────
                  // 表项 670 = func[14861]，它是崩溃链的上一层；
                  // 崩溃发生在它调下来的 func[14903] 里。
                  // 用 JS 代理替换表项 670，就能在进入 func[14861] 时
                  // 拿到全部实参，从而确认「哪个参数是坏的 MethodInfo」。
                  try {
                    var orig670 = tbl.get(670);
                    if (orig670 && !orig670.__proxied) {
                      var proxy670 = function () {
                        var a = Array.prototype.slice.call(arguments);
                        if (!window.__probe670Count) window.__probe670Count = 0;
                        window.__probe670Count++;
                        var mem = imports.primary.memory;
                        var dump = a.map(function (v, i) {
                          var extra = '';
                          // 对前两个参数按指针解读，看是否是合理对象
                          if (typeof v === 'number' && v > 1024 && mem &&
                              v + 64 < mem.buffer.byteLength) {
                            try {
                              var dv = new DataView(mem.buffer);
                              extra = '{+0=' + dv.getInt32(v, true) +
                                      ',+4=' + dv.getInt32(v + 4, true) +
                                      ',+8=' + dv.getInt32(v + 8, true) +
                                      ',+12=' + dv.getInt32(v + 12, true) +
                                      ',+16=' + dv.getInt32(v + 16, true) + '}';
                            } catch (e) { extra = '{err}'; }
                          }
                          return 'a' + i + '=' + v + extra;
                        }).join(' | ');
                        if (window.__probe670Count <= 3) {
                          console.log('[wx-loader][probe670] 第 ' +
                            window.__probe670Count + ' 次调用: ' + dump);
                        }
                        return orig670.apply(null, a);
                      };
                      proxy670.__proxied = true;
                      tbl.set(670, proxy670);
                      console.log('[wx-loader][table] 已在表项 670 装入参数采样代理');
                    }
                  } catch (e) {
                    console.warn('[wx-loader][table] 表项 670 代理失败', e);
                  }
                }
              } catch (e) {
                console.warn('[wx-loader][table] 自检失败', e);
              }

              // ── 主动帮 Unity 建好 GL 上下文 ────────────────────────
              //
              // 为什么要我们来做：
              //   Unity 的 wasm 在 main() 里通过 env.emscripten_webgl_create_context
              //   或 Module.GL.createContext 建立 WebGL 上下文，
              //   成功后才 registerContext + makeContextCurrent，
              //   这样 Module.GL.currentContext 才有值、Module.ctx 才指向 GLctx。
              //   而 Unity 判定 graphicsShaderLevel（GLES2=30 / GLES3=35）
              //   以及后续所有 shader 编译，全都依赖 GLctx 的能力探测。
              //
              //   实测在浏览器移植环境里这两条调用都没走到（GL.currentContext
              //   一直是 null），于是 Unity 把当前平台判成最低端：
              //       graphicsShaderLevel (current/required) = 30 / 35
              //   结果所有 shader 都被剔除（"shader is not supported on this GPU"），
              //   画面永远黑屏。
              //
              //   这里在 main() 之前补一次上下文创建 —— 只补「缺失」的情况，
              //   如果 Unity 自己已经建好了就完全不动。
              ensureGLContext(Module);
              // framework 的 n(instance, module) 签名：它的 n 只读 i.exports。
              //
              // ⚠️ 必须再延后一拍。
              // 原因：framework 的 `n` 会触发 removeRunDependency('wasm-instantiate')
              // → run() → callMain → plugin.calledMainCb → Browser.mainLoop.resume()。
              // 而 resume() 里做的是：
              //     n6(func, 0, false, arg, true)   // 建立 runner
              //     n4(timingMode, timingValue)     // 建立 scheduler
              //     mainLoop.scheduler()
              // 用 microtask（Promise.then）延后，等 framework 自己的初始化栈退干净，
              // resume() 就能拿到完整的 mainLoop 状态。
              Promise.resolve().then(function () {
                // ── 诊断桩出口 ────────────────────────────────────────
                // tools/wasm_probe_marker.py 会在 wasm 里追加一批「计数器全局」
                // 并导出成 main_Shoot_in / main_BR_rej_barrels 之类的名字。
                // 这里把 exports 挂到 window 上，JS 侧即可直接读 .value。
                // 未打桩时这里只是多一个对象，无副作用。
                try { window.__wasmMainExports = res.instance.exports; } catch (e) {}
                try {
                  // 同一批诊断桩需要读线性内存（例如把命中结构体指针读出来）
                  if (imports && imports.primary && imports.primary.memory) {
                    window.__wasmMemory = imports.primary.memory;
                  } else if (res.instance.exports && res.instance.exports.memory) {
                    window.__wasmMemory = res.instance.exports.memory;
                  }
                } catch (e) {}
                done(res.instance, res.module);
              });
            });
        }

        // 走 Promise 版本，避免同步阻塞主线程太久（22MB 编译约 1~3s）
        WebAssembly.instantiate(buf, imports)
          .then(afterInstantiate)
          .catch(function (e) {
            console.error('[wx-loader] wasm 实例化失败:', e);
            // 交给 framework 的失败通道
            try {
              Module.onAbort && Module.onAbort(e);
            } catch (_) {}
          });

        return {};   // Emscripten 约定：返回非空对象表示已接管异步实例化
      };
      log('已安装 Module.instantiateWasm（wasm-split imports 补齐器）');
    };
  }

  // ---------------------------------------------------------------------
  // 5. 启动
  // ---------------------------------------------------------------------
  var started = false;

  // 调试用：?plugindebug 时加载带插桩的插件副本（lib/plugin-debug.js）
  var PLUGIN_URL = (location.search.indexOf('plugindebug') >= 0)
    ? 'lib/plugin-debug.js'
    : 'lib/plugin.js';

  function boot(opts) {
    if (started) return;
    started = true;
    opts = opts || {};

    installWasmSplitBypass();

    // 先把 data / wasm 灌进虚拟文件系统，让插件走「缓存命中」的短路径，
    // 避免它去联网下载（离线环境必然失败，且会触发一堆重试/校验失败）。
    var preload = Promise.resolve();
    if (window.__wxShim && window.__wxShim.preloadIntoFS) {
      preload = new Promise(function (resolve) {
        try {
          window.__wxShim.preloadIntoFS(resolve);
        } catch (e) {
          console.warn('[wx-loader] 预置资源异常', e);
          resolve();
        }
      });
    }

    log('加载微信 Unity 适配插件 …', PLUGIN_URL);
    preload
      .then(function () { return loadScript(PLUGIN_URL); })
      .then(function () {
        log('加载游戏主 bundle …');
        return loadPatchedScript('lib/game.js');
      })
      .then(function () {
        log('注册模块数 =', Object.keys(defs).length); console.log('[DBG] defs===window.__wxLoader.defs ?', defs === window.__wxLoader.defs, 'keys', Object.keys(defs).length, 'defineIsOurs', /deps/.test(String(window.define)));
        // game.js 尾部自带 require("game.js")，但为了确保执行顺序与可观测性，
        // 这里显式再 require 一次（缓存命中时是幂等的）。
        var req = makeRequire('');
        try {
          req('game.js');
        } catch (e) {
          console.error('[wx-loader] 启动失败:', e);
          if (window.__wxShim && window.__wxShim.hideAdOverlay) window.__wxShim.hideAdOverlay();
          var el = document.getElementById('fatal-error');
          if (el) {
            el.style.display = 'block';
            el.textContent = '启动失败：' + (e && e.message ? e.message : e) + '\n\n按 F12 查看完整堆栈。';
          }
          window.__dead = true;
        }
      })
      .catch(function (e) {
        console.error('[wx-loader] 脚本加载失败:', e);
        var el = document.getElementById('fatal-error');
        if (el) { el.style.display = 'block'; el.textContent = '资源加载失败：' + e.message + '\n\n请确认通过 http(s) 访问，不要直接双击 index.html。'; }
      });
  }

  window.__wxBoot = boot;

  // 暴露给外部排查
  window.__wxLoader = {
    defs: defs,
    cache: cache,
    require: function (n) { return makeRequire('')(n); },
    resolve: resolve
  };
})();
