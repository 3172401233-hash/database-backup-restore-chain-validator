# database-backup-restore-chain-validator

备份恢复链验证器:读取备份清单(manifest)与校验摘要,计算哪些恢复点真正可用。

> 本工具**只读取清单和摘要信息进行静态验证,不执行真实恢复**,也不会访问备份文件内容。

## 环境要求

- Node.js >= 24.16.0

## 功能

- 支持全量(full)、增量(incremental)、差异(differential)三类备份
- 增量备份必须有连续可用的祖先链,任一祖先损坏即整链断裂
- 差异备份必须挂在有效的全量基线上,不能跨错误基线
- 日志链连续性检查:子备份起始日志位置必须衔接父备份结束位置,且需覆盖目标恢复点
- 检测重复备份(相同摘要分组)、分叉链(同一父备份多个子备份)
- 检测文件大小异常、上传中断(文件不完整)、校验失败、保留期过期、无可用副本
- 检测校验通过但内容版本与父备份不一致的情况
- 指定时间点落在日志缺口内时,给出最近可用恢复点与阻断原因
- 输出可用恢复点、恢复所需文件顺序、缺失节点和阻止恢复的具体原因

## 输入格式

清单为 JSON 文件,`backups` 数组中每条记录包含:

| 字段 | 说明 |
| --- | --- |
| `id` | 备份唯一标识 |
| `type` | `full` / `incremental` / `differential` |
| `timestamp` | 备份时间点(ISO 8601) |
| `parentId` | 父备份 id,全量备份为 `null` |
| `logStart` / `logEnd` | 起始 / 结束日志位置 |
| `checksum` / `checksumVerified` | 校验摘要及其验证结果 |
| `fileIntact` | 文件完整性(上传中断为 `false`) |
| `fileSize` / `expectedSize` | 实际 / 期望文件大小 |
| `contentVersion` / `baseVersion` | 内容版本 / 所基于的父备份内容版本 |
| `replicas` | 副本位置列表,每项含 `location` 与 `available` |
| `retention` | 保留状态:`retained` / `expired` |

可选的 `targets` 数组指定待评估的恢复时间点(`time` 与可选 `logPosition`)。
完整示例见 `examples/manifest.json`。

## 使用

```bash
# 验证清单并评估其中声明的目标时间点
node src/cli.js examples/manifest.json

# 额外评估一个命令行指定的目标时间点
node src/cli.js examples/manifest.json --target 2026-11-03T12:00:00Z --log-position 1600
```

输出 JSON 报告,包含:

- `recoveryPoints`:可用恢复点及恢复所需文件顺序(含副本位置)
- `unusable`:不可用备份及阻止恢复的具体原因
- `missingNodes`:被引用但缺失的父备份节点
- `forks`:分叉链;`duplicates`:重复摘要分组
- `targets`:各目标时间点的可恢复性结论

## 测试

```bash
node --test
```
