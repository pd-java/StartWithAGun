/**
 * web/autoplay/range-guard.js
 *
 * 射程闸门（range guard）——自动玩的「能不能打得到」判定，读取引擎真实状态，不猜。
 *
 * 为什么需要它
 * ------------
 * 实测结论（见 .workbuddy/memory/2026-10-27.md）：
 *   RangedWeaponShotSimulator::SimulateShot       的球扫  radius=0.08  maxDistance=25
 *   …::HasHealthComponentInRadiusOfBulletTrajectory 的球扫  radius=2.00  maxDistance=25
 * 两道球扫的 maxDistance 都是硬编码的 25（世界单位）。超过 25 的活体永远打不中，
 * 而 Shoot() 会在这道资格门前直接 return —— 表现就是「枪不响」。
 *
 * 所以自动玩必须能区分三件事，否则只会在原地空放：
 *   1) 准星已经在活体上             → 开火
 *   2) 测到碰撞但超出 25            → 不开火，报 beyond-range
 *   3) 引擎状态读不到 / 射线没碰到东西 → 不阻断，交回视觉链路
 *
 * ★ 诊断 ≠ 决策
 * -------------
 * 本模块严格区分「观测到的事实」和「据此做的决定」：
 *   事实：cameraRayContact / cameraRayDistance / candidateTargetDistance / weaponRangeCheck
 *   决定：allowShotAt() 的 allowed
 * 相机射线（零半径、从相机出发）和武器资格门（radius=2 的 SphereCast、从枪口出发、
 * 可能用不同碰撞层掩码）并不等价，因此**只有「确实测到碰撞且距离 > 25」才拦截**。
 * 「相机射线没碰到东西」只是相机射线没发现接触点，不能推断成武器打不中。
 *
 * 实现方式：WASM 导出了 __indirect_function_table 与 malloc，因此可以直接调用
 *   UnityEngine.Camera::get_main / Transform::get_position / Transform::get_forward /
 *   UnityEngine.Physics::Raycast
 * 全部是只读查询，不修改任何游戏状态，也不改变射程。
 *
 * 所有槽位都是按当前这版 wasm 实测标定的，换包会失效 —— 失效时 available() 返回 false，
 * 自动玩退回纯视觉路径，不会因为读不到而卡死。
 */
(function () {
  'use strict';

  // ── 实测标定的函数表槽位 ────────────────────────────────────
  var SLOT = {
    camMain: 7701,      // UnityEngine.Camera::get_main                  fn(0)
    getTransform: 4877, // UnityEngine.Component::get_transform          fn(obj, 0)
    getPosition: 96638, // UnityEngine.Transform::get_position_Injected  fn(tr, retPtr, 0)
    getForward: 6797,   // UnityEngine.Transform::get_forward            fn(retPtr, tr, 0)
    raycast: 100237,    // UnityEngine.Physics::Raycast                  fn(o, d, hit, maxDist, mask, qti, 0)
    screenRay: 93385    // UnityEngine.Camera::ScreenPointToRay_Injected fn(cam, pointPtr, rayPtr, 0)
  };

  var HIT_OFF_DISTANCE = 28;   // RaycastHit: Point 0 / Normal 12 / FaceID 24 / Distance 28 / Collider 40
  var HIT_OFF_COLLIDER = 40;

  // 实测：Shoot 与 SimulateShot 里球扫的 maxDistance 常量
  var WEAPON_RANGE = 25;

  var CACHE_MS = 400;   // 同一帧内多处查询复用结果，避免每个 tick 里反复跨边界调用
  var _cache = null;
  var _cacheAt = 0;
  // 只在「调用真的抛异常」时才置位。wasm 尚未就绪属于「还没好」，不能据此判定模块坏掉 ——
  // 否则 ui.js 在启动早期 paint 一次，就会把闸门永久废掉（实测踩过）。
  var _broken = false;

  function exportsObj() {
    return window.__wasmMainExports || null;
  }

  function table() {
    var e = exportsObj();
    return e && e.__indirect_function_table ? e.__indirect_function_table : null;
  }

  function available() {
    if (_broken) return false;
    var e = exportsObj();
    var T = table();
    var mem = window.__wasmMemory;
    return !!(T && typeof T.get === 'function' && e && typeof e.malloc === 'function' &&
              mem && mem.buffer && mem.buffer.byteLength > 0);
  }

  function callFn(slot, args) {
    var T = table();
    if (!T) return null;
    var f;
    try { f = T.get(slot); } catch (e) { return null; }
    if (typeof f !== 'function') return null;
    try { return f.apply(null, args); } catch (e) { _broken = true; return null; }
  }

  var _scratch = 0;
  function scratch(size) {
    if (_scratch) return _scratch;
    var e = exportsObj();
    _scratch = e.malloc(size || 256);
    var dv = new DataView(window.__wasmMemory.buffer);
    for (var i = 0; i < (size || 256); i += 4) dv.setUint32(_scratch + i, 0, true);
    return _scratch;
  }

  function f32at(addr) {
    return new DataView(window.__wasmMemory.buffer).getFloat32(addr | 0, true);
  }

  function putVec3(off, v) {
    var base = scratch() + off;
    var dv = new DataView(window.__wasmMemory.buffer);
    dv.setFloat32(base, v[0], true);
    dv.setFloat32(base + 4, v[1], true);
    dv.setFloat32(base + 8, v[2], true);
  }

  function readVec3(off) {
    var base = scratch() + off;
    return [f32at(base), f32at(base + 4), f32at(base + 8)];
  }

  /** 相机位置与朝向；读不到返回 null */
  function readCamera() {
    if (!available()) return null;
    var cam = callFn(SLOT.camMain, [0]);
    if (!cam || typeof cam !== 'number' || cam < 1024) return null;
    var tr = callFn(SLOT.getTransform, [cam, 0]);
    if (!tr || typeof tr !== 'number' || tr < 1024) return null;

    var base = scratch();
    callFn(SLOT.getPosition, [tr, base + 32, 0]);
    callFn(SLOT.getForward, [base + 48, tr, 0]);

    var p = readVec3(32), f = readVec3(48);
    if (!isFinite(p[0]) || !isFinite(f[0])) return null;
    if (Math.abs(p[0]) > 1e7 || Math.abs(f[0]) > 1e3) return null;
    return { position: p, forward: f };
  }

  function norm(v) {
    var l = Math.hypot(v[0], v[1], v[2]);
    return l > 1e-6 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 1];
  }

  /**
   * 沿相机朝向打一条射线，返回命中距离。
   * 这条射线就代表「这一枪会打到哪里」，用来判断目标是否真的在射程内。
   */
  function castForward(maxDistance) {
    var cam = readCamera();
    if (!cam) return null;

    var base = scratch();
    putVec3(0, cam.position);
    putVec3(16, norm(cam.forward));

    var hitPtr = base + 96;
    var dv = new DataView(window.__wasmMemory.buffer);
    for (var i = 0; i < 48; i += 4) dv.setUint32(hitPtr + i, 0, true);

    var r = callFn(SLOT.raycast, [base, base + 16, hitPtr, maxDistance || 500, -1, 2, 0]);
    if (r !== 0 && r !== 1) return { ok: false, dist: null, collider: 0, blocked: false };
    if (r === 0) return { ok: false, dist: null, collider: 0, blocked: true };
    return {
      ok: true,
      dist: f32at(hitPtr + HIT_OFF_DISTANCE),
      collider: dv.getUint32(hitPtr + HIT_OFF_COLLIDER, true),
      blocked: false
    };
  }

  var Range = {
    RANGE: WEAPON_RANGE,

    available: available,

    /** 清缓存（暂停/复位/换场景后调用，避免用上一场景的判定） */
    invalidate: function () {
      _cache = null;
      _cacheAt = 0;
      _broken = false;
    },

    /**
     * 准星射线判定：沿相机朝向打一条 maxDistance=25 的射线。
     *
     * 重要：这个结果**只是诊断**，不是「武器能不能命中」的等价证明。
     *   相机原点 ≠ 枪口原点；
     *   相机射线是零半径射线，武器资格门是 radius=2 的 SphereCast；
     *   两者的碰撞层掩码也可能不同。
     * 所以本函数如实报告「相机射线上发生了什么」，开不开火由 allowShotAt 的策略决定。
     */
    probe: function (opts) {
      var now = performance.now();
      var force = opts && opts.force;
      if (!force && _cache && now - _cacheAt < CACHE_MS) return _cache;

      var result = {
        available: available(),
        verdict: 'UNAVAILABLE',
        cameraRayContact: null,     // 相机射线是否发现了碰撞体
        cameraRayDistance: null,    // 相机射线首次碰撞的距离
        candidateTargetDistance: null, // 候选目标的测量距离（准星这条路上没有独立目标，留空）
        weaponRangeCheck: 'unknown',   // 'in-range' | 'beyond-range' | 'unknown'
        hitDistance: null,
        range: WEAPON_RANGE,
        camera: null
      };

      if (result.available) {
        var cam = readCamera();
        result.camera = cam;
        if (cam) {
          var hit = castForward(WEAPON_RANGE);
          if (!hit) {
            result.verdict = 'UNAVAILABLE';
          } else if (!hit.ok) {
            result.verdict = 'NO_CONTACT';
            result.cameraRayContact = false;
          } else {
            result.verdict = hit.dist <= WEAPON_RANGE ? 'IN_RANGE' : 'OUT_OF_RANGE';
            result.cameraRayContact = true;
            result.cameraRayDistance = hit.dist;
            result.hitDistance = hit.dist;
            result.weaponRangeCheck = hit.dist <= WEAPON_RANGE ? 'in-range' : 'beyond-range';
          }
        }
      }

      // 只在真正读到引擎状态时缓存；读不到就每 tick 重试，别把「没就绪」缓存成结论
      if (result.available && result.camera) {
        _cache = result;
        _cacheAt = now;
      }
      return result;
    },

    /**
     * 准星路径的放行判断。
     * 只有「确实测到碰撞且距离超过射程」才拦截；其余一律放行并注明原因。
     */
    allowShot: function () {
      var p = this.probe();
      if (p.verdict === 'UNAVAILABLE') return { allowed: true, reason: 'guard-unavailable', weaponRangeCheck: 'unknown' };
      if (p.verdict === 'OUT_OF_RANGE') return { allowed: false, reason: 'beyond-range', hitDistance: p.hitDistance, weaponRangeCheck: 'beyond-range' };
      if (p.verdict === 'NO_CONTACT') return { allowed: true, reason: 'camera-ray-no-contact', weaponRangeCheck: 'unknown' };
      return { allowed: true, reason: 'in-range', hitDistance: p.hitDistance, weaponRangeCheck: 'in-range' };
    },

    /**
     * 对「屏幕上某个归一化点」判断这一枪能否打到东西。
     * 视觉链路说「这里有个靶子」，闸门负责回答「沿这条视线，引擎测到了什么」。
     *
     * 返回的每个字段只描述**观测到的事实**，不描述结论：
     *   cameraRayContact      相机射线有没有碰到东西     true/false/null(未知)
     *   candidateTargetDistance 目标候选的测量距离        这里无法独立测量，恒为 null
     *   cameraRayDistance     相机射线首次碰撞距离
     *   weaponRangeCheck      武器射程检查结论           'in-range'|'beyond-range'|'unknown'
     *
     * @returns {{available:boolean, verdict:string, cameraRayContact:boolean|null,
     *            cameraRayDistance:number|null, candidateTargetDistance:number|null,
     *            weaponRangeCheck:string, hitDistance:number|null, range:number}}
     */
    probeScreenPoint: function (nx, ny, opts) {
      var out = {
        available: available(),
        verdict: 'UNAVAILABLE',
        cameraRayContact: null,
        cameraRayDistance: null,
        candidateTargetDistance: null,
        weaponRangeCheck: 'unknown',
        hitDistance: null,
        range: WEAPON_RANGE
      };
      if (!out.available) return out;

      var cam = callFn(SLOT.camMain, [0]);
      if (!cam || cam < 1024) return out;
      var canvas = document.querySelector('canvas');
      if (!canvas || !canvas.width) return out;

      // 注意坐标原点：画布是左上原点，Unity 屏幕坐标是左下原点
      var sx = nx * canvas.width;
      var sy = canvas.height - ny * canvas.height;

      var base = scratch();
      var dv = new DataView(window.__wasmMemory.buffer);
      dv.setFloat32(base + 64, sx, true);
      dv.setFloat32(base + 68, sy, true);
      for (var i = 0; i < 24; i += 4) dv.setUint32(base + 72 + i, 0, true);   // Ray 结构 24 字节

      var ok = callFn(SLOT.screenRay, [cam, base + 64, base + 72, 0]);
      if (ok === null) return out;

      var ox = f32at(base + 72), oy = f32at(base + 76), oz = f32at(base + 80);
      var dx = f32at(base + 84), dy = f32at(base + 88), dz = f32at(base + 92);
      if (!isFinite(ox) || !isFinite(dx) || (dx === 0 && dy === 0 && dz === 0)) return out;

      var hitPtr = base + 120;
      for (var j = 0; j < 48; j += 4) dv.setUint32(hitPtr + j, 0, true);
      var r = callFn(SLOT.raycast, [base + 72, base + 84, hitPtr, 500, -1, 2, 0]);
      if (r !== 0 && r !== 1) return out;
      if (r === 0) {
        out.verdict = 'NO_CONTACT';
        out.cameraRayContact = false;
        return out;
      }
      out.cameraRayContact = true;
      out.cameraRayDistance = f32at(hitPtr + HIT_OFF_DISTANCE);
      out.hitDistance = out.cameraRayDistance;
      out.weaponRangeCheck = out.cameraRayDistance <= WEAPON_RANGE ? 'in-range' : 'beyond-range';
      out.verdict = out.cameraRayDistance <= WEAPON_RANGE ? 'IN_RANGE' : 'OUT_OF_RANGE';
      return out;
    },

    /**
     * 开火前的最终闸门。
     *
     * 判定策略（刻意保守的方向是「不要错误阻断」）：
     *   1) 引擎状态读不到            → 放行，reason=guard-unavailable
     *   2) 测到碰撞且距离 > 25       → 拦截，reason=beyond-range   ← 唯一的拦截条件
     *   3) 测到碰撞且距离 <= 25      → 放行，reason=in-range
     *   4) 射线完全没碰到东西        → **放行**，reason=camera-ray-no-contact
     *
     * 第 4 条是刻意这么定的：相机射线没碰到东西，只说明「这条零半径视线上没有碰撞体」，
     * 不等于武器打不中 —— 武器是半径 2m 的 SphereCast，且从枪口而不是相机出发。
     * 把这个当拦截条件会造成错误阻断，所以它只作为诊断信息回传。
     */
    allowShotAt: function (nx, ny) {
      if (!available()) {
        return { allowed: true, reason: 'guard-unavailable', weaponRangeCheck: 'unknown', cameraRayContact: null, hitDistance: null };
      }

      var p = this.probeScreenPoint(nx, ny);
      var diag = {
        weaponRangeCheck: p.weaponRangeCheck,
        cameraRayContact: p.cameraRayContact,
        cameraRayDistance: p.cameraRayDistance,
        candidateTargetDistance: p.candidateTargetDistance
      };

      if (p.verdict === 'OUT_OF_RANGE') {
        return { allowed: false, reason: 'beyond-range', hitDistance: p.hitDistance, via: 'screen', diag: diag };
      }
      if (p.verdict === 'IN_RANGE') {
        return { allowed: true, reason: 'in-range', hitDistance: p.hitDistance, via: 'screen', diag: diag };
      }

      // 屏幕点这条路本身不可用（某个版本的 ScreenPointToRay 约定没对上），
      // 退一步用准星射线做同样的判断：策略在开火前已经先瞄准，准星方向就是射向。
      var f = this.probe();
      if (f.verdict === 'UNAVAILABLE') {
        return { allowed: true, reason: 'guard-unavailable', weaponRangeCheck: 'unknown', cameraRayContact: null, hitDistance: null, via: 'crosshair' };
      }
      if (f.verdict === 'OUT_OF_RANGE') {
        return { allowed: false, reason: 'beyond-range', hitDistance: f.hitDistance, via: 'crosshair', diag: { weaponRangeCheck: f.weaponRangeCheck, cameraRayContact: f.cameraRayContact, cameraRayDistance: f.cameraRayDistance, candidateTargetDistance: null } };
      }
      if (f.verdict === 'NO_CONTACT') {
        return { allowed: true, reason: 'camera-ray-no-contact', hitDistance: null, via: 'crosshair', diag: { weaponRangeCheck: 'unknown', cameraRayContact: false, cameraRayDistance: null, candidateTargetDistance: null } };
      }
      return { allowed: true, reason: 'in-range', hitDistance: f.hitDistance, via: 'crosshair', diag: { weaponRangeCheck: f.weaponRangeCheck, cameraRayContact: f.cameraRayContact, cameraRayDistance: f.cameraRayDistance, candidateTargetDistance: null } };
    },

    /**
     * 目标可达性诊断：沿「相机→某点」方向做一次远距离射线，
     * 用来区分「视线被挡」与「只是超出 25 的射程」。
     */
    diagnoseDirection: function (point) {
      if (!available() || !point) return null;
      var cam = readCamera();
      if (!cam) return null;
      var d = norm([point[0] - cam.position[0], point[1] - cam.position[1], point[2] - cam.position[2]]);
      var base = scratch();
      putVec3(0, cam.position);
      putVec3(16, d);
      var hitPtr = base + 96;
      var dv = new DataView(window.__wasmMemory.buffer);
      for (var i = 0; i < 48; i += 4) dv.setUint32(hitPtr + i, 0, true);
      var r = callFn(SLOT.raycast, [base, base + 16, hitPtr, 500, -1, 2, 0]);
      return {
        distanceToPoint: Math.hypot(point[0] - cam.position[0], point[1] - cam.position[1], point[2] - cam.position[2]),
        hit: r === 1,
        hitDistance: r === 1 ? f32at(hitPtr + HIT_OFF_DISTANCE) : null
      };
    }
  };

  window.AutoplayRange = Range;
})();
