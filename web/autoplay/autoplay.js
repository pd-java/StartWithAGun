/**
 * web/autoplay/autoplay.js
 *
 * 自动玩控制器：状态机 + 主循环调度 + 与感知/策略/输入/重置模块的接线。
 *
 * 设计要点（对应 ChatGPT 方案第三、六节）：
 *  - generation 代数：每次 start/pause/stop/reset 自增，异步任务在发送输入前
 *    必须校验代数，否则暂停后旧任务仍会开枪。
 *  - 暂停 ≠ 停止 ≠ 重置，三者互不替代。
 *  - 任何进入非 RUNNING 的路径都必须 releaseAllInputs()，避免鼠标卡在按下状态。
 *  - tick 只做「观测 → 决策 → 执行 → 记录」，不含业务判定。
 */
(function () {
  'use strict';

  var TRANSITIONS = {
    IDLE: ['STARTING', 'RESETTING'],
    STARTING: ['RUNNING', 'PAUSED', 'STOPPING', 'ERROR', 'IDLE'],
    RUNNING: ['PAUSED', 'STOPPING', 'RESETTING', 'COMPLETED', 'ERROR'],
    PAUSED: ['RUNNING', 'STOPPING', 'RESETTING', 'ERROR'],
    STOPPING: ['IDLE', 'ERROR'],
    RESETTING: ['IDLE', 'ERROR'],
    COMPLETED: ['STARTING', 'RESETTING'],
    ERROR: ['IDLE', 'RESETTING']
  };

  var CFG = {
    tickMs: 250,             // 主循环间隔（感知本身每帧采样，这里只做决策）
    maxConsecutiveErrors: 5,
    readyTimeoutMs: 180000,  // 首屏加载实测约 40~90s（软件渲染更慢）
    readyMinFrames: 30
  };

  var Autoplay = {
    state: 'IDLE',
    enabled: false,
    generation: 0,
    timer: null,
    lastError: null,
    consecutiveErrors: 0,
    startedAt: 0,
    lastBlock: null,
    lastGate: null,
    stats: { ticks: 0, shots: 0, taps: 0, errors: 0, blocked: 0, blockedBeyondRange: 0, firedWithoutContact: 0 },

    config: CFG,

    // ── 状态机 ────────────────────────────────────────────────
    canTransition: function (next) {
      var allowed = TRANSITIONS[this.state] || [];
      return allowed.indexOf(next) >= 0;
    },

    transition: function (next) {
      if (!this.canTransition(next)) {
        throw new Error('非法状态转换: ' + this.state + ' -> ' + next);
      }
      var prev = this.state;
      this.state = next;
      if (window.AutoplayDiag) window.AutoplayDiag.state(prev, next);
      this.emit('statechange', { previous: prev, next: next });
    },

    emit: function (name, detail) {
      try {
        window.dispatchEvent(new CustomEvent('autoplay:' + name, { detail: detail }));
      } catch (e) { /* ignore */ }
    },

    log: function () {
      var a = Array.prototype.slice.call(arguments);
      a.unshift('[autoplay]');
      console.log.apply(console, a);
    },

    // ── 生命周期 ──────────────────────────────────────────────
    start: function () {
      var self = this;
      if (self.state !== 'IDLE' && self.state !== 'COMPLETED') {
        return Promise.resolve(false);
      }
      self.enabled = true;
      self.lastError = null;
      self.consecutiveErrors = 0;
      self.startedAt = performance.now();
      self.stats = { ticks: 0, shots: 0, taps: 0, errors: 0, blocked: 0, blockedBeyondRange: 0, firedWithoutContact: 0 };
      self.lastBlock = null;
      self.lastGate = null;
      if (window.AutoplayRange) window.AutoplayRange.invalidate();
      if (window.AutoplayStrategy) window.AutoplayStrategy.reset();

      var gen = ++self.generation;
      self.transition('STARTING');

      return self.waitForGameReady(gen).then(function (ok) {
        if (!ok || gen !== self.generation || !self.enabled) return false;
        self.transition('RUNNING');
        self.schedule(gen);
        return true;
      }).catch(function (e) {
        self.fail(e);
        return false;
      });
    },

    pause: function () {
      if (this.state !== 'RUNNING') return false;
      this.enabled = false;
      this.generation++;
      this.cancelSchedule();
      this.releaseAllInputs();
      this.transition('PAUSED');
      return true;
    },

    resume: function () {
      if (this.state !== 'PAUSED') return false;
      this.enabled = true;
      var gen = ++this.generation;
      this.transition('RUNNING');
      this.schedule(gen);
      return true;
    },

    stop: function () {
      var ok = ['STARTING', 'RUNNING', 'PAUSED'].indexOf(this.state) >= 0;
      if (!ok) return false;
      this.enabled = false;
      this.generation++;
      this.cancelSchedule();
      this.releaseAllInputs();
      this.transition('STOPPING');
      this.transition('IDLE');
      return true;
    },

    resetAndRestart: function () {
      if (!['IDLE', 'PAUSED', 'RUNNING', 'COMPLETED', 'ERROR'].indexOf(this.state) >= 0) return false;
      this.enabled = false;
      this.generation++;
      this.cancelSchedule();
      this.releaseAllInputs();
      this.transition('RESETTING');
      var r = window.ProgressReset ? window.ProgressReset.resetAndRestart() : Promise.reject(new Error('ProgressReset 缺失'));
      return r.then(function (res) {
        Autoplay.log('reset', res);
        return res;
      }).catch(function (e) {
        Autoplay.fail(e);
        throw e;
      });
    },

    fail: function (err) {
      this.enabled = false;
      this.generation++;
      this.cancelSchedule();
      this.releaseAllInputs();
      this.lastError = String(err && err.message ? err.message : err);
      this.stats.errors++;
      if (window.AutoplayDiag) window.AutoplayDiag.error('controller', err);
      this.log('fatal', this.lastError);
      if (this.canTransition('ERROR')) this.transition('ERROR');
    },

    // ── 就绪检测 ──────────────────────────────────────────────
    waitForGameReady: function (gen) {
      var self = this;
      var t0 = performance.now();
      if (window.__dead) return Promise.reject(new Error('游戏启动失败(__dead)'));

      return new Promise(function (resolve) {
        (function poll() {
          if (gen !== self.generation || !self.enabled) return resolve(false);

          var c = document.querySelector('canvas');
          var handlers = window.__wxTouchHandlerCount ? window.__wxTouchHandlerCount() : null;
          var frames = window.AutoplayPerception && window.AutoplayPerception.observe().metrics.hasOwnProperty('hash')
            ? window.AutoplayPerception.observe().seq
            : 0;

          var canvasOk = !!(c && c.width > 1 && c.height > 1);
          var touchOk = !!(handlers && handlers.start > 0);
          var frameOk = frames > CFG.readyMinFrames;

          if (canvasOk && touchOk && frameOk) {
            self.log('游戏就绪', { canvas: c.width + 'x' + c.height, handlers: handlers, frames: frames });
            return resolve(true);
          }

          if (performance.now() - t0 > CFG.readyTimeoutMs) {
            return resolve(false);
          }
          setTimeout(poll, 300);
        })();
      });
    },

    // ── 主循环 ────────────────────────────────────────────────
    schedule: function (gen) {
      var self = this;
      self.cancelSchedule();
      if (!self.enabled || self.state !== 'RUNNING') return;

      self.timer = setTimeout(function () {
        self.timer = null;
        if (gen !== self.generation || !self.enabled || self.state !== 'RUNNING') return;

        self.tick(gen).catch(function (e) {
          self.consecutiveErrors++;
          self.stats.errors++;
          if (window.AutoplayDiag) window.AutoplayDiag.error('tick', e);
          if (self.consecutiveErrors >= CFG.maxConsecutiveErrors) self.fail(e);
        }).then(function () {
          if (gen === self.generation && self.enabled && self.state === 'RUNNING') {
            self.schedule(gen);
          }
        });
      }, CFG.tickMs);
    },

    tick: function (gen) {
      var self = this;
      self.stats.ticks++;

      var P = window.AutoplayPerception, S = window.AutoplayStrategy, I = window.AutoplayInput, D = window.AutoplayDiag;
      if (!P || !S || !I) throw new Error('autoplay 依赖模块缺失');

      var obs = P.observe();
      var action = S.chooseAction(obs);

      if (action.type === 'WAIT') {
        self.consecutiveErrors = 0;
        return Promise.resolve();
      }

      if (D) D.action(action, obs);

      // 输入前最后一道闸：代数 + 状态
      if (gen !== self.generation || !self.enabled || self.state !== 'RUNNING') {
        return Promise.resolve();
      }

      // click() 内部有 holdMs，期间用户可能点了「暂停」。动作一旦派发出去就无法撤回，
      // 但统计与冷却必须只记到「仍属于本次运行」的账上，否则暂停瞬间会漏 1 枪：
      // 诊断日志表现为 #169 action → #170 PAUSED → #171 result，计数在暂停后 +1。
      var alive = function () {
        return gen === self.generation && self.enabled && self.state === 'RUNNING';
      };

      // ── 射程闸门 ──────────────────────────────────────────────
      // 实测：Shoot / SimulateShot 的球扫 maxDistance 硬编码 25（世界单位）。
      // 但相机射线与武器资格门不等价（原点、半径、掩码都可能不同），
      // 所以闸门只在「确实测到碰撞且距离超出 25」时拦截；
      // 「相机射线没碰到东西」只作为诊断保留，不阻断 —— 否则会错误阻断。
      if (action.type === 'SHOOT' && window.AutoplayRange) {
        var gate = window.AutoplayRange.allowShotAt(action.target.x, action.target.y);
        self.lastGate = {
          allowed: gate.allowed,
          reason: gate.reason,
          via: gate.via || null,
          weaponRangeCheck: gate.diag ? gate.diag.weaponRangeCheck : (gate.weaponRangeCheck || 'unknown'),
          cameraRayContact: gate.diag ? gate.diag.cameraRayContact : (gate.cameraRayContact === undefined ? null : gate.cameraRayContact),
          cameraRayDistance: gate.diag ? gate.diag.cameraRayDistance : null,
          hitDistance: gate.hitDistance
        };
        if (!gate.allowed) {
          self.stats.blocked++;
          self.stats.blockedBeyondRange++;
          self.lastBlock = gate.reason;
          if (D) D.result(action, false, gate.reason);
          self.emit('blocked', { reason: gate.reason, range: window.AutoplayRange.RANGE, hitDistance: gate.hitDistance, diag: self.lastGate });
          self.consecutiveErrors = 0;
          return Promise.resolve();
        }
        if (gate.reason === 'camera-ray-no-contact') self.stats.firedWithoutContact++;
        self.lastBlock = null;
      }

      var p;
      if (action.type === 'SHOOT') {
        p = I.click(action.target.x, action.target.y, 70).then(function (done) {
          if (!done) return;
          if (!alive()) {
            if (D) D.result(action, false, 'stale-after-pause');
            return;
          }
          S.reportShot(action.target);
          self.stats.shots++;
          if (D) D.result(action, true, 'dispatched');
        });
      } else if (action.type === 'TAP') {
        p = I.click(action.x, action.y, 70).then(function (done) {
          if (!done) return;
          if (!alive()) {
            if (D) D.result(action, false, 'stale-after-pause');
            return;
          }
          S.reportTap();
          self.stats.taps++;
          if (D) D.result(action, true, 'dispatched');
        });
      } else {
        p = Promise.resolve();
      }

      return p.then(function () {
        // 输入后再次校验：暂停可能发生在 click 的 hold 期间
        if (gen !== self.generation || !self.enabled || self.state !== 'RUNNING') {
          I.releaseAll();
        }
        self.consecutiveErrors = 0;
      });
    },

    // ── 工具 ──────────────────────────────────────────────────
    cancelSchedule: function () {
      if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    },

    releaseAllInputs: function () {
      if (window.AutoplayInput) window.AutoplayInput.releaseAll();
    },

    getStatus: function () {
      var P = window.AutoplayPerception;
      var obs = P ? P.observe() : null;
      var range = window.AutoplayRange ? window.AutoplayRange.probe() : null;
      return {
        state: this.state,
        enabled: this.enabled,
        generation: this.generation,
        error: this.lastError,
        lastBlock: this.lastBlock,
        lastGate: this.lastGate,
        stats: this.stats,
        uptimeMs: this.startedAt ? Math.round(performance.now() - this.startedAt) : 0,
        scene: obs && obs.scene,
        targets: obs && obs.targets ? obs.targets.length : 0,
        metrics: obs && obs.metrics ? obs.metrics : null,
        range: range ? {
          verdict: range.verdict,
          hitDistance: range.hitDistance,
          range: range.range,
          available: range.available,
          cameraRayContact: range.cameraRayContact,
          cameraRayDistance: range.cameraRayDistance,
          weaponRangeCheck: range.weaponRangeCheck
        } : null
      };
    }
  };

  // 复位后自动继续（sessionStorage 标记由 progress-reset 写入）
  try {
    if (sessionStorage.getItem('__autoplay_after_reset') === '1') {
      sessionStorage.removeItem('__autoplay_after_reset');
      window.addEventListener('load', function () {
        setTimeout(function () { Autoplay.start(); }, 1500);
      });
    }
  } catch (e) { /* ignore */ }

  window.Autoplay = Autoplay;
})();
