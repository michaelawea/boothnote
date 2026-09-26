# test_example 测试资料说明

本目录保存 CRM Agent 的真实业务场景测试资料。用例用于推动数据模型、Agent 和文档能力完善，不以当前实现为边界。

## 目录结构

```text
test_example/
├── README.md
├── test_example.md
├── attachments/
│   ├── T02_Havel_150Ah_CI-Bus_产品需求规格书.md
│   └── T04_Havel_CI-Bus_技术支持需求单.md
└── expected_outputs/
    ├── T03_Havel_口述需求整理_期望文档.md
    ├── T04_VLB12150-CIBUS_通信端口与Pin定义_期望文档.md
    ├── T04_VLB12150-CIBUS_协议说明_期望文档.md
    ├── T04_VLB12150-CIBUS_测试代码_期望.py
    └── T05_Havel_CI-Bus_口述技术需求记录_期望文档.md
```

## 文件用途

- `test_example.md`：测试步骤、输入、期望动作、期望数据和验收断言。
- `attachments/`：测试“有文档”场景时应实际上传的模拟客户文件。
- `expected_outputs/`：Agent 应生成或后续技术线程应交付的参考文件。它们是验收样例，不能作为输入附件上传。

## 建议执行顺序

按 `T01 → T02 → T03 → T04 → T05` 执行，可以覆盖从商机到项目，再到项目技术跟进的完整链路。单独执行某个用例时，应先满足该用例列出的前置条件，并清理可能冲突的同编号测试数据。

## 数据声明

本目录内的公司业务信息、型号、金额、日期、接口定义和报文参数均为虚构测试数据，仅供开发与调试使用。
