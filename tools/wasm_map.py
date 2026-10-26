#!/usr/bin/env python3
"""il2cpp wasm 映射：方法 token → wasm 函数索引。
原理：
  1. 从 wasm 数据段重建线性内存镜像，找 "Assembly-CSharp.dll" 字符串地址；
  2. 在数据段里找指向该地址的 Il2CppCodeGenModule 结构，取 methodPointers 数组；
  3. methodPointer 是 indirect table 索引，用 elem 段（section 9）还原为 wasm 函数索引。
"""
import struct, sys, json
sys.path.insert(0, 'tools')
from il2cpp_meta import D as META, TD_OFF, TD_STRIDE, M_OFF, M_STRIDE, TD_COUNT, cstr, mname, mtoken, tname, tmethods, img_of_type, img_name

WASM = open('web/assets/wasmcode_decompressed.wasm', 'rb').read()


def uleb(b, p):
    r = 0; s = 0
    while True:
        x = b[p]; p += 1
        r |= (x & 0x7f) << s; s += 7
        if not x & 0x80:
            break
    return r, p


# ---- 枚举段 ----
p = 8
sections = {}
while p < len(WASM):
    sid = WASM[p]; p += 1
    size, p2 = uleb(WASM, p)
    sections.setdefault(sid, []).append((p2, p2 + size))
    p = p2 + size

# ---- 数据段 → 内存镜像（稀疏，洞补 0：wasm-ld 把全 0 区留成 BSS 洞）----
segs = []
for (s, e) in sections.get(11, []):
    q = s
    n, q = uleb(WASM, q)
    for _ in range(n):
        flags, q = uleb(WASM, q)          # 0 = active
        assert WASM[q] == 0x41, hex(WASM[q])
        off, q = uleb(WASM, q + 1)
        assert WASM[q] == 0x0B, hex(WASM[q])
        q += 1
        sz, q = uleb(WASM, q)
        segs.append((off, sz, q))
        q += sz
segs.sort()


def seg_for(addr):
    import bisect
    i = bisect.bisect_right(segs, (addr, 1 << 60, 1 << 60)) - 1
    if i >= 0:
        off, sz, fo = segs[i]
        if off <= addr < off + sz:
            return off, sz, fo
    return None


def mem_read(addr, ln):
    out = bytearray()
    while ln > 0:
        sg = seg_for(addr)
        if sg is None:
            out.append(0)          # BSS 洞 = 0
            addr += 1
            ln -= 1
            continue
        off, sz, fo = sg
        take = min(ln, off + sz - addr)
        out += WASM[fo + (addr - off): fo + (addr - off) + take]
        addr += take
        ln -= take
    return bytes(out)


def find_string(s):
    tgt = s.encode() + b'\x00'
    for (off, sz, fo) in segs:
        i = WASM.find(tgt, fo, fo + sz)
        if i >= 0:
            return off + (i - fo)
    return None


def u32a(addr, count):
    b = mem_read(addr, count * 4)
    return list(struct.unpack('<' + 'I' * count, b)) if b else None


# ---- 找 CodeGenModule ----
STR = 'Assembly-CSharp.dll'
saddr = find_string(STR)
print('string addr', hex(saddr) if saddr else None)
if not saddr:
    sys.exit(1)

# 扫描整个数据镜像找 u32 == saddr（允许结构跨段：读松散校验）
module = None
scan_lo = segs[0][0]
scan_hi = segs[-1][0] + segs[-1][1]
buf = mem_read(scan_lo, scan_hi - scan_lo)
tgt = struct.pack('<I', saddr)
i = buf.find(tgt)
while i >= 0:
    addr = scan_lo + i
    count = struct.unpack_from('<I', buf, i + 4)[0]
    ptr = struct.unpack_from('<I', buf, i + 8)[0]
    if 1000 < count < 200000:
        print(f'candidate module @ {hex(addr)} count={count} ptr={hex(ptr)}')
        module = (addr, count, ptr)
    i = buf.find(tgt, i + 1)

if not module:
    print('未找到 Assembly-CSharp.dll 的 CodeGenModule')
    sys.exit(1)

addr, count, ptr = module
ptrs = u32a(ptr, count)
print('methodPointers[0:12] =', ptrs[:12])
print('min/max =', min(ptrs), max(ptrs))

# ---- elem 段还原 table→(module, local func idx) ----
def parse_elems(path, label):
    B = open(path, 'rb').read()
    p = 8
    out = {}
    stats = {}
    while p < len(B):
        sid = B[p]; p += 1
        size, p2 = uleb(B, p)
        if sid == 9:
            q = p2
            n, q = uleb(B, q)
            for _ in range(n):
                flags, q = uleb(B, q)
                stats[flags] = stats.get(flags, 0) + 1
                if flags in (0, 2, 4):          # active
                    if flags != 0:
                        _ti, q = uleb(B, q)     # table index
                    assert B[q] == 0x41, hex(B[q])
                    off, q = uleb(B, q + 1)
                    assert B[q] == 0x0B
                    q += 1
                    if flags != 0:
                        ek, q = uleb(B, q)      # flags2/4 带 elemkind/reftype
                    cnt, q = uleb(B, q)
                    for k in range(cnt):
                        fi, q = uleb(B, q)
                        out[off + k] = fi
                elif flags in (1, 3, 5, 6, 7):  # passive / declarative：无法静态定位
                    if flags in (1, 3):
                        _ek, q = uleb(B, q)
                    elif flags in (6, 7):
                        _ti, q = uleb(B, q)
                        if flags == 7:
                            _off, q = uleb(B, q + 1)
                    _et, q = uleb(B, q)
                    cnt, q = uleb(B, q)
                    for k in range(cnt):
                        if flags in (5, 6, 7):
                            # ref expr：跳到 end
                            while B[q] != 0x0B:
                                q += 1
                            q += 1
                        else:
                            _fi, q = uleb(B, q)
                else:
                    print(label, 'unknown elem flags', flags)
                    break
        p = p2 + size
    print(label, 'table entries:', len(out), 'flags:', stats)
    return out


table_map1 = parse_elems('web/assets/wasmcode_decompressed.wasm', 'main')
table_map2 = parse_elems('web/assets/wasmcode1_decompressed.wasm', 'split')

# ---- 方法查询 ----
def func_of_token(token):
    """返回 {'module':'main'|'split', 'local':局部函数索引, 'table':表索引}"""
    rid = token & 0xFFFFFF
    if rid - 1 >= count:
        return None
    t = ptrs[rid - 1]
    if t in table_map1:
        return {'module': 'main', 'local': table_map1[t], 'table': t}
    if t in table_map2:
        return {'module': 'split', 'local': table_map2[t], 'table': t}
    return {'module': None, 'local': None, 'table': t}


def find_methods(pred, limit=40):
    out = []
    for ti in range(TD_COUNT):
        ni = struct.unpack_from('<i', META, TD_OFF + ti * TD_STRIDE)[0]
        # 快速过滤：先看类型名包含 League/Tutorial
        tn = tname(ti)
        if not pred[0](tn):
            continue
        ms, mc = tmethods(ti)
        for mi in range(ms, ms + min(mc, 4000)):
            if pred[1](mname(mi)):
                out.append((tn, mname(mi), mtoken(mi)))
                if len(out) >= limit:
                    return out
    return out


if __name__ == '__main__':
    wants = ['BeginLeagueUnlockedTutorial', 'AreLeaguesUnlocked', 'TryShowLeaguePopup',
             'SetLeagueUnlocked', 'LeaguePopupRoutine', 'ShowLeagueTutorialInfo']
    res = find_methods((lambda tn: True, lambda mn: mn in wants))
    for tn, mn, tok in res:
        f = func_of_token(tok)
        print(f'{tn}::{mn} token=0x{tok:08x} -> {f}')


# ---- 按 程序集(CodeGenModule) 解析 token → 表索引 ----
def find_codegen_module(module_name):
    saddr = find_string(module_name)
    if saddr is None:
        return None
    buf = mem_read(scan_lo, scan_hi - scan_lo)
    tgt = struct.pack('<I', saddr)
    i = buf.find(tgt)
    while i >= 0:
        count = struct.unpack_from('<I', buf, i + 4)[0]
        ptr = struct.unpack_from('<I', buf, i + 8)[0]
        if 0 < count < 200000:
            return (count, ptr)
        i = buf.find(tgt, i + 1)
    return None


_module_cache = {}


def module_ptrs(image_name):
    if image_name in _module_cache:
        return _module_cache[image_name]
    r = find_codegen_module(image_name)
    res = None
    if r:
        cnt, ptr = r
        b = mem_read(ptr, cnt * 4)
        res = list(struct.unpack('<' + 'I' * cnt, b)) if b else None
    _module_cache[image_name] = res
    return res


def resolve(type_name, method_name=None):
    """按类型(可选方法)解析 → 列表[{type,method,token,image,table,module,local}]"""
    out = []
    for ti in range(TD_COUNT):
        tn = tname(ti)
        if tn != type_name:
            continue
        ii = img_of_type(ti)
        if ii < 0:
            continue
        image = img_name(ii)
        ptrs = module_ptrs(image)
        ms, mc = tmethods(ti)
        for mi in range(ms, ms + mc):
            mn = mname(mi)
            if method_name and mn != method_name:
                continue
            tok = mtoken(mi)
            rid = tok & 0xFFFFFF
            e = {'type': tn, 'method': mn, 'token': tok, 'image': image}
            if ptrs and 1 <= rid <= len(ptrs):
                e['table'] = ptrs[rid - 1]
                t = e['table']
                if t in table_map1:
                    e.update(module='main', local=table_map1[t])
                elif t in table_map2:
                    e.update(module='split', local=table_map2[t])
            out.append(e)
    return out
