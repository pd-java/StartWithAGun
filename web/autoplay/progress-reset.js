/**
 * web/autoplay/progress-reset.js
 *
 * 进度重置：只删除「已确认属于游戏进度」的存储，不碰资源缓存与设备标识。
 *
 * 实测得到的存储结构（见 README「虚拟文件系统持久化」）：
 *   wxgame:*       —— 微信风格 setStorageSync，含设备标识(UserId/clientId/device)与游戏数据
 *   wxcloud:*      —— 云存档槽，<appid>/<user>/CloudGameData 就是存档容器
 *   wxshim.fs:*    —— 虚拟文件系统落盘镜像，只存小文件(<=128KB)，
 *                     .bundle/.wasm/.br/.dat/.bin 等资源一律不落盘（见 FS_PERSIST_SKIP_EXT）
 *
 * 因此重置策略：
 *   - 必删：wxcloud:*（云存档）、wxshim.fs:*（存档文件镜像）
 *   - 选删：wxgame:* 中命中「进度类命名」的键
 *   - 保留：wxgame:* 中设备/客户端标识（删了会换设备号，可能影响埋点，但对进度无害）
 *   - 绝不删：wxshim.verbose、__autoplay_* 等非进度键
 *
 * 重要：清完必须 reload。Unity 实例内存里仍持有金币/关卡/解锁状态，
 * 不清进程直接继续玩会把旧进度重新写回存档。
 */
(function () {
  'use strict';

  var FS_PREFIX = 'wxshim.fs:';
  var CLOUD_PREFIX = 'wxcloud:';
  var GAME_PREFIX = 'wxgame:';
  var BACKUP_KEY = '__autoplay_reset_backup';

  // 设备/客户端标识：保留
  var IDENTITY_RE = /(clientid|device|local_id|userid|_id$|random_device)/i;
  // 明显的进度类命名：删除
  var PROGRESS_RE = /(save|slot|progress|level|coin|money|gem|weapon|upgrade|unlock|tutorial|league|energy|score|inventory|store|cloudgamedata)/i;

  function allKeys() {
    var out = [];
    for (var i = 0; i < localStorage.length; i++) out.push(localStorage.key(i));
    return out;
  }

  function classify() {
    var keys = allKeys();
    var res = {
      cloud: [],            // wxcloud:* —— 云存档
      fs: [],               // wxshim.fs:* —— 虚拟文件系统存档镜像
      gameProgress: [],     // wxgame:* 命中进度命名
      gameIdentity: [],     // wxgame:* 设备标识（保留）
      other: []
    };
    keys.forEach(function (k) {
      if (k.indexOf(CLOUD_PREFIX) === 0) { res.cloud.push(k); return; }
      if (k.indexOf(FS_PREFIX) === 0) { res.fs.push(k); return; }
      if (k.indexOf(GAME_PREFIX) === 0) {
        var body = k.slice(GAME_PREFIX.length);
        if (PROGRESS_RE.test(body)) res.gameProgress.push(k);
        else if (IDENTITY_RE.test(body)) res.gameIdentity.push(k);
        else res.other.push(k);
        return;
      }
      res.other.push(k);
    });
    return res;
  }

  var ProgressReset = {
    /** 只读检查，不修改任何数据 */
    inspect: function () {
      var c = classify();
      var fsDetail = c.fs.map(function (k) {
        return { key: k, bytes: (localStorage.getItem(k) || '').length };
      });
      var plan = c.cloud.concat(c.fs, c.gameProgress);
      return {
        ok: true,
        // 是否具备执行条件：至少有云存档或文件系统存档可清
        canReset: c.cloud.length + c.fs.length > 0,
        plan: plan,
        detail: {
          cloud: c.cloud,
          fs: fsDetail,
          gameProgress: c.gameProgress,
          keptIdentity: c.gameIdentity,
          other: c.other
        },
        summary: {
          total: plan.length,
          cloud: c.cloud.length,
          fs: c.fs.length,
          gameProgress: c.gameProgress.length
        }
      };
    },

    /** 备份将被删除的键（只备份小值，避免撑爆配额） */
    backup: function (keys) {
      var snap = { ts: Date.now(), data: {} };
      var bytes = 0;
      keys.forEach(function (k) {
        var v = localStorage.getItem(k);
        if (v == null) return;
        if (bytes + v.length > 2 * 1024 * 1024) return;   // 上限 2MB
        snap.data[k] = v;
        bytes += v.length;
      });
      try { localStorage.setItem(BACKUP_KEY, JSON.stringify(snap)); } catch (e) { /* 配额不足则跳过 */ }
      return { keys: Object.keys(snap.data).length, bytes: bytes };
    },

    /** 从备份恢复（调试/误删兜底） */
    restore: function () {
      var raw = localStorage.getItem(BACKUP_KEY);
      if (!raw) return { ok: false, reason: 'no-backup' };
      var snap;
      try { snap = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'bad-backup' }; }
      var n = 0;
      Object.keys(snap.data || {}).forEach(function (k) { localStorage.setItem(k, snap.data[k]); n++; });
      return { ok: true, restored: n };
    },

    /**
     * 执行重置。默认 dryRun=false，但会先备份。
     * 返回结果后由调用方决定是否 reload（autoplay.resetAndRestart 会 reload）。
     */
    reset: function (options) {
      var opt = options || {};
      var plan = this.inspect();
      if (!plan.plan.length) {
        return { ok: false, reason: 'nothing-to-clear', plan: plan.summary };
      }

      if (opt.dryRun) return { ok: true, dryRun: true, wouldRemove: plan.plan };

      var bak = this.backup(plan.plan);

      var removed = 0;
      plan.plan.forEach(function (k) {
        try { localStorage.removeItem(k); removed++; } catch (e) { /* ignore */ }
      });

      // 内存中的虚拟文件系统也一并清理存档类条目（不碰资源）
      var fsRemoved = 0;
      try {
        if (window.__wxShim && window.__wxShim.clearSaveFiles) {
          fsRemoved = window.__wxShim.clearSaveFiles();
        }
      } catch (e) { /* ignore */ }

      return { ok: true, removed: removed, fsRemoved: fsRemoved, backup: bak, summary: plan.summary };
    },

    /** 重置并重新加载页面，等加载完成后返回 */
    resetAndRestart: function () {
      var r = this.reset();
      if (!r.ok) return Promise.resolve(r);
      try { sessionStorage.setItem('__autoplay_after_reset', '1'); } catch (e) {}
      setTimeout(function () { location.reload(); }, 120);
      return Promise.resolve(r);
    }
  };

  window.ProgressReset = ProgressReset;
})();
