/**
 * web/autoplay/strategy.js
 *
 * 策略层：只根据观测决定「下一步做什么」，不直接发输入。
 *
 * V4 相比 V3 的三处改动（都来自实测踩坑）：
 *  1) 目标分通道加权。感知层给两类目标：red（红点/红靶标记）与 dark（浅色沙地
 *     上的深色敌人剪影）。本作真正要打的是 dark，V3 只按 size 排序会去追 UI 上的
 *     红点，所以这里给 dark 加权。
 *  2) 「假目标」黑名单。实测出现过对着启动页一个静止红点连打 60+ 枪——它既不
 *     消失也不推进流程。现在每次开枪后做一次验证：900ms 后同一位置仍有目标，
 *     说明这一枪没打掉任何东西，记账；同一位置累计 3 次即拉黑 30s。
 *  3) 点击（TAP）改成按场景决定。V3 无目标就点屏幕中央，进入战斗后也会点，
 *     属于无意义动作。V4 只在非战斗场景（idle 的闪屏/菜单/结算页）点。
 *
 * 刻意保留 WAIT：观测不可信时宁可不动，也不做盲目连点。
 */
(function () {
  'use strict';

  var CFG = {
    minTargetSize: 2,        // 连通格数下限，过滤噪点
    maxTargetY: 0.72,        // 只打上半部分的目标（下部是武器/HUD）
    shotCooldownMs: 420,     // 两枪之间的最小间隔
    tapCooldownMs: 1600,     // 推进型点击的最小间隔
    sameTargetRadius: 0.055, // 归一化半径内视为「同一位置」
    verifyDelayMs: 900,      // 开枪后多久去验证目标是否消失
    staleLimit: 3,           // 同一位置累计几次「打不掉」即拉黑
    blacklistMs: 30000,      // 拉黑时长
    darkWeight: 1.9,         // 深色目标（真实敌人）的优先级倍数
    redWeight: 1.0
  };

  var STATE = {
    lastShotAt: 0,
    lastShotPos: null,
    lastTapAt: 0,
    shotCount: 0,
    tapCount: 0,
    missCount: 0,
    pending: null,           // { x, y, at, kind } 待验证的那一枪
    stale: {},               // key -> 累计次数
    blacklist: []            // [{ x, y, until, key }]
  };

  function now() { return performance.now(); }

  function dist(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** 位置量化成栅格 key，避免浮点抖动导致「同一位置」判定失效 */
  function keyOf(p) {
    return Math.round(p.x / 0.04) + ':' + Math.round(p.y / 0.04);
  }

  function isBlacklisted(p) {
    var t = now();
    for (var i = 0; i < STATE.blacklist.length; i++) {
      var b = STATE.blacklist[i];
      if (b.until > t && dist(p, b) < CFG.sameTargetRadius) return true;
    }
    return false;
  }

  function pruneBlacklist() {
    var t = now();
    if (!STATE.blacklist.length) return;
    STATE.blacklist = STATE.blacklist.filter(function (b) { return b.until > t; });
  }

  function blacklist(p, why) {
    var k = keyOf(p);
    // 已有同类记录则续期，不重复堆叠
    for (var i = 0; i < STATE.blacklist.length; i++) {
      var b = STATE.blacklist[i];
      if (dist(p, b) < CFG.sameTargetRadius) {
        b.until = now() + CFG.blacklistMs;
        b.why = why;
        return;
      }
    }
    STATE.blacklist.push({ x: p.x, y: p.y, key: k, until: now() + CFG.blacklistMs, why: why });
  }

  var Strategy = {
    config: CFG,
    stats: STATE,

    reset: function () {
      STATE.lastShotAt = 0; STATE.lastShotPos = null; STATE.lastTapAt = 0;
      STATE.shotCount = 0; STATE.tapCount = 0; STATE.missCount = 0;
      STATE.pending = null; STATE.stale = {}; STATE.blacklist = [];
    },

    /**
     * 验证上一枪是否奏效。每 tick 调一次，开销可忽略。
     * 判定：开枪后 verifyDelayMs 已过，同一位置仍有目标 → 这一枪白打。
     */
    verify: function (obs) {
      var p = STATE.pending;
      if (!p) return;
      if (now() - p.at < CFG.verifyDelayMs) return;

      STATE.pending = null;
      var targets = (obs && obs.targets) || [];
      var still = null;
      for (var i = 0; i < targets.length; i++) {
        if (dist(targets[i], p) < CFG.sameTargetRadius) { still = targets[i]; break; }
      }
      if (!still) return;   // 目标消失了 = 打掉了（或它自己走了）

      var k = keyOf(p);
      STATE.stale[k] = (STATE.stale[k] || 0) + 1;
      STATE.missCount++;
      if (STATE.stale[k] >= CFG.staleLimit) {
        blacklist(p, 'stale-' + STATE.stale[k]);
        delete STATE.stale[k];
      }
    },

    /** 从观测中挑一个值得打的目标 */
    pickTarget: function (obs) {
      if (!obs || !obs.valid) return null;
      pruneBlacklist();

      var list = (obs.targets || []).filter(function (t) {
        if (t.size < CFG.minTargetSize) return false;
        if (t.y >= CFG.maxTargetY) return false;
        if (isBlacklisted(t)) return false;
        return true;
      });
      if (!list.length) return null;

      // 评分：体积 × 通道权重。dark（敌人剪影）优先于 red（可能是 UI 红点）。
      list.sort(function (a, b) {
        var wa = a.kind === 'dark' ? CFG.darkWeight : CFG.redWeight;
        var wb = b.kind === 'dark' ? CFG.darkWeight : CFG.redWeight;
        return (b.size * wb) - (a.size * wa);
      });
      return list[0];
    },

    /**
     * 返回动作：
     *   { type:'SHOOT', target:{x,y,size,kind}, reason }
     *   { type:'TAP',   x, y, reason }        —— 推进菜单/继续/结算
     *   { type:'WAIT',  reason }
     */
    chooseAction: function (obs) {
      var t = now();

      if (!obs || !obs.valid) return { type: 'WAIT', reason: 'observation-invalid' };

      // 每 tick 先结算上一枪的效果判定
      this.verify(obs);

      if (obs.scene === 'loading') return { type: 'WAIT', reason: 'loading' };

      var target = this.pickTarget(obs);
      var canShoot = t - STATE.lastShotAt >= CFG.shotCooldownMs;

      if (target) {
        if (!canShoot) return { type: 'WAIT', reason: 'cooldown' };
        // 同一位置刚打过，且这一枪还没验证出结果：别急着重打
        if (STATE.pending && dist(target, STATE.pending) < CFG.sameTargetRadius) {
          return { type: 'WAIT', reason: 'pending-verify' };
        }
        return {
          type: 'SHOOT',
          target: { x: target.x, y: target.y, size: target.size, kind: target.kind },
          reason: (target.kind || 't') + '-' + target.size
        };
      }

      // 没有目标：只有非战斗场景才点一下推进（闪屏/菜单/结算）
      if (obs.scene !== 'gameplay') {
        if (t - STATE.lastTapAt >= CFG.tapCooldownMs) {
          return { type: 'TAP', x: 0.5, y: 0.5, reason: 'advance-' + obs.scene };
        }
        return { type: 'WAIT', reason: 'tap-cooldown' };
      }

      return { type: 'WAIT', reason: 'no-target' };
    },

    /** 输入完成后回报，用于统计与冷却 */
    reportShot: function (target) {
      STATE.lastShotAt = now();
      STATE.lastShotPos = target ? { x: target.x, y: target.y } : null;
      STATE.shotCount++;
      if (target) {
        STATE.pending = { x: target.x, y: target.y, at: now(), kind: target.kind };
      }
    },

    reportTap: function () {
      STATE.lastTapAt = now();
      STATE.tapCount++;
    },

    /** 供面板/诊断查看 */
    inspect: function () {
      return {
        shots: STATE.shotCount,
        taps: STATE.tapCount,
        misses: STATE.missCount,
        pending: STATE.pending,
        blacklist: STATE.blacklist.map(function (b) {
          return { x: +b.x.toFixed(3), y: +b.y.toFixed(3), remainMs: Math.round(b.until - now()), why: b.why };
        }),
        stale: STATE.stale
      };
    }
  };

  window.AutoplayStrategy = Strategy;
})();
