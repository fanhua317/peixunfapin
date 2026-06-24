# 钜洲培训 Agent 性能与排障审计报告

更新时间：2026-06-24

## 1. 审计状态

| 项目 | 状态 |
| --- | --- |
| 环境与数据盘点 | 已采集：`training-service\server-audit-output\inventory-20260624-230910.json` |
| 功能回归 | 已采集：`training-service\server-audit-output\functional-20260624-231154.json` |
| 性能压测 | 已采集：`training-service\server-audit-output\perf-20260624-230750.json` |
| 合成数据 | 已采集：`training-service\server-audit-output\synthetic-20260624-230439.json` |

> 生产端口只做只读基线；写入、合成数据和极限压测必须打隔离副本，避免污染线上业务数据。

本轮采集边界：

- 数据目录规模来自本次命令可读取的 `D:\juzhou-agent\data\training-index`；如果要采集服务器真实磁盘与计划任务，应在服务器本机执行同一组命令。
- 本轮本地环境未配置 `TRAINING_ACCESS_KEY`，生产受保护接口返回 `401 auth_required` 属于预期鉴权拦截；完整业务链路需在服务器本机或带 `--access-key` 复跑。
- 本轮性能数据为生产公开端点只读基线，不包含受保护 RAG、Agent、写入、导入或备份链路。

## 2. 数据规模

| 指标 | 数值 |
| --- | --- |
| 知识库 | 2 |
| 文档 | 20 |
| 父块 | 546 |
| 子块 | 594 |
| 员工 | 4 |
| 任务 | 2 |
| 邀请 | 4 |
| 考试 | 0 |
| 答题记录 | 0 |
| 数据目录文件 | 14 |
| 数据目录大小 | 21.08 MB |

合成数据：small=100 文件/503.93 KB；medium=1000 文件/4.97 MB；large=5000 文件/24.96 MB。

## 3. 生产只读探测

| 接口 | 状态 | 延迟 | 备注 |
| --- | --- | --- | --- |
| /api/auth/status | 200 | 98 ms | ok |
| /api/health | 401 | 67 ms | auth_required |
| /api/knowledge-bases | 401 | 36 ms | auth_required |
| /api/jobs | 401 | 33 ms | auth_required |
| /api/agent-runs?limit=50 | 401 | 37 ms | auth_required |

## 4. 功能回归

| 用例 | 结果 | 耗时 | 失败分类 |
| --- | --- | --- | --- |
| check | 通过 | 6107 ms | - |
| eval-rag-retrieval | 通过 | 9352 ms | - |
| eval-backup | 通过 | 770 ms | - |

## 5. 性能压测

| 类型 | 并发 | RPS | p95 | p99 | 错误率 |
| --- | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 31.23 | 34 ms | 50 ms | 0.00% |
| read | 5 | 160.95 | 35 ms | 37 ms | 0.00% |
| read | 10 | 324.92 | 35 ms | 36 ms | 0.00% |

## 6. Bug 与风险记录

- 本轮已采集数据中没有形成明确 bug；继续跑完整服务器极限压测后刷新本节。

- RISK-AUTH-001 [P2] 本轮未拿到服务器访问密钥，受保护接口、真实服务器数据目录、写入链路和隔离副本极限压测尚未完成。建议：在服务器本机执行 `backup-server.ps1` 后复制数据目录到隔离副本，设置独立 `TRAINING_DATA_DIR` 和端口，并使用 `--access-key` 复跑 `server-audit:*`。

## 7. 结论

- 当前审计体系覆盖数据规模、功能回归、接口延迟、并发稳定性、合成数据和报告沉淀。
- 完整服务器结论以 `server-audit-output/*.json` 为证据来源；重新运行审计后执行 `npm run server-audit:report` 可刷新本文。
- 如果接口返回 `auth_required`，说明缺少服务器访问密钥，需要在服务器本机或带 `--access-key` 重新执行。
