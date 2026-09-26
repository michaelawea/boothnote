"""VLB12150-CIBUS 虚构协议的最小 SocketCAN 读取示例。

仅用于 CRM/Agent 测试资料，不得连接真实产品或作为量产代码使用。
依赖：python-can>=4.4
运行：python T04_VLB12150-CIBUS_测试代码_期望.py --channel can0
"""

from __future__ import annotations

import argparse
import struct
from datetime import datetime, timezone

import can


def parse_status_351(data: bytes) -> dict[str, object]:
    """按虚构的 v0.1-test 协议解析 0x351。"""
    if len(data) != 8:
        raise ValueError(f"0x351 期望 8 bytes，实际收到 {len(data)} bytes")

    voltage_raw, current_raw = struct.unpack_from("<Hh", data, 0)
    alarm_raw = data[6]
    return {
        "pack_voltage_v": voltage_raw * 0.01,
        "pack_current_a": current_raw * 0.1,
        "soc_pct": data[4] * 0.5,
        "soh_pct": data[5] * 0.5,
        "alarms": {
            "over_voltage": bool(alarm_raw & 0x01),
            "under_voltage": bool(alarm_raw & 0x02),
            "over_temperature": bool(alarm_raw & 0x04),
            "under_temperature": bool(alarm_raw & 0x08),
            "over_current": bool(alarm_raw & 0x10),
            "communication_fault": bool(alarm_raw & 0x20),
            "cell_imbalance": bool(alarm_raw & 0x40),
        },
        "rolling_counter": data[7],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="监听虚构的 VLB12150 CI-Bus 测试帧")
    parser.add_argument("--channel", default="can0", help="SocketCAN 通道，默认 can0")
    parser.add_argument("--timeout", type=float, default=3.0, help="接收超时秒数")
    args = parser.parse_args()

    with can.Bus(interface="socketcan", channel=args.channel, bitrate=500_000) as bus:
        print(f"Listening on {args.channel} at 500 kbit/s; Ctrl+C to stop")
        while True:
            message = bus.recv(timeout=args.timeout)
            now = datetime.now(timezone.utc).isoformat()
            if message is None:
                print(f"{now} timeout: no CAN frame received in {args.timeout:.1f}s")
                continue

            payload = bytes(message.data)
            print(
                f"{now} id=0x{message.arbitration_id:03X} "
                f"dlc={message.dlc} data={payload.hex(' ').upper()}"
            )
            if message.arbitration_id == 0x351:
                try:
                    print(parse_status_351(payload))
                except ValueError as error:
                    print(f"parse error: {error}")


if __name__ == "__main__":
    main()
