#!/usr/bin/env python3
"""检查表槽位是否被 split 模块覆盖（决定真实实现到底在哪）。"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.getcwd())
import wasm_map as WM

T = [('Shoot', 23812), ('ShootAsync', 23813), ('ShootRoutine', 6762),
     ('Update', 23807), ('LateUpdate', 23809), ('FixedUpdate', 23808),
     ('AllowAimingCheck', 23806), ('TouchPosition', 23801),
     ('ObjectUnderPointer', 23803), ('CalculateSwayOffset', 23811),
     ('ClampAimingDirection', 23814), ('SetZoomPercent', 23800),
     ('IsPointerOverUI', 23802), ('UsingZoomSliderCheck', 23804),
     ('IsSettingsOpen', 23805), ('Awake', 23795), ('OnReset', 23799),
     ('get_ZoomPercent', 23787), ('get_AimingDirection', 23794)]

for name, t in T:
    m1 = WM.table_map1.get(t)
    m2 = WM.table_map2.get(t)
    live = 'split' if (m2 is not None) else 'main'
    print(f'{name:<26} table={t:<7} main_local={m1} split_local={m2}  live={live}')
