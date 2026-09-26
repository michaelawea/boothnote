# VLB12150-CIBUS 通信协议说明（测试版）

| 文档属性 | 内容 |
|---|---|
| 文档编号 | VLB12150-CIBUS-SW-001 |
| 文档版本 | v0.1-test |
| 适用固件 | TEST-FW-0.9.3 |
| 对应任务 | HYM-CIBUS-03 |
| 文档状态 | 测试参考，未经过产品验证 |
| 数据性质 | 完全虚构，仅供 CRM 与 Agent 测试 |

> 本协议中的报文 ID、缩放值和状态位均为虚构数据，不能用于真实设备开发。

## 1. 总线参数

| 参数 | 测试值 |
|---|---|
| 物理层 | CAN 2.0A |
| 标识符 | 11-bit 标准帧 |
| 波特率 | 500 kbit/s |
| 字节序 | Little-endian |
| 电池节点角色 | 周期发送节点 |
| 通信超时 | 连续 3 秒未收到周期帧时判定超时 |

## 2. 周期报文

| 报文 ID | 名称 | 方向 | 周期 | DLC |
|---|---|---|---|---|
| `0x351` | Battery Status 1 | 电池 → 车辆 | 100ms | 8 |
| `0x355` | Battery Status 2 | 电池 → 车辆 | 1s | 8 |

## 3. 报文 `0x351`：Battery Status 1

| Byte | 信号 | 类型 | 缩放 | 单位 | 说明 |
|---|---|---|---|---|---|
| 0–1 | PackVoltage | uint16 LE | 0.01 | V | 电池包总电压 |
| 2–3 | PackCurrent | int16 LE | 0.1 | A | 正值放电，负值充电 |
| 4 | SOC | uint8 | 0.5 | % | 范围 0～100% |
| 5 | SOH | uint8 | 0.5 | % | 范围 0～100% |
| 6 | AlarmFlags | bitfield | 1 | — | 见告警位定义 |
| 7 | RollingCounter | uint8 | 1 | — | 0～255 循环计数 |

### AlarmFlags

| Bit | 名称 | 值为 1 时 |
|---|---|---|
| 0 | OverVoltage | 过压告警 |
| 1 | UnderVoltage | 欠压告警 |
| 2 | OverTemperature | 过温告警 |
| 3 | UnderTemperature | 低温告警 |
| 4 | OverCurrent | 过流告警 |
| 5 | CommunicationFault | 内部通信异常 |
| 6 | CellImbalance | 单体压差异常 |
| 7 | Reserved | 保留，不应作为故障判断依据 |

## 4. 报文 `0x355`：Battery Status 2

| Byte | 信号 | 类型 | 缩放 | 单位 | 说明 |
|---|---|---|---|---|---|
| 0–1 | RemainingCapacity | uint16 LE | 0.1 | Ah | 剩余容量 |
| 2–3 | FullCapacity | uint16 LE | 0.1 | Ah | 当前满充容量 |
| 4 | MaxTemperature | int8 | 1，偏移 -40 | °C | 原始值减 40 |
| 5 | MinTemperature | int8 | 1，偏移 -40 | °C | 原始值减 40 |
| 6 | ChargeAllowed | uint8 | 1 | bool | `1` 允许充电 |
| 7 | DischargeAllowed | uint8 | 1 | bool | `1` 允许放电 |

## 5. 示例解析

示例帧：

```text
ID=0x351 DLC=8 DATA=00 05 9C FF A0 BE 00 2A
```

按本文测试定义解析：

- PackVoltage：`0x0500 × 0.01 = 12.80V`；
- PackCurrent：`0xFF9C = -100`，`-100 × 0.1 = -10.0A`；
- SOC：`0xA0 × 0.5 = 80.0%`；
- SOH：`0xBE × 0.5 = 95.0%`；
- AlarmFlags：`0x00`，无告警；
- RollingCounter：`0x2A = 42`。

## 6. 异常与恢复

- 接收端连续 3 秒未观察到 `0x351` 时，记录通信超时；
- 恢复收到连续 3 帧有效 `0x351` 后，可清除通信超时；
- 保留位不得用于推导故障；
- 对超过物理范围的解析值，应保留原始帧并标记为协议或版本不匹配，不应直接判定电池损坏。

## 7. 待正式确认

- 报文 ID 与 CI-Bus 正式分配是否一致；
- 电流正负方向；
- 温度字段的有符号类型与偏移规则；
- 超时与恢复条件；
- 协议版本与样品固件的对应关系；
- DBC 文件的正式交付方式。

