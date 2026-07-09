---
description: {一句话：数据库与 migration 约定}
globs: {如 "src/db/**, migrations/**"，按实际目录}
---

<!-- 模板骨架 · 生成时遵守四原则，{占位符} 结合项目填充 -->

# 数据库规范

## Migration

- 工具与命名：{Prisma/Knex/Alembic…，时间戳或序号规则}
- 必须可回滚（up + down）；**破坏性变更（删表/删列/改类型）必须人工确认**
- 大表加列/加索引：{PostgreSQL 用 CONCURRENTLY 等锁表规避方案}
- 兼容序：加列随本次发布，删列随下次发布

## Schema

- 新表必含审计字段：{created_at / updated_at / 软删标记约定}
- 字段类型精确：金额用 decimal、枚举用 enum，禁止 string/float 凑合
- 外键级联：默认 RESTRICT，CASCADE 需注明理由

## 查询

- 复杂查询封装位置：{repository/独立函数目录}
- 防 N+1：{eager loading / dataloader 约定}
- 大数据量必须分页/游标；慢查询阈值 {N}ms 需 EXPLAIN
