/**
 * web/autoplay/diagnostics.js
 *
 * 诊断层：环形缓冲记录「动作 → 观测 → 结果」，供 F9 / 控制台导出。
 * 原则：记录但不改变游戏行为；任何异常都不能中断自动玩主循环。
 */
(function () {
  'use strict';

  var MAX = 600;
  var ring = [];
  var seq = 0;

  function push(kind, data) {
    try {
      ring.push({ i: ++seq, t: Math.round(performance.now()), kind: kind, data: data });
      if (ring.length > MAX) ring.shift();
    } catch (e) { /* ignore */ }
  }

  var Diag = {
    push: push,

    action: function (action, obs) {
      push('action', {
        type: action.type,
        reason: action.reason,
        target: action.target || null,
        scene: obs && obs.scene,
        targetCount: obs && obs.metrics && obs.metrics.targetCount,
        avgLuma: obs && obs.metrics && obs.metrics.avgLuma,
        changeRate: obs && obs.metrics && obs.metrics.changeRate
      });
    },

    result: function (action, ok, detail) {
      push('result', { type: action && action.type, ok: ok, detail: detail || null });
    },

    state: function (from, to) {
      push('state', { from: from, to: to });
    },

    error: function (where, err) {
      push('error', { where: where, message: String(err && err.message ? err.message : err).slice(0, 300) });
    },

    /** 导出为可直接粘贴的文本 */
    dump: function (limit) {
      var n = limit || 120;
      return ring.slice(-n).map(function (r) {
        return '[' + r.t + 'ms] #' + r.i + ' ' + r.kind + ' ' + JSON.stringify(r.data);
      }).join('\n');
    },

    recent: function (n) { return ring.slice(-(n || 20)); },

    clear: function () { ring.length = 0; seq = 0; }
  };

  // 控制台快捷入口
  window.__autoplayDiag = Diag;
  window.AutoplayDiag = Diag;
})();
