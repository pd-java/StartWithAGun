#!/usr/bin/env python3
"""wasm_probe_marker.py —— 给 IL2CPP wasm 函数插入「可逆诊断计数器」。

原理：
  1. 在 global 段追加若干「可变 i32 全局」（初值 0），并导出为 __dbg<N>，
     JS 侧可直接读 instance.exports.__dbg<N>.value。
  2. 在目标函数**入口**插入
         global.get g; i32.const 1; i32.add; global.set g
     （被调用次数 +1，进出栈平衡，不改变任何原有语义）
  3. 对指定函数，还在**每个 return 指令之前**以及**函数末尾**插入同样一段，
     每个出口用独立计数器 —— 「从哪个提前返回分支退出」直接可读，无需调试器。

  纯观测补丁，只增指令不改语义，restore 可一键还原。

用法：
  python tools/wasm_probe_marker.py install
  python tools/wasm_probe_marker.py status
  python tools/wasm_probe_marker.py restore
"""
import os, sys, shutil, json

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, ROOT)

MAIN = os.path.join(ROOT, 'web', 'assets', 'wasmcode_decompressed.wasm')
SPLIT = os.path.join(ROOT, 'web', 'assets', 'wasmcode1_decompressed.wasm')
MARK = '.orig-probe'

# 目标函数：(标签, 模块函数索引[含 import 偏移], 是否插「每个 return 出口」计数器)
# 索引来源：tools/probe_resolve.py / probe_table_slot.py
PROBE_MAIN = [
    # ── 输入/每帧循环 ──
    ('Update',                10882, False),
    ('LateUpdate',            10886, False),
    ('TouchPosition',         10874, False),
    ('ObjectUnderPointer',    10878, False),
    ('ClampAimingDirection',  10887, False),
    ('CalculateSwayOffset',   10888, False),
    # ── 射击主链（Shoot 内部按顺序调用的就是这几步）──
    ('Shoot',                 10883, False),
    ('AllowAimingCheck',      10881, False),
    ('GetMouseButtonUp',       1973, False),
    ('AreBarrelsReadyToFire',  8899, False),
    ('HasHealthInShotRadius',  8908, False),
    ('SimulateShot',           8905, False),
    ('ShootWeapon',           10506, False),
    ('PlayProjectileSniper',   8135, False),
    ('LargeVibration',         8136, False),
    ('EnableBulletCam',       10884, False),
    # ── 命中 / 伤害 / 教程判定 ──
    ('TakeDamage',            10676, False),
    ('HealthKill',            10677, False),
    ('HealthKillNoCb',        10678, False),
    ('RangeTargetOnKill',     10686, False),
    ('RangeTargetRevive',     10684, False),
    ('CountAliveHealth',       9572, False),
]
PROBE_SPLIT = [
    ('ShootAsync',        51980, True),
    ('ShootRoutine',      51979, True),
    ('IsPointerOverUI',   51976, False),
    ('SetZoomPercent',     1367, False),
    ('AutoReviveRoutine', 51808, False),
    ('TutorialPlayRoutine', 46308, False),
    # ── 弹道 / 命中（HS_ = HitScan 组）──
    ('ProjStart',        43451, False),
    ('ProjFixedUpdate',  43452, False),
    ('ProjCollide',      43453, False),
    ('HSHitTakeDamage',  43447, False),
    ('HSHitCtor',        43450, False),
    ('EnemyOnTakeDamage', 41725, False),
]

# 分支站点：模块函数索引 -> [(原指令偏移, 标签)]
# 把 br_if L 改写成 if(bump; br L+1) end —— 语义不变，但「这个守卫真的拒绝了」可计数
BRANCH_SITES = {
    # FPSPlayerController::Shoot 顶部三段守卫
    10883: [(0x61, 'rej_cover_hit'), (0x6c, 'rej_barrels'), (0x7b, 'rej_blockflag')],
    # FPSPlayerController::Update 的六道闸门（br_if 0 = 跳过本帧射击）
    10882: [(0xc0, 'upd_canfire'), (0xca, 'upd_f36'), (0xd3, 'upd_settings'),
            (0xda, 'upd_f24'), (0xe4, 'upd_mouseup'), (0xeb, 'upd_f56')],
}
# 打点：模块函数索引 -> [(原指令偏移, 标签)]，含义是「执行流走到了这里」
POINT_SITES = {
    # call SimulateShot 之前 = 三段守卫全部放行
    10883: [(0x8d, 'guards_passed')],
    # call Shoot 之前 = Update 六道闸门全部放行
    10882: [(0xed, 'calls_shoot')],
}


# ------------------------------------------------------------------ 编解码
def uleb(b, p):
    r = 0; s = 0
    while True:
        x = b[p]; p += 1
        r |= (x & 0x7f) << s; s += 7
        if not x & 0x80:
            return r, p


def uleb_enc(v):
    out = bytearray()
    while True:
        x = v & 0x7F
        v >>= 7
        if v:
            out.append(x | 0x80)
        else:
            out.append(x)
            return bytes(out)


def parse_sections(raw):
    assert raw[:4] == b'\x00asm', 'not wasm'
    p = 8
    secs = []
    while p < len(raw):
        sid = raw[p]; p += 1
        size, p2 = uleb(raw, p)
        secs.append([sid, raw[p2:p2 + size]])
        p = p2 + size
    return secs


def emit(secs):
    out = bytearray(b'\x00asm\x01\x00\x00\x00')
    for sid, payload in secs:
        out.append(sid)
        out += uleb_enc(len(payload))
        out += payload
    return bytes(out)


# ------------------------------------------------------------- 指令长度表
BLOCK_OPS = {0x02, 0x03, 0x04}
MEMARG_OPS = set(range(0x28, 0x3f))
NO_IMM = set()
for _o in (0x00, 0x01, 0x0f, 0x1a, 0x1b):
    NO_IMM.add(_o)
for _o in range(0x45, 0xc5):
    NO_IMM.add(_o)


def _skip_sleb(b, p):
    while True:
        x = b[p]; p += 1
        if not x & 0x80:
            return p


def read_blocktype(b, p):
    v = b[p]
    if v == 0x40 or v in (0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f):
        return p + 1
    return _skip_sleb(b, p)


def decode(code):
    """返回 [(offset, opcode)]，并强校验块嵌套平衡。"""
    p = 0
    n = len(code)
    out = []
    depth = 1          # 函数体本身就是一个隐式 block，由末尾 end 关闭
    while p < n:
        start = p
        op = code[p]
        if op in BLOCK_OPS:
            p = read_blocktype(code, p + 1); depth += 1
        elif op == 0x0b:
            p += 1; depth -= 1
        elif op == 0x05:
            p += 1
        elif op in (0x0c, 0x0d):
            _, p = uleb(code, p + 1)
        elif op == 0x0e:
            c, p = uleb(code, p + 1)
            for _ in range(c + 1):
                _, p = uleb(code, p)
        elif op in (0x10, 0x25, 0x26, 0xd2):
            _, p = uleb(code, p + 1)
        elif op == 0x11:
            _, p = uleb(code, p + 1); _, p = uleb(code, p)
        elif op == 0x1c:
            c, p = uleb(code, p + 1); p += c
        elif op in (0x20, 0x21, 0x22, 0x23, 0x24):
            _, p = uleb(code, p + 1)
        elif op in MEMARG_OPS:
            _, p = uleb(code, p + 1); _, p = uleb(code, p)
        elif op in (0x3f, 0x40):
            _, p = uleb(code, p + 1)
        elif op in (0x41, 0x42):
            p = _skip_sleb(code, p + 1)
        elif op == 0x43:
            p += 5
        elif op == 0x44:
            p += 9
        elif op == 0xd0:
            p = _skip_sleb(code, p + 1)
        elif op == 0xfc:
            sub, p = uleb(code, p + 1)
            if sub == 8:
                _, p = uleb(code, p); _, p = uleb(code, p)
            elif sub in (9, 11, 13, 15, 16, 17):
                _, p = uleb(code, p)
            elif sub in (10, 12, 14):
                _, p = uleb(code, p); _, p = uleb(code, p)
        elif op in NO_IMM:
            p += 1
        else:
            raise ValueError('未支持 opcode 0x%02x @%d' % (op, start))
        out.append((start, op))
    if depth != 0:
        raise ValueError('块嵌套不平衡 depth=%d（解码不可信）' % depth)
    if out[-1][1] != 0x0b:
        raise ValueError('函数体不以 end 结束')
    return out


def mk_bump(g):
    """global.get g; i32.const 1; i32.add; global.set g"""
    return b'\x23' + uleb_enc(g) + b'\x41\x01\x6a' + b'\x24' + uleb_enc(g)


# ------------------------------------------------------------------ 打补丁
class Module:
    def __init__(self, path):
        self.path = path
        self.secs = parse_sections(open(path, 'rb').read())

    def sec_index(self, sid):
        for i, (s, _) in enumerate(self.secs):
            if s == sid:
                return i
        return None

    # --- import 段：统计导入的 func / global 数量
    def import_counts(self):
        i = self.sec_index(2)
        if i is None:
            return 0, 0
        buf = self.secs[i][1]
        n, p = uleb(buf, 0)
        nf = ng = 0
        for _ in range(n):
            ln, p = uleb(buf, p); p += ln
            ln, p = uleb(buf, p); p += ln
            kind = buf[p]; p += 1
            if kind == 0:
                _, p = uleb(buf, p); nf += 1
            elif kind == 1:
                p += 1
                fl = buf[p]; p += 1
                _, p = uleb(buf, p)
                if fl:
                    _, p = uleb(buf, p)
            elif kind == 2:
                fl = buf[p]; p += 1
                _, p = uleb(buf, p)
                if fl:
                    _, p = uleb(buf, p)
            elif kind == 3:
                p += 2; ng += 1
            else:
                raise ValueError('未知 import kind %d' % kind)
        return nf, ng

    def defined_globals(self):
        i = self.sec_index(6)
        if i is None:
            return 0
        n, _ = uleb(self.secs[i][1], 0)
        return n

    def add_globals(self, names):
        nf, ng = self.import_counts()
        base = ng + self.defined_globals()
        idxs = list(range(base, base + len(names)))
        blob = b''.join(b'\x7f\x01\x41\x00\x0b' for _ in names)
        i = self.sec_index(6)
        if i is None:
            # 按 section id 顺序插入：放在第一个 id > 6 的段之前
            pos = len(self.secs)
            for k, (sid, _) in enumerate(self.secs):
                if sid > 6:
                    pos = k
                    break
            self.secs.insert(pos, [6, uleb_enc(len(names)) + blob])
        else:
            old = self.secs[i][1]
            n, p = uleb(old, 0)
            self.secs[i][1] = uleb_enc(n + len(names)) + old[p:] + blob
        return idxs

    def add_exports(self, entries):
        extra = b''.join(uleb_enc(len(nm.encode())) + nm.encode() + b'\x03' + uleb_enc(g)
                         for nm, g in entries)
        i = self.sec_index(7)
        if i is None:
            pos = len(self.secs)
            for k, (sid, _) in enumerate(self.secs):
                if sid > 7:
                    pos = k
                    break
            self.secs.insert(pos, [7, uleb_enc(len(entries)) + extra])
        else:
            old = self.secs[i][1]
            n, p = uleb(old, 0)
            self.secs[i][1] = uleb_enc(n + len(entries)) + old[p:] + extra

    # --- code 段
    def body_ranges(self):
        i = self.sec_index(10)
        buf = self.secs[i][1]
        n, p = uleb(buf, 0)
        out = []
        for _ in range(n):
            size, p2 = uleb(buf, p)
            out.append((p2, p2 + size))
            p = p2 + size
        return buf, out

    @staticmethod
    def locals_end(body):
        n, p = uleb(body, 0)
        for _ in range(n):
            _, p = uleb(body, p)
            p += 1
        return p

    def rebuild_code(self, repl):
        i = self.sec_index(10)
        buf, ranges = self.body_ranges()
        out = bytearray(uleb_enc(len(ranges)))
        for k, (s, e) in enumerate(ranges):
            body = repl[k] if k in repl else buf[s:e]
            out += uleb_enc(len(body)) + body
        self.secs[i][1] = bytes(out)

    def write(self):
        data = emit(self.secs)
        open(self.path, 'wb').write(data)
        return len(data)


def instrument(path, plan, tag, branches=None, points=None):
    """plan: [(label, 模块函数索引, want_returns)]
    branches: {模块函数索引: [(原偏移, 标签)]}  —— br_if 改写为 if(bump; br L+1) end
    points:   {模块函数索引: [(原偏移, 标签)]}  —— 在该指令前打点计数
    """
    branches = branches or {}
    points = points or {}
    m = Module(path)
    buf, ranges = m.body_ranges()
    n_imp, _ = m.import_counts()

    names = []
    entries = []          # (label, bi, ret_idx, nsites)
    for label, midx, want_ret in plan:
        bi = midx - n_imp
        if not (0 <= bi < len(ranges)):
            raise ValueError('%s::%s 函数索引 %d 越界（import %d，bodies %d）'
                             % (tag, label, midx, n_imp, len(ranges)))
        s, e = ranges[bi]
        body = buf[s:e]
        le = m.locals_end(body)
        sites = [o for (o, op) in decode(body[le:]) if op == 0x0f]
        names.append('%s_%s_in' % (tag, label))
        ret_idx = []
        if want_ret:
            for k in range(len(sites)):
                names.append('%s_%s_r%d' % (tag, label, k + 1))
                ret_idx.append(k)
            names.append('%s_%s_end' % (tag, label))
        entries.append((label, bi, ret_idx, len(sites)))

    # 分支 / 打点计数器
    site_names = {}
    for midx, lst in branches.items():
        for off, label in lst:
            nm = '%s_BR_%s' % (tag, label)
            names.append(nm)
            site_names[(midx, off)] = nm
    for midx, lst in points.items():
        for off, label in lst:
            nm = '%s_PT_%s' % (tag, label)
            names.append(nm)
            site_names[(midx, off)] = nm

    idxs = m.add_globals(names)
    m.add_exports([(n, g) for n, g in zip(names, idxs)])
    gmap = dict(zip(names, idxs))

    # 统一按「原偏移」建 prefix / replace，每个 body 只改写一次
    prefix_all, replace_all = {}, {}

    for label, bi, ret_idx, nsites in entries:
        s, e = ranges[bi]
        body = buf[s:e]
        le = m.locals_end(body)
        code = body[le:]
        sites = [o for (o, op) in decode(code) if op == 0x0f]
        end_off = len(code) - 1
        pf = prefix_all.setdefault(bi, {})
        pf[0] = pf.get(0, b'') + mk_bump(gmap['%s_%s_in' % (tag, label)])
        for k in ret_idx:
            if k < len(sites):
                g = gmap['%s_%s_r%d' % (tag, label, k + 1)]
                pf[sites[k]] = pf.get(sites[k], b'') + mk_bump(g)
        if ret_idx:
            g = gmap['%s_%s_end' % (tag, label)]
            pf[end_off] = pf.get(end_off, b'') + mk_bump(g)

    for midx in set(list(branches.keys()) + list(points.keys())):
        bi = midx - n_imp
        s, e = ranges[bi]
        body = buf[s:e]
        le = m.locals_end(body)
        code = body[le:]
        pf = prefix_all.setdefault(bi, {})
        rp = replace_all.setdefault(bi, {})
        for off, label in branches.get(midx, []):
            nm = site_names[(midx, off)]
            L, p2 = uleb(code, off + 1)
            assert code[off] == 0x0d, 'branch site 0x%x 不是 br_if' % off
            rp[off] = (b'\x04\x40' + mk_bump(gmap[nm]) +
                       b'\x0c' + uleb_enc(L + 1) + b'\x0b', p2 - off)
        for off, label in points.get(midx, []):
            nm = site_names[(midx, off)]
            pf[off] = pf.get(off, b'') + mk_bump(gmap[nm])

    repl = {}
    report = []
    for bi, pf in prefix_all.items():
        s, e = ranges[bi]
        body = buf[s:e]
        le = m.locals_end(body)
        head, code = body[:le], body[le:]
        new_body = head + rewrite(code, pf, replace_all.get(bi, {}))
        repl[bi] = new_body
        report.append((bi, len(body), len(new_body),
                       len(replace_all.get(bi, {})), sum(1 for k in pf if k > 0)))

    m.rebuild_code(repl)
    size = m.write()
    return report, size, names


def rewrite(code, prefix, replace):
    """按原字节偏移插入 prefix / 用 replace 替换指定偏移处的指令"""
    out = bytearray()
    i = 0
    n = len(code)
    while True:
        if i in prefix:
            out += prefix[i]
        if i >= n:
            break
        if i in replace:
            blob, consumed = replace[i]
            out += blob
            i += consumed
            continue
        out.append(code[i])
        i += 1
    return bytes(out)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'status'

    if mode == 'status':
        for p in (MAIN, SPLIT):
            mk = p + MARK
            cur = os.path.getsize(p) if os.path.exists(p) else -1
            bak = os.path.getsize(mk) if os.path.exists(mk) else -1
            print('%-40s 当前=%d 原始=%d %s' % (
                os.path.basename(p), cur, bak,
                '【已打桩】' if bak >= 0 and cur != bak else '（未打桩）'))
        return

    if mode == 'restore':
        for p in (MAIN, SPLIT):
            mk = p + MARK
            if os.path.exists(mk):
                shutil.copyfile(mk, p)
                print('已还原', os.path.basename(p), os.path.getsize(p))
            else:
                print('无备份，跳过', os.path.basename(p))
        return

    if mode == 'install':
        for p in (MAIN, SPLIT):
            mk = p + MARK
            if not os.path.exists(mk):
                shutil.copyfile(p, mk)
                print('备份 →', os.path.basename(mk), os.path.getsize(mk))
            else:
                shutil.copyfile(mk, p)      # 保证从干净原件开始
        all_names = []
        for path, plan, tag, br, pt in (
                (MAIN, PROBE_MAIN, 'main', BRANCH_SITES, POINT_SITES),
                (SPLIT, PROBE_SPLIT, 'split', {}, {})):
            rep, size, names = instrument(path, plan, tag, br, pt)
            all_names += names
            print('\n== %s -> %d 字节（%d 个计数器）' % (os.path.basename(path), size, len(names)))
            for bi, old, new, nbr, npt in rep:
                print('   body#%-6d %5dB -> %5dB  分支改写 %d  打点 %d' % (bi, old, new, nbr, npt))
        out = os.path.join(ROOT, '.workbuddy', 'probe-markers.json')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        json.dump(all_names, open(out, 'w'), indent=1)
        print('\n计数器清单 →', out)
        print('共 %d 个：%s' % (len(all_names), ', '.join(all_names)))
        return

    print('未知模式', mode)


if __name__ == '__main__':
    main()
