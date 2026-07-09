---
description: {一句话：智能合约开发与安全约定}
globs: {如 "contracts/**"，按实际目录}
---

<!-- 模板骨架 · 生成时遵守四原则，{占位符} 结合项目填充 -->

# 智能合约规范

## 工具链

- 链/框架：{EVM+Foundry / Solana+Anchor…}；编译器版本锁定 {版本}，与 pragma 一致
- 基础库：{OpenZeppelin/Solmate/SPL 版本锁定}——成熟库优先，不手写基础功能

## 安全清单（每个合约合入前逐项过）

- 重入：ReentrancyGuard 或 checks-effects-interactions
- 溢出：{Solidity ≥0.8 内置 / checked_* 系列}
- 权限：{Ownable/AccessControl/多签方案}，避免单点控制
- 预言机：价格用 TWAP，禁止即时价
- {Solana：账户 owner/signer 逐 instruction 验证、PDA 种子唯一、CPI 验证 program_id}

## 测试与部署

- 覆盖率 ≥ {90}%；权限测试（非授权调用必须 revert）与攻击场景测试必写
- Fuzz：{forge test --fuzz-runs 1000 等}
- 部署：私钥/RPC 一律环境变量；**主网部署强制人工确认**；合约验证 {Etherscan/Sourcify}
- 事件覆盖所有状态变更；升级机制与紧急暂停：{方案或"不适用"}
