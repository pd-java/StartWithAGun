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
 *   1) 准星已经在活体上            → 开火
 *   2) 准星虽然在活体上，但超出 25  → 不开火，报 OUT_OF_RANGE（等敌人走近 / 或场景本身无解）
 *   3) 引擎状态读不到              → 不阻断，交回视觉链路
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
     * 核心判定。
     * @returns {{
     *   available: boolean,
     *   verdict: 'IN_RANGE'|'OUT_OF_RANGE'|'NO_HIT'|'UNAVAILABLE',
     *   hitDistance: number|null,
     *   range: number,
     *   camera: {position:number[], forward:number[]}|null
     * }}
     */
    probe: function (opts) {
      var now = performance.now();
      var force = opts && opts.force;
      if (!force && _cache && now - _cacheAt < CACHE_MS) return _cache;

      var result = {
        available: available(),
        verdict: 'UNAVAILABLE',
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
            result.verdict = 'NO_HIT';
          } else {
            result.hitDistance = hit.dist;
            result.verdict = hit.dist <= WEAPON_RANGE ? 'IN_RANGE' : 'OUT_OF_RANGE';
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

    /** 是否允许开火：读不到引擎状态时放行（交回视觉链路），读到且超出射程时拦截 */
    allowShot: function () {
      var p = this.probe();
      if (p.verdict === 'UNAVAILABLE') return { allowed: true, reason: 'guard-unavailable' };
      if (p.verdict === 'OUT_OF_RANGE') return { allowed: false, reason: 'out-of-range' };
      return { allowed: true, reason: p.verdict.toLowerCase() };
    },

    /**
     * 对「屏幕上某个归一化点」判断这一枪能否打到东西。
     * 视觉链路说「这里有个靶子」，闸门负责回答「引擎能不能真的够到它」。
     *
     * @returns {{available:boolean, verdict:string, hitDistance:number|null, range:number}}
     *          verdict: IN_RANGE | OUT_OF_RANGE | NO_CONTACT | UNAVAILABLE
     */
    probeScreenPoint: function (nx, ny, opts) {
      var out = { available: available(), verdict: 'UNAVAILABLE', hitDistance: null, range: WEAPON_RANGE };
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
        return out;
      }
      out.hitDistance = f32at(hitPtr + HIT_OFF_DISTANCE);
      out.verdict = out.hitDistance <= WEAPON_RANGE ? 'IN_RANGE' : 'OUT_OF_RANGE';
      return out;
    },

    /**
     * 开火前的最终闸门：视觉给了一个屏幕点，问引擎「够得到吗」。
     * 读不到引擎状态 → 放行（不能因为工具不可用就瘫痪自动玩）。
     */
    allowShotAt: function (nx, ny) {
      if (!available()) return { allowed: true, reason: 'guard-unavailable' };

      var p = this.probeScreenPoint(nx, ny);
      if (p.verdict === 'OUT_OF_RANGE') return { allowed: false, reason: 'out-of-range', hitDistance: p.hitDistance };
      if (p.verdict === 'NO_CONTACT') return { allowed: false, reason: 'no-contact', hitDistance: null };
      if (p.verdict === 'IN_RANGE') return { allowed: true, reason: 'in-range', hitDistance: p.hitDistance };

      // 屏幕点这条路暂时不可用（例如某个版本的 WorldToScreenPoint 约定没对上），
      // 退一步用准星射线做同样的判断：策略在开火前已经先瞄准，所以准星方向就是射向。
      var f = this.probe();
      if (f.verdict === 'UNAVAILABLE') return { allowed: true, reason: 'guard-unavailable' };
      if (f.verdict === 'OUT_OF_RANGE') return { allowed: false, reason: 'out-of-range', hitDistance: f.hitDistance, via: 'crosshair' };
      if (f.verdict === 'NO_HIT') return { allowed: false, reason: 'no-contact', hitDistance: null, via: 'crosshair' };
      return { allowed: true, reason: 'in-range', hitDistance: f.hitDistance, via: 'crosshair' };
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
