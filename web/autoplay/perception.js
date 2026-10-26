/**
 * web/autoplay/perception.js
 *
 * 感知层：只观测，不操作。
 *
 * ⚠️ 三个必须记住的实测结论：
 *  1. WebGL canvas 未开启 preserveDrawingBuffer，**缓冲在合成后即被清空**。
 *     因此采样必须在游戏的 rAF 回调「执行之前」读上一帧；回调之后读大概率全黑。
 *     （index.html 的 ?autotest 钩子在回调后采样，能出值是时序侥幸，不稳。）
 *  2. 本模块必须尽早安装 rAF 钩子（放在 wx-shim.js 之前），否则 Unity 可能
 *     已经持有自己的 rAF 引用，导致我们一帧都收不到。
 *  3. 采样一律在 rAF 内进行，帧外观察只能拿到上一次的缓存结果。
 *
 * 输出：{ valid, scene, targets, metrics }，targets 用画布归一化坐标(0..1)。
 */
(function () {
  'use strict';

  var GRID_W = 160;          // 采样分辨率
  var SAMPLE_EVERY = 2;      // 每 2 帧采样一次
  var HIST = 40;             // 变化率窗口
  var DARK_LUMA = 18;

  var buf = null, bufCtx = null;
  var frameNo = 0;
  var lastHash = -1;
  var changeTimes = [];
  var lastSample = null;
  var installed = false;

  var stat = { captured: 0, nonBlack: 0, pre: 0, post: 0 };

  function now() { return performance.now(); }

  function ensureBuf() {
    if (buf) return true;
    buf = document.createElement('canvas');
    bufCtx = buf.getContext('2d', { willReadFrequently: true });
    return !!(buf && bufCtx);
  }

  /** 红靶识别：颜色阈值 + 网格连通分量 */
  function detectRedTargets(data, w, h) {    var CELL = 8;
    var cols = Math.ceil(w / CELL), rows = Math.ceil(h / CELL);
    var cells = new Uint8Array(cols * rows);
    var x, y, i, r, g, b;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = (y * w + x) * 4;
        r = data[i]; g = data[i + 1]; b = data[i + 2];
        if (r > 115 && g < 80 && b < 80 && r - g > 60) {
          cells[((y / CELL) | 0) * cols + ((x / CELL) | 0)] = 1;
        }
      }
    }
    var seen = new Uint8Array(cols * rows);
    var out = [];
    for (var cy = 0; cy < rows; cy++) {
      for (var cx = 0; cx < cols; cx++) {
        var idx = cy * cols + cx;
        if (!cells[idx] || seen[idx]) continue;
        var sx = 0, sy = 0, n = 0, stack = [idx];
        seen[idx] = 1;
        while (stack.length) {
          var cur = stack.pop();
          var px = cur % cols, py = (cur / cols) | 0;
          sx += px; sy += py; n++;
          var nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
          for (var k = 0; k < 4; k++) {
            var nx = px + nb[k][0], ny = py + nb[k][1];
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            var ni = ny * cols + nx;
            if (cells[ni] && !seen[ni]) { seen[ni] = 1; stack.push(ni); }
          }
        }
        if (n >= 2) out.push({ x: (sx / n + 0.5) / cols, y: (sy / n + 0.5) / rows, size: n });
      }
    }
    out.sort(function (a, b) { return b.size - a.size; });
    return out;
  }

  /**
   * 深色目标识别：本作靶场里敌人是浅色沙地上的深色小剪影。
   * 只取画面上半部分（y 0.10~0.62），排除底部武器与中央镜筒区域。
   * 返回结构与红靶一致，额外带 kind='dark'。
   */
  function detectDarkTargets(data, w, h) {
    var CELL = 8;
    var cols = Math.ceil(w / CELL), rows = Math.ceil(h / CELL);
    var cells = new Uint8Array(cols * rows);
    var x, y, i;
    for (y = 0; y < h; y++) {
      var ny = y / h;
      if (ny < 0.10 || ny > 0.62) continue;          // 上=天空HUD，下=武器
      for (x = 0; x < w; x++) {
        i = (y * w + x) * 4;
        var lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        if (lum > 92) continue;                       // 只取深色
        var nx = x / w;
        // 排除中央瞄准镜（镜筒本身是深色大圆环）
        var dx = nx - 0.5, dy = ny - 0.42;
        if (dx * dx + dy * dy < 0.030) continue;
        cells[((y / CELL) | 0) * cols + ((x / CELL) | 0)] = 1;
      }
    }
    var seen = new Uint8Array(cols * rows);
    var out = [];
    for (var cy = 0; cy < rows; cy++) {
      for (var cx = 0; cx < cols; cx++) {
        var idx = cy * cols + cx;
        if (!cells[idx] || seen[idx]) continue;
        var sx = 0, sy = 0, n = 0, stack = [idx];
        seen[idx] = 1;
        while (stack.length) {
          var cur = stack.pop();
          var px = cur % cols, py = (cur / cols) | 0;
          sx += px; sy += py; n++;
          var nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
          for (var k = 0; k < 4; k++) {
            var qx = px + nb[k][0], qy = py + nb[k][1];
            if (qx < 0 || qy < 0 || qx >= cols || qy >= rows) continue;
            var qi = qy * cols + qx;
            if (cells[qi] && !seen[qi]) { seen[qi] = 1; stack.push(qi); }
          }
        }
        // 2~40 格：太小是噪点，太大是地面/墙体
        if (n >= 2 && n <= 40) {
          out.push({ x: (sx / n + 0.5) / cols, y: (sy / n + 0.5) / rows, size: n, kind: 'dark' });
        }
      }
    }
    out.sort(function (a, b) { return b.size - a.size; });
    return out;
  }

  /** 只采集，不落地（便于「回调前/回调后」各试一次） */
  function capture() {
    var canvas = document.querySelector('canvas');
    if (!canvas || !canvas.width || !canvas.height) return null;
    if (!ensureBuf()) return null;

    var w = GRID_W;
    var h = Math.max(1, Math.round(GRID_W * canvas.height / canvas.width));
    if (buf.width !== w || buf.height !== h) { buf.width = w; buf.height = h; }

    try { bufCtx.drawImage(canvas, 0, 0, w, h); } catch (e) { return null; }
    var data;
    try { data = bufCtx.getImageData(0, 0, w, h).data; } catch (e) { return null; }

    var sum = 0, darkPx = 0, hash = 0;
    for (var i = 0; i < data.length; i += 4) {
      var lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      sum += lum;
      if (lum < DARK_LUMA) darkPx++;
      hash = (hash * 31 + data[i] + data[i + 1] * 3 + data[i + 2] * 7) >>> 0;
    }
    var px = data.length / 4;
    stat.captured++;

    var red = detectRedTargets(data, w, h).map(function (t) { t.kind = 'red'; return t; });
    var darkTargets = detectDarkTargets(data, w, h);
    // 红靶优先（明确标记），深色目标作为补充；同类按面积降序
    var targets = red.concat(darkTargets);

    return {
      hash: hash,
      avgLuma: Math.round(sum / px),
      darkRatio: Math.round(darkPx / px * 1000) / 1000,
      targets: targets,
      redCount: red.length,
      darkCount: darkTargets.length,
      canvas: { backW: canvas.width, backH: canvas.height, cssW: canvas.clientWidth, cssH: canvas.clientHeight }
    };
  }

  function classify(s) {
    var big = (s.targets || []).filter(function (t) { return t.size >= 2 && t.y < 0.72; });
    if (big.length > 0 && s.metrics.changeRate >= 1) return 'gameplay';
    if (s.metrics.changeRate >= 8) return 'loading';
    return 'idle';
  }

  // ── 运动显著性 ────────────────────────────────────────────────
  // 靶场里的深色块绝大多数是布景（混凝土墩、帐篷、隧道口），它们连位置都不变；
  // 真正的靶子沿轨道移动，帧间位置会变。所以给每个目标打一个 staticFrames：
  // 连续多少帧在原地没动。0 表示刚出现或刚移动 → 高优先级；数值很大 → 布景，
  // 自动玩不要浪费子弹。这比单纯按面积/颜色排序可靠得多。
  var prevTargets = [];
  var STATIC_RADIUS = 0.035;

  function annotateMotion(list) {
    for (var i = 0; i < list.length; i++) {
      var t = list[i], match = null, bestD = STATIC_RADIUS;
      for (var j = 0; j < prevTargets.length; j++) {
        var p = prevTargets[j];
        if (p.kind !== t.kind) continue;
        var dx = p.x - t.x, dy = p.y - t.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestD) { bestD = d; match = p; }
      }
      if (match) {
        t.staticFrames = (match.staticFrames || 0) + 1;
        t.jitter = Math.round(bestD * 1000) / 1000;   // 仍在阈值内的微小位移
      } else {
        t.staticFrames = 0;                            // 新出现 / 大幅移动
        t.jitter = 1;
      }
    }
    prevTargets = list.map(function (t) {
      return { x: t.x, y: t.y, size: t.size, kind: t.kind, staticFrames: t.staticFrames };
    });
    return list;
  }

  /** 落地为正式观测 */
  function commit(c, source) {
    if (!c) return null;
    if (c.avgLuma >= 2) stat.nonBlack++;
    if (source === 'pre') stat.pre++; else if (source === 'post') stat.post++;

    if (c.hash !== lastHash && lastHash !== -1) {
      changeTimes.push(now());
      if (changeTimes.length > HIST) changeTimes.shift();
    }
    if (c.hash !== lastHash) lastHash = c.hash;

    annotateMotion(c.targets);

    var dynamicCount = 0;
    for (var k = 0; k < c.targets.length; k++) {
      if (c.targets[k].staticFrames < 6) dynamicCount++;
    }

    lastSample = {
      valid: true,
      ts: now(),
      seq: frameNo,
      canvas: c.canvas,
      targets: c.targets,
      metrics: {
        avgLuma: c.avgLuma,
        darkRatio: c.darkRatio,
        hash: c.hash,
        targetCount: c.targets.length,
        redCount: c.redCount || 0,
        darkCount: c.darkCount || 0,
        dynamicCount: dynamicCount,
        changeRate: changeTimes.filter(function (t) { return now() - t < 2000; }).length,
        source: source
      }
    };
    lastSample.scene = classify(lastSample);
    return lastSample;
  }

  function onFrame(cb, t) {
    // 1) 先读上一帧（缓冲尚未被本次渲染清空）
    var pre = null;
    try {
      frameNo++;
      if (frameNo % SAMPLE_EVERY === 0) pre = capture();
    } catch (e) { /* ignore */ }

    // 2) 执行游戏渲染
    var r = cb(t);

    // 3) 上一帧若是黑的（首帧/刚恢复），退而在渲染后再试一次
    var use = pre;
    if (!use || use.avgLuma < 2) {
      var post = null;
      try { post = capture(); } catch (e) { post = null; }
      if (post && post.avgLuma >= (use ? use.avgLuma : 0)) use = post;
      if (use === post) commit(use, 'post'); else commit(use, 'pre');
    } else {
      commit(use, 'pre');
    }
    return r;
  }

  function install() {
    if (installed) return;
    installed = true;
    var _raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = function (cb) {
      return _raf(function (t) {
        try { return onFrame(cb, t); } catch (e) { return cb(t); }
      });
    };
    // 兼容：Unity 有时持有 GameGlobal 上的 rAF
    try {
      if (window.GameGlobal && typeof GameGlobal.requestAnimationFrame === 'function') {
        var _graf = GameGlobal.requestAnimationFrame.bind(GameGlobal);
        GameGlobal.requestAnimationFrame = function (cb) {
          return _graf(function (t) {
            try { return onFrame(cb, t); } catch (e) { return cb(t); }
          });
        };
      }
    } catch (e) { /* ignore */ }
  }

  var Perception = {
    install: install,

    observe: function () {
      if (!lastSample) {
        var c = capture();
        if (!c) return { valid: false, reason: 'no-sample', targets: [], metrics: {} };
        commit(c, 'forced');
      }
      return lastSample;
    },

    sampleNow: function () { return commit(capture(), 'manual'); },

    waitFor: function (predicate, timeoutMs, intervalMs) {
      var t0 = now(), to = timeoutMs || 15000, iv = intervalMs || 200;
      return new Promise(function (resolve) {
        (function loop() {
          var o = Perception.observe();
          var ok = false;
          try { ok = predicate(o); } catch (e) { ok = false; }
          if (ok) return resolve(o);
          if (now() - t0 > to) return resolve(null);
          setTimeout(loop, iv);
        })();
      });
    },

    stats: function () { return { frameNo: frameNo, captured: stat.captured, nonBlack: stat.nonBlack, pre: stat.pre, post: stat.post, installed: installed }; },

    reset: function () { lastSample = null; lastHash = -1; changeTimes = []; frameNo = 0; prevTargets = []; }
  };

  install();
  window.AutoplayPerception = Perception;
})();
