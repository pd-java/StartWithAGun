#!/usr/bin/env python3
"""download-missing-bundles.py —— 按 catalog.json 补齐缺失的 Addressables bundle"""
import re, os, sys, time, urllib.request, concurrent.futures

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG = os.path.join(ROOT, 'web/assets/StreamingAssets/aa/catalog.json')
DEST = os.path.join(ROOT, 'web/assets/StreamingAssets/aa/WebGL')
BASE = 'https://voodoo.ali.landintheair.com/SniperSiege/wx/20260929-204718/StreamingAssets/aa/WebGL/'

d = open(CATALOG, encoding='utf8').read()
cat = set(re.findall(r'RuntimePath\}/WebGL/([a-z0-9()\[\]\-\._]+\.bundle)', d))
local = set(os.listdir(DEST))
missing = sorted(cat - local)
print('缺失 %d 个' % len(missing), flush=True)

# 先统计总大小
def head_size(name):
    try:
        req = urllib.request.Request(BASE + name, method='HEAD')
        with urllib.request.urlopen(req, timeout=30) as r:
            return int(r.headers.get('Content-Length', 0))
    except Exception:
        return -1

ok, fail = 0, []
total = 0
t0 = time.time()

def dl(name):
    global ok, total
    dest = os.path.join(DEST, name)
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return True
    try:
        for attempt in range(3):
            try:
                urllib.request.urlretrieve(BASE + name, dest + '.part')
                os.replace(dest + '.part', dest)
                total += os.path.getsize(dest)
                return True
            except Exception as e:
                if attempt == 2:
                    raise
                time.sleep(2)
    except Exception as e:
        print('FAIL', name, e, flush=True)
        return False

with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
    for i, r in enumerate(ex.map(dl, missing)):
        if r is True or r is False:
            pass
        if r:
            ok += 1
        else:
            fail.append(missing[i])
        if (i + 1) % 25 == 0:
            print('%d/%d ok=%d 失败=%d 已下载 %.1fMB %.0fs' % (i + 1, len(missing), ok, len(fail), total / 1048576, time.time() - t0), flush=True)

print('完成 ok=%d 失败=%d 总 %.1fMB' % (ok, len(fail), total / 1048576), flush=True)
if fail:
    print('失败清单:', file=sys.stderr)
    for f in fail:
        print(' ', f, file=sys.stderr)
