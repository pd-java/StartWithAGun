#!/usr/bin/env python3
"""il2cpp wasm 方法级补丁：按「命名空间.类型::方法名」把函数体替换为立即返回。

用法：
  python tools/wasm_patch_method.py list "Type::Method" ...    # 查看签名
  python tools/wasm_patch_method.py patch "Type::Method" ...   # 打补丁（自动备份 .bak-method）
"""
import struct, sys, os, shutil

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wasm_map as WM

WASM_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         'web', 'assets', 'wasmcode_decompressed.wasm')


def uleb(b, p):
    r = 0; s = 0
    while True:
        x = b[p]; p += 1
        r |= (x & 0x7f) << s; s += 7
        if not x & 0x80:
            break
    return r, p


def uleb_enc(v):
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


class Wasm:
    def __init__(self, raw):
        self.raw = raw
        d = raw
        assert d[:4] == b'\x00asm'
        p = 8
        self.sections = []
        while p < len(d):
            sid = d[p]; p += 1
            size, p2 = uleb(d, p)
            self.sections.append((sid, d[p2:p2 + size]))
            p = p2 + size

    def section(self, sid):
        for s, pl in self.sections:
            if s == sid:
                return pl
        return None

    def count_func_imports(self):
        """统计 import 段里 func 类型条目数（它们占据模块函数索引空间 0..n-1）。

        ⚠️ 关键：elem 段里的函数索引是「模块索引空间」（import 在前），
        而 code 段下标 = 模块索引 - import 数。曾因漏掉这一步把补丁
        打到 +890 偏移的错误函数上（2026-10-18 修正）。
        """
        sec = self.section(2)
        if sec is None:
            return 0
        q = 0
        n, q = uleb(sec, q)
        n_fn = 0
        for _ in range(n):
            ln, q = uleb(sec, q); q += ln      # module name
            ln, q = uleb(sec, q); q += ln      # field name
            kind = sec[q]; q += 1
            if kind == 0:                      # func
                _, q = uleb(sec, q)
                n_fn += 1
            elif kind == 1:                    # table
                q += 1                         # reftype
                flags = sec[q]; q += 1
                _, q = uleb(sec, q)
                if flags:
                    _, q = uleb(sec, q)
            elif kind == 2:                    # memory
                flags = sec[q]; q += 1
                _, q = uleb(sec, q)
                if flags:
                    _, q = uleb(sec, q)
            elif kind == 3:                    # global
                q += 2
        return n_fn

    def load(self):
        self.n_imports = self.count_func_imports()
        # 类型
        sec = self.section(1); q = 0
        n, q = uleb(sec, q)
        self.types = []
        for _ in range(n):
            q += 1                       # 0x60
            np, q = uleb(sec, q)
            params = sec[q:q + np]; q += np
            nr, q = uleb(sec, q)
            rets = sec[q:q + nr]; q += nr
            self.types.append((params, rets))
        # 函数→类型索引
        sec = self.section(3); q = 0
        n, q = uleb(sec, q)
        self.func_types = []
        for _ in range(n):
            ti, q = uleb(sec, q)
            self.func_types.append(ti)
        # 函数体
        sec = self.section(10); q = 0
        n, q = uleb(sec, q)
        self.bodies = []
        for _ in range(n):
            s_start = q
            size, q2 = uleb(sec, q)
            self.bodies.append((s_start, size, q2, q2 + size))
            q = q2 + size
        assert q == len(sec)

    def body(self, li):
        _, _, s, e = self.bodies[li]
        return self.section(10)[s:e]

    def rebuild(self, patches):
        """patches: {local_idx: new_body}"""
        old = self.section(10)
        q = 0
        n, q = uleb(old, q)
        pl = bytearray(uleb_enc(n))
        for i in range(n):
            _, _, s, e = self.bodies[i]
            body = patches[i] if i in patches else old[s:e]
            pl += uleb_enc(len(body)) + body
        out = bytearray(self.raw[:8])        # magic + version
        p = 8
        d = self.raw
        while p < len(d):
            sid = d[p]; p += 1
            size, p2 = uleb(d, p)
            payload = bytes(pl) if sid == 10 else d[p2:p2 + size]
            out.append(sid)
            out += uleb_enc(len(payload))
            out += payload
            p = p2 + size
        return bytes(out)


ZERO_CONST = {0x7f: b'\x41\x00', 0x7e: b'\x42\x00', 0x7d: b'\x43\x00\x00\x00\x00',
              0x7c: b'\x42\x00', 0x70: b'\xd0\x70'}


def empty_body(rets):
    if not rets:
        return b'\x00\x0b'
    if len(rets) == 1 and rets[0] in ZERO_CONST:
        return b'\x00' + ZERO_CONST[rets[0]] + b'\x0b'
    return None


def main():
    mode = sys.argv[1]
    targets = sys.argv[2:]
    w = Wasm(open(WASM_PATH, 'rb').read())
    w.load()
    print(f'函数体 {len(w.bodies)} 个，类型 {len(w.types)} 个')

    patches = {}
    for t in targets:
        tn, mn = t.split('::', 1)
        res = WM.resolve(tn, mn)
        if not res:
            print(f'⚠️ 未找到 {t}')
            continue
        for e in res:
            if e.get('module') != 'main':
                print(f"⚠️ {t} 不在主模块：{e}")
                continue
            # e['local'] 是 elem 段函数索引 = 模块索引空间（含 import 偏移）
            li = e['local'] - w.n_imports
            params, rets = w.types[w.func_types[li]]
            body = w.body(li)
            nb = empty_body(rets)
            print(f"{tn}::{mn} token=0x{e['token']:08x} 模块索引={e['local']} body下标={li} "
                  f"params={params.hex()} rets={rets.hex()} bodyLen={len(body)} -> {len(nb) if nb else '?'}B")
            print('   head:', body[:20].hex())
            if mode == 'patch':
                if nb is None:
                    print('   ⚠️ 返回类型不支持，跳过')
                    continue
                patches[li] = nb

    if mode == 'patch' and patches:
        out = w.rebuild(patches)
        bak = WASM_PATH + '.bak-method'
        if not os.path.exists(bak):
            shutil.copyfile(WASM_PATH, bak)
            print('备份 →', bak)
        open(WASM_PATH, 'wb').write(out)
        print(f'✅ 写出 {WASM_PATH} {len(out)}B（补丁 {len(patches)} 个函数）')
        # 校验：重新解析
        w2 = Wasm(open(WASM_PATH, 'rb').read())
        w2.load()
        assert len(w2.bodies) == len(w.bodies), '函数体数量变化！'
        print('校验通过：函数体数量一致 =', len(w2.bodies))


if __name__ == '__main__':
    main()
