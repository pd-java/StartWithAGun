/**
 * web/autoplay/ui.js
 *
 * 控制面板绑定：启动 / 暂停 / 继续 / 停止 / 重置进度，以及状态显示与快捷键。
 * 快捷键：F7 启动或暂停继续切换，F8 紧急停止，F9 导出诊断日志。
 */
(function () {
  'use strict';

  var LABELS = {
    IDLE: '待机',
    STARTING: '等待游戏就绪',
    RUNNING: '运行中',
    PAUSED: '已暂停',
    STOPPING: '停止中',
    RESETTING: '重置中',
    COMPLETED: '已完成',
    ERROR: '出错'
  };

  var $ = function (id) { return document.getElementById(id); };
  var statusEl, metaEl, toggleBtn;

  function paint() {
    var A = window.Autoplay;
    if (!A || !statusEl) return;
    var st = A.getStatus();
    var text = LABELS[st.state] || st.state;
    if (st.state === 'ERROR' && st.error) text += '：' + st.error.slice(0, 40);
    statusEl.textContent = '状态：' + text;
    statusEl.className = 'ap-state ap-' + st.state.toLowerCase();

    if (metaEl) {
      metaEl.textContent = '场景 ' + (st.scene || '-') +
        ' · 目标 ' + st.targets +
        ' · 射击 ' + st.stats.shots +
        ' · 点击 ' + st.stats.taps;
    }

    if (toggleBtn) {
      toggleBtn.textContent = st.state === 'RUNNING' ? '暂停' : (st.state === 'PAUSED' ? '继续' : '启动');
      toggleBtn.disabled = ['STARTING', 'STOPPING', 'RESETTING'].indexOf(st.state) >= 0;
    }

    var b;
    b = $('ap-pause'); if (b) b.disabled = st.state !== 'RUNNING';
    b = $('ap-resume'); if (b) b.disabled = st.state !== 'PAUSED';
    b = $('ap-stop'); if (b) b.disabled = ['IDLE', 'STOPPING', 'RESETTING'].indexOf(st.state) >= 0;
  }

  function guard(fn) {
    return function (ev) {
      if (ev) ev.preventDefault();
      try { fn(); } catch (e) {
        console.error('[autoplay:ui]', e);
        if (window.alert) window.alert('操作失败：' + e.message);
      }
      setTimeout(paint, 60);
    };
  }

  function bind() {
    var A = window.Autoplay;
    if (!A) return;

    statusEl = $('ap-status');
    metaEl = $('ap-meta');
    toggleBtn = $('ap-toggle');

    if (toggleBtn) toggleBtn.addEventListener('click', guard(function () {
      if (A.state === 'RUNNING') A.pause();
      else if (A.state === 'PAUSED') A.resume();
      else A.start();
    }));

    var bp = $('ap-pause');
    if (bp) bp.addEventListener('click', guard(function () { A.pause(); }));

    var br = $('ap-resume');
    if (br) br.addEventListener('click', guard(function () { A.resume(); }));

    var bs = $('ap-stop');
    if (bs) bs.addEventListener('click', guard(function () { A.stop(); }));

    var breset = $('ap-reset');
    if (breset) breset.addEventListener('click', guard(function () {
      var plan = window.ProgressReset ? window.ProgressReset.inspect() : null;
      var msg = '重置将清除游戏存档并重新加载页面。\n\n' +
        (plan ? ('云存档 ' + plan.summary.cloud + ' 项 / 存档文件 ' + plan.summary.fs + ' 项 / 进度键 ' + plan.summary.gameProgress + ' 项') : '') +
        '\n\n继续？';
      if (!window.confirm(msg)) return;
      A.resetAndRestart();
    }));

    var bfold = $('ap-fold');
    if (bfold) bfold.addEventListener('click', guard(function () {
      var p = $('autoplay-panel');
      p.classList.toggle('ap-collapsed');
      bfold.textContent = p.classList.contains('ap-collapsed') ? '▸' : '▾';
    }));

    window.addEventListener('autoplay:statechange', function () { setTimeout(paint, 30); });

    // 快捷键
    window.addEventListener('keydown', function (e) {
      if (e.key === 'F7') {
        e.preventDefault();
        if (A.state === 'RUNNING') A.pause();
        else if (A.state === 'PAUSED') A.resume();
        else A.start();
        setTimeout(paint, 60);
      } else if (e.key === 'F8') {
        e.preventDefault();
        A.stop();
        setTimeout(paint, 60);
      } else if (e.key === 'F9') {
        e.preventDefault();
        var dump = window.AutoplayDiag ? window.AutoplayDiag.dump(120) : '(无日志)';
        dump = '=== autoplay status ===\n' + JSON.stringify(A.getStatus(), null, 2) + '\n\n=== diag ===\n' + dump;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(dump).then(function () { console.log('[autoplay] 诊断日志已复制'); });
        } else {
          console.log(dump);
        }
      }
    });

    // 1s 刷新一次状态
    setInterval(paint, 1000);
    paint();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
