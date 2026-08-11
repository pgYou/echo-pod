#!/usr/bin/env python3
"""
录音豆时间同步工具（方案 B：USB 串口校时）
============================================================
用法：
    python sync_time.py [串口] [波特率]

默认：/dev/cu.usbmodem1101  115200

原理：读取电脑当前 Unix 时间戳（UTC 秒），发 "SETTIME:<秒>\\n" 给板子，
板子 TimeSync 模块解析后 settimeofday 校准 RTC。

依赖：pip install pyserial
"""
import sys
import time

try:
    import serial
except ImportError:
    print("缺少 pyserial，请先安装：pip install pyserial")
    sys.exit(1)

PORT = sys.argv[1] if len(sys.argv) > 1 else "/dev/cu.usbmodem1101"
BAUD = int(sys.argv[2]) if len(sys.argv) > 2 else 115200

with serial.Serial(PORT, BAUD, timeout=1) as s:
    # 给板子一点时间响应（串口打开可能触发 DTR 复位）
    time.sleep(0.5)

    ts = int(time.time())
    cmd = f"SETTIME:{ts}\n"
    s.write(cmd.encode())
    local_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts))
    print(f"已发送：{cmd.strip()}  ({local_str} 本地时间)")

    # 等板子回执（TimeSync 同步成功会打印 "OK 时间已同步：..."）
    time.sleep(0.3)
    while s.in_waiting:
        line = s.readline().decode(errors="replace").rstrip()
        if line:
            print(f"板子回执：{line}")
