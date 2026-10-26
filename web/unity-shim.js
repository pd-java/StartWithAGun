/*
 * unity-shim.js —— 把微信 xR 运行时「骗」进标准 Unity WebGL 通道
 * ---------------------------------------------------------------
 * 原版流程：plugin（UnityPlugin）创建 Module，调用 C.UnityModule(Module)
 *           （即 webgl.wasm.framework.unityweb.js 导出的函数），
 *           由该函数内部处理 wasm / data 的加载。
 *
 * 本移植：Module 上挂的加载钩子（见 unity-data-hook.js）已经就绪，
 *         Unity 只要按标准 WebGL 方式运行即可。
 *
 * 这里额外做的事：
 *   1. 拦截 plugin 传给 UnityModule 的 Module，装上钩子。
 *   2. 把 Module.isRunInBrowser 之类的「微信专有」字段调整为浏览器行为。
 *   3. 修正 canvas 尺寸（Unity 会读 canvas.width/height 作为后备缓冲大小）。
 */
(function () {
  'use strict';

  var V = (location.search.indexOf('verbose') >= 0) || localStorage.getItem('wxshim.verbose') === '1';
  function log() {
    if (!V) return;
    console.log.apply(console, ['%c[unity-shim]', 'color:#722ed1;font-weight:bold'].concat(Array.prototype.slice.call(arguments)));
  }

  var G = window.GameGlobal || (window.GameGlobal = {});

  // ---------------------------------------------------------------------
  // 给 Canvas 补齐 Unity / wx 双方都满意的方法
  // ---------------------------------------------------------------------
  function patchCanvas(canvas) {
    if (!canvas || canvas.__patched) return canvas;
    canvas.__patched = true;

    if (!canvas.toTempFilePath) {
      canvas.toTempFilePath = function (opts) {
        try {
          var url = canvas.toDataURL(opts && opts.fileType === 'jpg' ? 'image/jpeg' : 'image/png',
            (opts && opts.quality) || 0.92);
          if (opts && opts.success) opts.success({ errMsg: 'toTempFilePath:ok', tempFilePath: url });
          if (opts && opts.complete) opts.complete({});
        } catch (e) {
          if (opts && opts.fail) opts.fail({ errMsg: 'toTempFilePath:fail ' + e.message });
        }
      };
    }
    if (!canvas.toTempFilePathSync) {
      canvas.toTempFilePathSync = function (opts) {
        return canvas.toDataURL(opts && opts.fileType === 'jpg' ? 'image/jpeg' : 'image/png');
      };
    }
    if (!canvas.requestAnimationFrame) {
      canvas.requestAnimationFrame = window.requestAnimationFrame.bind(window);
      canvas.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
    }
    // 微信 canvas 有 getBoundingClientRect（weapp-adapter 已补，这里兜底）
    if (!canvas.getBoundingClientRect || canvas.getBoundingClientRect().width === 0) {
      var orig = canvas.getBoundingClientRect ? canvas.getBoundingClientRect.bind(canvas) : null;
      canvas.getBoundingClientRect = function () {
        var r = orig ? orig() : null;
        if (r && r.width > 0) return r;
        var b = canvas.style.left ? {
          left: parseFloat(canvas.style.left) || 0,
          top: parseFloat(canvas.style.top) || 0,
          width: parseFloat(canvas.style.width) || canvas.width,
          height: parseFloat(canvas.style.height) || canvas.height
        } : { left: 0, top: 0, width: canvas.width, height: canvas.height };
        return { left: b.left, top: b.top, right: b.left + b.width, bottom: b.top + b.height,
          width: b.width, height: b.height, x: b.left, y: b.top };
      };
    }
    return canvas;
  }

  // ---------------------------------------------------------------------
  // 包装 plugin 的 UnityModule 入口
  // ---------------------------------------------------------------------
  var origUnityModule = null;

  /**
   * 把 GameGlobal 上的关键对象同步到真实 window。
   *
   * 为什么必须做？
   *   Unity 的 framework（webgl.wasm.framework.unityweb.js）里 import 表是这么写的：
   *       JS_MobileKeybard_GetIgnoreBlurEvent: window.WXWASMSDK._JS_MobileKeybard_...
   *   它读的是【window.WXWASMSDK】，而不是 GameGlobal.WXWASMSDK。
   *
   *   真实微信小游戏里 window === GameGlobal（同一个全局对象），所以没问题；
   *   而浏览器里我们只能把 WXWASMSDK 挂在 GameGlobal 上（由 game.js 赋值），
   *   于是 window.WXWASMSDK 是 undefined → 读属性直接 TypeError。
   *
   *   这些字段都是 Unity/插件运行时自己创建的，同步到 window 不会污染宿主。
   */
  var SYNC_KEYS = [
    'WXWASMSDK', 'unityNamespace', 'Module', 'manager', 'wx', 'UnityLoader',
    'WASM_SPLIT_SUB_VERSION', 'WASM_SPLIT_API_VERSION', 'WASM_SPLIT_PLUGIN_VERSION',
    'useWasmCodeSplit', 'wasm_split_info', 'isIOSHighPerformanceMode',
    'isIOSHighPerformanceModePlus', 'canUseH5Renderer', 'canUseiOSAutoGC'
  ];

  function syncGameGlobalToWindow() {
    for (var i = 0; i < SYNC_KEYS.length; i++) {
      var k = SYNC_KEYS[i];
      var v = G[k];
      if (v === undefined) continue;
      if (window[k] === v) continue;
      try {
        // 不要覆盖 window 上已经存在的、可写的同名属性；只补缺失的
        var d = Object.getOwnPropertyDescriptor(window, k);
        if (!d) {
          Object.defineProperty(window, k, { value: v, writable: true, configurable: true, enumerable: false });
        } else if (d.configurable && d.writable !== false) {
          window[k] = v;
        }
      } catch (e) { /* 不可覆盖就跳过 */ }
    }
    ensureUnityLoader();
    patchUnityNamespaceRAF();
    patchBrowserMainLoop();
  }

  /**
   * 补 window.UnityLoader。
   *
   * framework 里有一批 JS_ 桥接函数是【裸引用】全局 UnityLoader 的：
   *     JS_SystemInfo_HasWebGL: function () { return UnityLoader.SystemInfo.hasWebGL; }
   *     JS_SystemInfo_IsMobile: function () { return UnityLoader.SystemInfo.mobile; }
   *
   * 微信小游戏里 window === GameGlobal，而插件的 initGameGlobal() 里写着
   *     C.UnityLoader = { SystemInfo: { width, height, gpu(), browser:'wx',
   *                                     language, hasWebGL }, UnityCache: {...} }
   * 也就是说它挂在 GameGlobal 上、同时因为是同一个全局对象所以 window 上也有。
   *
   * 浏览器里我们只能把 C 放在 GameGlobal，于是裸引用 UnityLoader 会
   * ReferenceError（这个错误发生在 main() 里，会让整个引擎初始化中断）。
   * 这里补一个兜底对象：如果插件已经写好就用它的，否则用我们自己的。
   */
  function ensureUnityLoader() {
    var existing = G.UnityLoader;
    if (existing && existing.SystemInfo) {
      if (window.UnityLoader !== existing) {
        try { window.UnityLoader = existing; } catch (e) {}
      }
      /*
       * ★ 修正插件的 hasWebGL 值 —— 这是 graphicsShaderLevel=30 的根因！
       *
       * 插件源码（lib/plugin.js）里写的是：
       *     hasWebGL: this.contextType
       * 其中 contextType 是枚举：
       *     rt.WebGL=1, rt.WebGL2=2, rt.WXWebGL=3, rt.WXWebGL2=4, rt.WXMetal=5
       * 也就是说 hasWebGL 不是 boolean，而是 1~5 的数字。
       *
       * 这个值会经 JS_SystemInfo_HasWebGL() 传给 wasm：
       *     JS_SystemInfo_HasWebGL: function(){ return UnityLoader.SystemInfo.hasWebGL }
       * Unity wasm 里对它的语义是「WebGL 版本」：
       *     1 = WebGL1 → graphicsShaderLevel = 30（GLES2）
       *     2 = WebGL2 → graphicsShaderLevel = 35（GLES3）
       * 微信真机上没问题的原因：微信侧插件对 iOS/Android 分别有适配，
       * 且 wx 环境里 contextType 与真机能力一致。
       *
       * 在浏览器里，如果 contextType 被判定成 1（WebGL，默认值！见
       * 插件 contextType() 函数：void 0===n ? rt.WebGL : n），
       * Unity 就会按 WebGL1 / GLES2 处理 —— 这正是
       *     graphicsShaderLevel (current/required) = 30 / 35
       *     shader is not supported on this GPU
       * 的根本原因：游戏要求 35（GLES3），而我们报告的是 30。
       *
       * 修法：检测浏览器真实能力（webgl2 context 可创建），
       * 强制把 hasWebGL 报成 2（WebGL2）。
       */
      try {
        var si = existing.SystemInfo;
        var reportedIsWebGL1 = si.hasWebGL === 1 || si.hasWebGL === true;
        // ⚠️ 探测必须只做一次并缓存：
        //    ensureUnityLoader 会被 syncGameGlobalToWindow 反复调用（每帧级频率），
        //    每次 new canvas + getContext('webgl2') 都会占一个 WebGL 上下文，
        //    很快触发「Too many active WebGL contexts」把主上下文挤掉 → 黑屏。
        if (window.__webgl2Support === undefined) {
          try {
            var t = document.createElement('canvas');
            var g = t.getContext('webgl2');
            window.__webgl2Support = !!g;
            // 立刻释放：避免长期占用上下文槽位
            try {
              var lose = g && g.getExtension('WEBGL_lose_context');
              if (lose) lose.loseContext();
            } catch (e0) {}
            t = null; g = null;
          } catch (e1) {
            window.__webgl2Support = false;
          }
        }
        var webgl2Works = window.__webgl2Support;
        if (reportedIsWebGL1 && webgl2Works) {
          log('修正 UnityLoader.SystemInfo.hasWebGL：' + si.hasWebGL + ' -> 2 (WebGL2)');
          try {
            Object.defineProperty(si, 'hasWebGL', { value: 2, writable: true, configurable: true, enumerable: true });
          } catch (e2) { si.hasWebGL = 2; }
        }
      } catch (e) { /* 忽略 */ }
      return;
    }
    // 兜底：插件还没注入时的最小可用实现
    if (window.UnityLoader && window.UnityLoader.SystemInfo) return;
    var vp = (window.__wxShim && window.__wxShim.viewport) ? window.__wxShim.viewport() : { width: 480, height: 854 };
    var fallback = {
      SystemInfo: {
        width: vp.width,
        height: vp.height,
        mobile: true,
        browser: 'wx',
        browserVersion: '0.0',
        language: 'zh-CN',
        hasWebGL: true,
        gpu: function () { return 'unknown'; }
      },
      UnityCache: {}
    };
    try {
      G.UnityLoader = fallback;
      window.UnityLoader = fallback;
    } catch (e) { /* ignore */ }
  }

  /**
   * 补 unityNamespace.requestAnimationFrame / cancelAnimationFrame。
   *
   * 为什么必须补（这是个很隐蔽的坑）：
   *   framework 里的主循环调度函数是
   *       function n4(i, n) {                 // resumeMainLoop(timingMode, timingValue)
   *         ...
   *         else if (1 == i)
   *           wx.setPreferredFramesPerSecond(60 / n),
   *           n9.mainLoop.scheduler = function () {
   *             n9.requestAnimationFrame(n9.mainLoop.runner)   // ← 注意是 n9. 不是 wx.
   *           },
   *           n9.mainLoop.method = "rAF";
   *       }
   *   而 n9 === GameGlobal.unityNamespace。
   *
   *   真实微信小游戏里 unityNamespace.requestAnimationFrame 是由插件在
   *   initGameGlobal 阶段挂上去的（转发到 wx.requestAnimationFrame）；
   *   在我们这层复刻里没人挂它，于是：
   *     · n4(1, …) 在给 scheduler 赋值【之前】就抛 TypeError
   *       （不能给 undefined 赋属性？不 —— 赋属性本身不抛，
   *         抛的是后面 resume() 直接调用 mainLoop.scheduler()）
   *     · scheduler 永远是 null
   *     · resume() → mainLoop.scheduler() → TypeError:
   *         n9.mainLoop.scheduler is not a function
   *   游戏画面因此永远停在首帧黑屏。
   *
   *   所以这里给 unityNamespace 补上这两个方法（转发到宿主 raf）。
   */
  function patchUnityNamespaceRAF() {
    var ns = G.unityNamespace;
    if (!ns) return;
    if (typeof ns.requestAnimationFrame !== 'function') {
      ns.requestAnimationFrame = function (cb) {
        return (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(cb);
      };
    }
    if (typeof ns.cancelAnimationFrame !== 'function') {
      ns.cancelAnimationFrame = function (id) {
        return (window.cancelAnimationFrame || clearTimeout)(id);
      };
    }
  }

  /**
   * 给 Browser.mainLoop 打补丁，让 resume() 在主循环函数缺失时不再崩。
   *
   * ── 问题 ────────────────────────────────────────────────────────
   * framework 的 Browser.mainLoop.resume 是这样写的（lib/game.js）：
   *
   *     resume: function () {
   *       n9.mainLoop.currentlyRunningMainloop++;
   *       var i = n9.mainLoop.timingMode, n = n9.mainLoop.timingValue;
   *       var e = n9.mainLoop.func;          // ← 此时可能是 null
   *       n9.mainLoop.func = null;
   *       n6(e, 0, false, n9.mainLoop.arg, true);   // func = e (null)
   *       n4(i, n);                                  // if (!func) return 1
   *       n9.mainLoop.scheduler();                   // ← undefined → TypeError
   *     }
   *
   * 而 n4() 开头有 `if (!n9.mainLoop.func) return 1;`，
   * 根本不会去创建 scheduler，于是下一行直接
   *     TypeError: n9.mainLoop.scheduler is not a function
   * 这个异常从 plugin 的 calledMainCb 抛出，会打断 main() 之后的整条启动链，
   * 画面永久黑屏。
   *
   * ── 为什么 func 会是 null ────────────────────────────────────────
   * Unity 在 main() 里通过 emscripten_set_main_loop / _arg 注册帧回调。
   * 但我们这条路（自已接管 instantiateWasm）里 set_main_loop 的调用时机
   * 与 plugin 的 calledMainCb 调用 resume() 的时机可能错位：
   * 一旦 resume() 早于注册、或 main() 中途抛异常导致注册没走到，
   * func 就是 null。
   *
   * ── 修法 ────────────────────────────────────────────────────────
   * 不去猜引擎内部状态，直接给 mainLoop 一个「兜底帧回调」：
   *   · 若 resume() 时 func 为 null，保留 n6 的语义（它只是登记 func），
   *     我们提前把 func 设成一个空函数，让 n4 能正常建立 scheduler 与 runner；
   *   · runner 每帧调 func（空函数，无副作用），scheduler 正常循环；
   *   · 真正注册了帧回调后（set_main_loop 被 wasm 调到），
   *     n6 会把 func 覆盖成真实回调，一切照常。
   * 这样既不会让 resume 崩，也不会伪造渲染逻辑。
   */
  function patchBrowserMainLoop() {
    var ns = G.unityNamespace;
    if (!ns) return;
    if (ns.__mainLoopPatchInstalled) return;
    ns.__mainLoopPatchInstalled = true;
    // Browser 是 framework 在 UnityModule 内部创建的，可能晚于这里，
    // 所以用属性拦截兜住赋值。
    var installed = false;

    function tryInstall() {
      if (installed) return true;
      var Browser = ns.Browser;
      var ml = Browser && Browser.mainLoop;
      if (!ml || typeof ml.resume !== 'function') return false;
      if (ml.__resumePatched) { installed = true; return true; }
      installed = true;
      ml.__resumePatched = true;

      var origResume = ml.resume;
      ml.resume = function () {
        try {
          if (!ml.func) {
            log('resume() 时 mainLoop.func 为空 —— 装入兜底帧回调，避免 scheduler 未定义');
            ml.func = function () { /* 真实帧回调注册后会被覆盖 */ };
          }
        } catch (e) { /* 忽略 */ }
        var r = origResume.apply(this, arguments);

        // ── 给 runner 加一层帧追踪 ──────────────────────────────────
        // n6() 里会重建 runner，所以 resume 之后（runner 已就绪）
        // 立刻包一层，记录「第几帧、调的是哪个 func、有没有抛异常」。
        try {
          if (typeof ml.runner === 'function' && !ml.runner.__traced) {
            var origRunner = ml.runner;
            ml.runner.__traced = true;
            window.__frameNo = 0;
            ml.runner = function () {
              window.__frameNo = (window.__frameNo || 0) + 1;
              var fn = ml.func;
              var isReal = fn && fn !== ml.__fallbackFunc && fn.length >= 0 &&
                           String(fn).indexOf('真实帧回调注册后会被覆盖') < 0;
              try {
                return origRunner.apply(this, arguments);
              } catch (e) {
                console.error('[unity-shim] 帧 ' + window.__frameNo + ' 抛出：' +
                  (e && (e.message || String(e))) + ' | func=' +
                  (fn ? String(fn).slice(0, 80).replace(/\n/g, ' ') : 'null'));
                console.error('[unity-shim] 堆栈:', e && e.stack ? e.stack.slice(0, 1500) : '(无)');
                /* ── 崩溃现场内存取证 ────────────────────────────────────
                 * 越界无法从 JS 侧拿到「哪个地址越界」，但能拿到：
                 *   · wasm memory 当前大小（是否已接近上限 / 是否曾 grow 失败）
                 *   · 崩溃前 env 调用轨迹的完整尾部 → 定位最后一个外部输入
                 *   · GL 侧状态（是否上下文丢失 → 所有资源句柄失效）
                 */
                try {
                  var mem = null;
                  try {
                    var M = G.Module || (G.manager && G.manager.gameInstance && G.manager.gameInstance.Module);
                    mem = M && M.asm && M.asm.memory;
                  } catch (_) {}
                  console.error('[unity-shim][forensics] memory =',
                    mem ? (mem.buffer.byteLength + ' bytes (' + (mem.buffer.byteLength / 1048576).toFixed(1) + ' MB)') : 'unavailable');
                  try {
                    var glctx = G.canvas && (G.canvas.getContext('webgl2') || G.canvas.getContext('webgl'));
                    console.error('[unity-shim][forensics] GL.contextLost =',
                      glctx ? glctx.isContextLost() : 'no ctx');
                  } catch (_) {}
                  var ring = window.__envTrace || [];
                  console.error('[unity-shim][forensics] 最后 30 次 env 调用: ' +
                    ring.slice(-30).join(' | '));
                  // ── wasm-split 栈指针一致性检查 ──
                  // 主包与 wasmcode1 共享 primary.* 三个栈全局。
                  // 若 initGlobal 没有正确落地，第二包的栈帧会分配到非法区域。
                  try {
                    var sp = (window.GameGlobal && window.GameGlobal.wasm_split_info &&
                              window.GameGlobal.wasm_split_info.primary) || null;
                    if (sp) {
                      var g = function (n) { return sp[n] ? sp[n].value : 'n/a'; };
                      console.error('[unity-shim][forensics] stack: sp=' + g('__stack_pointer') +
                        ' end=' + g('__stack_end') + ' base=' + g('__stack_base'));
                    }
                  } catch (_) {}
                  // ── 异常链配平检查 ──
                  try {
                    var es = window.__excStats;
                    if (es) {
                      console.error('[unity-shim][forensics] 异常链: throw=' + es.throw +
                        ' beginCatch=' + es.beginCatch + ' endCatch=' + es.endCatch +
                        ' rethrow=' + es.rethrow + ' findCatch=' + es.findCatch +
                        ' resume=' + es.resume + ' alloc=' + es.alloc + ' free=' + es.free);
                      console.error('[unity-shim][forensics] 最后一次 throw 在帧号: ' + es.throwAtFrame);
                    }
                  } catch (_) {}
                  // 栈指针越界判定：sp 必须落在 [base, end) 内
                } catch (_) {}
                // ── 静态链逐级 dump：确定 14903 崩溃链断在哪一级 ──
                try {
                  if (mem) {
                    var dv = new DataView(mem.buffer);
                    var u32 = function (a) { return a > 0 && a < dv.byteLength - 4 ? dv.getUint32(a, true) : -1; };
                    var a1 = u32(5541828);                    // 4840 传入的静态槽
                    var b1 = a1 > 0 ? u32(a1 + 16) : -1;      // 14861: [arg2+16]
                    var c1 = b1 > 0 ? u32(b1 + 96) : -1;      // [v+96]
                    var d1 = c1 > 0 ? u32(c1 + 56) : -1;      // [w+56]
                    var e1 = d1 > 0 ? u32(d1 + 120) : -1;     // [x+120] -> 14903 的 arg2
                    var f1 = e1 > 0 ? u32(e1 + 16) : -1;      // 14903: [arg2+16] ★崩溃基址
                    console.error('[forensics] 静态链: s[5541828]=0x' + (a1 >>> 0).toString(16) +
                      ' [+16]=0x' + (b1 >>> 0).toString(16) +
                      ' [+96]=0x' + (c1 >>> 0).toString(16) +
                      ' [+56]=0x' + (d1 >>> 0).toString(16) +
                      ' [+120]=0x' + (e1 >>> 0).toString(16) +
                      ' [+16]=0x' + (f1 >>> 0).toString(16) +
                      '  (memory 上界 0x' + dv.byteLength.toString(16) + ')');
                    // il2cpp: klass 的 name(+8) / namespace(+12) 是 char*
                    function cstr(a) {
                      if (a <= 0 || a >= dv.byteLength) return '?';
                      var s = '';
                      for (var i = 0; i < 96; i++) {
                        var ch = dv.getUint8(a + i);
                        if (!ch) break;
                        s += String.fromCharCode(ch);
                      }
                      return s;
                    }
                    // 链上每个非零指针都尝试按 klass 解析出类名
                    [[a1, 's[5541828]'], [b1, '[+16]']].forEach(function (pr) {
                      var p = pr[0];
                      if (p > 0 && p < dv.byteLength - 16) {
                        console.error('[forensics] il2cpp 类名(' + pr[1] + ' @0x' + (p >>> 0).toString(16) + '): ' +
                          cstr(u32(p + 12)) + '.' + cstr(u32(p + 8)));
                      }
                    });
                    // dump klass 内存区，确定 +96 的语义
                    try {
                      if (b1 > 0 && b1 < dv.byteLength - 176) {
                        var lines = [];
                        for (var off = 0; off < 160; off += 16) {
                          var row = '';
                          for (var j = 0; j < 16; j++) {
                            var vv = dv.getUint32(b1 + off + j * 4, true);
                            row += ('00000000' + (vv >>> 0).toString(16)).slice(-8) + ' ';
                          }
                          lines.push('  +' + off + ': ' + row);
                        }
                        console.error('[forensics] klass@0x' + (b1 >>> 0).toString(16) + ' 内存:\n' + lines.join('\n'));
                      }
                    } catch (_) {}
                    // b1/a1 是托管对象：[obj+0]=klass，klass+8=name
                    try {
                      var kb = b1 > 0 ? u32(b1) : -1;
                      var ka = a1 > 0 ? u32(a1) : -1;
                      console.error('[forensics] a1 是对象, 类名=' + (ka > 0 ? (cstr(u32(ka + 12)) + '.' + cstr(u32(ka + 8))) : '?') +
                        '  b1 是对象, 类名=' + (kb > 0 ? (cstr(u32(kb + 12)) + '.' + cstr(u32(kb + 8))) : '?'));
                      // b1 各字段里非零的引用
                      if (b1 > 0 && b1 < dv.byteLength - 160) {
                        var flds = [];
                        for (var fo = 8; fo < 152; fo += 4) {
                          var fv = dv.getUint32(b1 + fo, true);
                          if (fv > 0x1000 && fv < 0x20000000) flds.push('+' + fo + '=0x' + fv.toString(16));
                        }
                        console.error('[forensics] b1 非零字段: ' + (flds.join(' ') || '(无)'));
                      }
                    } catch (_) {}
                    [5499224, 5499688, 5518280, 5508864, 5493688, 5494344, 5513220, 5514788].forEach(function (addr) {
                      var q = u32(addr);
                      if (q > 0 && q < dv.byteLength - 100) {
                        var v96 = u32(q + 96);
                        console.error('[forensics] 槽 ' + addr + ' -> 0x' + (q >>> 0).toString(16) +
                          ' 类名=' + cstr(u32(q + 12)) + '.' + cstr(u32(q + 8)) +
                          ' [+96]=' + (v96 === 0 ? '★NULL' : '0x' + (v96 >>> 0).toString(16)));
                      } else {
                        console.error('[forensics] 槽 ' + addr + ' = ' + (q === -1 ? '越界' : '0x' + (q >>> 0).toString(16)));
                      }
                    });
                  }
                } catch (_) {}
                /* ── 崩溃续跑策略 ─────────────────────────────────────
                 * 实测：崩溃发生在首帧游戏逻辑回调（GravityEngine 初始化链），
                 * 而渲染管线本身是好的（main() 里开场画面已画出）。
                 * 越界异常从 JS 侧无法修复，但可以直接吞掉：
                 *   · 该帧剩余逻辑被中断（异常已把 wasm 栈展开）
                 *   · 手动重新调度下一帧，主循环得以继续
                 * 限定次数，避免无限崩溃循环。
                 */
                window.__frameCrashes = (window.__frameCrashes || 0) + 1;
                if (window.__frameCrashes <= 5) {
                  console.warn('[unity-shim] 已吞掉帧异常（第 ' + window.__frameCrashes + ' 次），续跑主循环');
                  setTimeout(function () {
                    try { if (typeof ml.scheduler === 'function') ml.scheduler(); } catch (_) {}
                  }, 0);
                  return;   // 不 rethrow → 页面不再弹致命错误
                }
                throw e;
              }
            };
            log('已给 mainLoop.runner 装上帧追踪');
          }
        } catch (e) { /* 忽略 */ }

        // resume 之后若 scheduler 仍缺失（极端情况），补一个 raf 驱动
        if (typeof ml.scheduler !== 'function' && typeof ml.runner === 'function') {
          ml.scheduler = function () {
            if (typeof ml.timingMode === 'number' && ml.timingMode === 1) {
              (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(ml.runner);
            } else {
              setTimeout(ml.runner, 0);
            }
          };
          log('resume() 后 scheduler 缺失 —— 已补 raf 调度器');
          try { ml.scheduler(); } catch (e) { console.warn('[unity-shim] 启动 mainLoop 失败', e); }
        }
        return r;
      };
      log('已包装 Browser.mainLoop.resume');

      /* ── 帧回调探针 ────────────────────────────────────────────────
       * 目的：区分「空转帧」与「真实 Unity 帧」。
       *   · 空转帧：mainLoop.func 是我们塞的空函数（真实回调还没注册）
       *   · 真实帧：wasm 通过 emscripten_set_main_loop 注册了帧回调
       * 只有真实帧才会推进 Unity 引擎状态；如果崩在空转帧，
       * 说明问题出在 scheduler/runner 的重复泵送，而不是游戏逻辑。
       */
      try {
        var lastFunc = null;
        var probeTimer = setInterval(function () {
          var f = ml.func;
          if (f && f !== lastFunc) {
            lastFunc = f;
            window.__frameFuncRegistered = (window.__frameFuncRegistered || 0) + 1;
            log('mainLoop.func 已更新（第 ' + window.__frameFuncRegistered + ' 次），真实帧回调生效');
          }
        }, 20);
        window.__frameProbeTimer = probeTimer;
      } catch (e) { /* 忽略 */ }

      return true;
    }

    if (tryInstall()) return;
    // Browser 还没出现，挂个 setter 等它
    try {
      var _browser = undefined;
      Object.defineProperty(ns, 'Browser', {
        configurable: true,
        enumerable: true,
        get: function () { return _browser; },
        set: function (v) {
          _browser = v;
          try { tryInstall(); } catch (e) { console.warn('[unity-shim] 安装 mainLoop 补丁失败', e); }
        }
      });
    } catch (e) {
      // 已有不可配置属性，退回轮询
      var t = 0;
      var timer = setInterval(function () {
        t++;
        if (tryInstall() || t > 200) clearInterval(timer);
      }, 50);
    }
  }

  function wrapUnityModule() {
    var ns = G.unityNamespace;
    if (!ns || !ns.UnityModule || ns.UnityModule === origUnityModule) return false;
    origUnityModule = ns.UnityModule;

    var wrapped = function (Module) {
      log('UnityModule 被调用，开始安装加载钩子');
      // 关键：把 WXWASMSDK 等同步到真实 window（framework 用 window.xxx 取）
      syncGameGlobalToWindow();
      try {
        // Module.canvas 必须是真 canvas
        if (!Module.canvas) Module.canvas = G.canvas || document.getElementById('GameCanvas');
        Module.canvas = patchCanvas(Module.canvas);

        /*
         * ★ 预先建立并绑定 WebGL 上下文 —— 这一步必须发生在 UnityModule 内部
         *   任何初始化代码之前。
         *
         *   原因（Unity 2022 WebGL 的判定逻辑）：
         *     Unity 的 wasm 里 GetGraphicsCaps() 会读 Module.ctx / GL.currentContext 的
         *     能力（尤其「是不是 WebGL2RenderingContext」）来决定
         *     SystemInfo.graphicsShaderLevel。这个值只有两个可能：
         *        30 = GLES2.0 / Shader Model 3.0
         *        35 = GLES3.0 / Shader Model 3.5   ← 本游戏要求
         *     如果上下文在 UnityModule 跑起来时还不存在，Unity 就按 30 处理，
         *     于是所有要求 35 的 shader 全部被标记为
         *       "shader is not supported on this GPU"
         *     直接导致整屏黑（引擎跑得动、主循环也转，但什么都渲染不出来）。
         *
         *   我们在外层（wx-loader 的 done 之前）也建过一次，但那时 UnityModule
         *   内部的 GL 模块可能还没就绪；这里在最早的时机再补一次，双保险。
         */
        if (window.__ensureGLContextEarly) {
          try { window.__ensureGLContextEarly(Module); } catch (e) { console.warn('[unity-shim] 早期 GL 上下文建立失败', e); }
        }

        // Unity 认为自己是「浏览器」环境：这样它会用 fetch/XHR 走标准路径
        Module.isWxGame = true;          // 保留：让 plugin 的分支逻辑按微信版走
        Module.IsWxGame = true;
        Module.isRunInBrowser = true;

        // 网络请求走浏览器原生 XHR（Unity 需要 WebRequest）
        if (!Module.ENVIRONMENT_IS_WEB) Module.ENVIRONMENT_IS_WEB = true;

        // 安装数据包 / wasm 钩子
        if (window.__unityHook && window.__unityHook.install) {
          window.__unityHook.install(Module);
        }

        // 补齐 wasm-split 需要的 imports 命名空间（primary / wasm_split）。
        // 必须在 UnityModule 执行前挂好 —— framework 在它的同步初始化阶段
        // 就会走到 `if (Module.instantiateWasm) return Module.instantiateWasm(...)`。
        if (window.__installInstantiateWasmOnModule) {
          window.__installInstantiateWasmOnModule(Module);
        }
      } catch (e) {
        console.error('[unity-shim] 钩子安装失败:', e);
      }
      var ret = origUnityModule.call(this, Module);
      // 启动完成后隐藏 loading
      setTimeout(function () {
        if (window.__wxOverlay && window.__wxOverlay.hide) window.__wxOverlay.hide();
      }, 600);
      return ret;
    };
    // 保留原始引用，便于调试
    wrapped.__orig = origUnityModule;
    ns.UnityModule = wrapped;
    log('UnityModule 已包装');
    return true;
  }

  // unityNamespace 在 game.js 里创建得比较早，用轮询 + 属性拦截双保险
  var tries = 0;
  function poll() {
    syncGameGlobalToWindow();   // WXWASMSDK 由 game.js 稍后赋值，这里持续跟进
    if (wrapUnityModule()) {
      // 包装完成后仍要盯一会儿：unityNamespace / Module 都是后续才出现的
      var n = 0;
      var t = setInterval(function () {
        syncGameGlobalToWindow();
        if (++n > 40) clearInterval(t);
      }, 100);
      return;
    }
    if (++tries > 600) return; // 约 30s 后放弃
    setTimeout(poll, 50);
  }

  // ---------------------------------------------------------------------
  // 加载遮罩
  // ---------------------------------------------------------------------
  var overlay = null;
  var overlayStart = Date.now();

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.getElementById('boot-overlay');
    return overlay;
  }

  window.__wxOverlay = {
    hide: function () {
      var o = ensureOverlay();
      if (!o) return;
      window.__gameBooted = true;   // 供 wx-shim 判断「引擎已按当前尺寸初始化」
      o.style.opacity = '0';
      setTimeout(function () { o.style.display = 'none'; }, 400);
      console.log('%c[game] 启动耗时 ' + ((Date.now() - overlayStart) / 1000).toFixed(1) + 's ',
        'color:#07C160;font-weight:bold');
      var hud = document.getElementById('hud-tip');
      if (hud) { hud.style.opacity = '1'; setTimeout(function () { hud.style.opacity = '0'; }, 6000); }
    },
    setStatus: function (t) {
      var el = document.getElementById('boot-status');
      if (el) el.textContent = t;
    }
  };

  // 主循环一旦跑起来（Unity 调用 requestAnimationFrame），就算启动完成
  var rafOrig = window.__nativeRAF || window.requestAnimationFrame.bind(window);
  var rafCount = 0;
  window.requestAnimationFrame = function (cb) {
    if (++rafCount === 3) {
      // 连续 3 帧意味着 Unity 的 mainLoop 在跑
      setTimeout(function () { window.__wxOverlay && window.__wxOverlay.hide(); }, 200);
    }
    return rafOrig(cb);
  };

  poll();

  // ---------------------------------------------------------------------
  // 把 Unity 的 console 输出转成「可读」的
  // ---------------------------------------------------------------------
  var origError = console.error;
  console.error = function () {
    var args = Array.prototype.slice.call(arguments);
    origError.apply(console, args);
    // Unity 的致命错误会走这里，显示到页面上更直观
    var msg = args.map(function (a) { return (a && a.stack) ? a.stack : String(a); }).join(' ');
    if (/abort|Aborted|Cannot|undefined is not|not a function|failed to/i.test(msg)) {
      var fe = document.getElementById('fatal-error');
      if (fe && fe.style.display === 'block') {
        fe.textContent += '\n' + msg.slice(0, 800);
      }
    }
  };

  log('ready');
})();
