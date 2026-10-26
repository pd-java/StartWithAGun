/**
 * web/autoplay/input-adapter.js
 *
 * 输入适配层：把「归一化坐标 + 动作」翻译成游戏真正能收到的触摸事件。
 *
 * 为什么不用 dispatchEvent(new MouseEvent(...))：
 *   weapp-adapter 会把 canvas 原型链上的 addEventListener / dispatchEvent
 *   替换成基于 WeakMap 的假实现，页面内派发的 DOM 事件不会进入 wx-shim 的
 *   监听器，反而会打给游戏自己的 'mousedown' 监听器，触发
 *   `removeEventListener` 里 r.get(this) 为 undefined 的崩溃（已实测复现）。
 *   因此统一走 wx-shim 暴露的 __wxInjectTouch，它的数据结构和真实玩家
 *   输入完全一致。
 *
 * 坐标约定：全部使用「画布归一化坐标」(0..1)，避免 DPR / 窗口缩放带来的偏差。
 */
(function () {
  'use strict';

  var pressed = false;
  var pressAt = null;
  var token = 0;

  function injector() {
    var f = window.__wxInjectTouch;
    if (typeof f !== 'function') throw new Error('INPUT_UNAVAILABLE: __wxInjectTouch 未就绪');
    return f;
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  var Input = {
    /** 当前是否处于按下状态（用于诊断与紧急释放） */
    isPressed: function () { return pressed; },

    /** 让所有「进行中的输入」失效（暂停/停止/重置时调用） */
    invalidate: function () {
      token++;
      return token;
    },

    currentToken: function () { return token; },

    moveTo: function (nx, ny) {
      // 只有按下状态才需要投递 move，否则游戏侧不会处理
      if (!pressed) return false;
      injector()('move', clamp01(nx), clamp01(ny));
      return true;
    },

    press: function (nx, ny) {
      injector()('start', clamp01(nx), clamp01(ny));
      pressed = true;
      pressAt = { x: clamp01(nx), y: clamp01(ny), t: performance.now() };
      return true;
    },

    release: function (nx, ny) {
      if (!pressed) return false;
      var p = pressAt || { x: nx, y: ny };
      injector()('end', clamp01(typeof nx === 'number' ? nx : p.x), clamp01(typeof ny === 'number' ? ny : p.y));
      pressed = false;
      pressAt = null;
      return true;
    },

    /** 点击：按下 → 保持 holdMs → 抬起 */
    click: function (nx, ny, holdMs) {
      var t = token;
      this.press(nx, ny);
      return sleep(holdMs == null ? 60 : holdMs).then(function () {
        if (t !== token) { Input.releaseAll(); return false; }  // 期间被取消
        Input.release(nx, ny);
        return true;
      });
    },

    /** 拖动：按下 → 若干中间点 → 抬起 */
    drag: function (x1, y1, x2, y2, durationMs, steps) {
      var t = token;
      var n = steps || 8;
      var dur = durationMs || 300;
      this.press(x1, y1);
      var i = 1;
      function next() {
        if (t !== token) { Input.releaseAll(); return Promise.resolve(false); }
        if (i > n) { Input.release(x2, y2); return Promise.resolve(true); }
        var k = i / n;
        Input.moveTo(x1 + (x2 - x1) * k, y1 + (y2 - y1) * k);
        i++;
        return sleep(dur / n).then(next);
      }
      return sleep(dur / n).then(next);
    },

    /** 紧急释放：任何异常路径都必须调用，避免鼠标一直处于按下状态 */
    releaseAll: function () {
      if (!pressed) return;
      var p = pressAt || { x: 0.5, y: 0.5 };
      try { injector()('end', p.x, p.y); } catch (e) { /* shim 尚未就绪时忽略 */ }
      pressed = false;
      pressAt = null;
    },

    /** 诊断用：handler 注册数量，0 表示游戏还没挂上触摸监听 */
    handlerCount: function () {
      return window.__wxTouchHandlerCount ? window.__wxTouchHandlerCount() : null;
    }
  };

  // 页面卸载 / 失焦时兜底释放
  window.addEventListener('pagehide', function () { Input.releaseAll(); });
  window.addEventListener('blur', function () { Input.releaseAll(); });

  window.AutoplayInput = Input;
})();
