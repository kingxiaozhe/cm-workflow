// 边界测试的前置导入：必须是测试文件的第一条 import（ES 模块按导入顺序求值），
// 在 effect-contract 读取之前把存档单条上限压回 1 MiB；子进程（驾驶员、宿主）继承同一环境变量。
// 只能调小（见 effect-contract.mjs），用来继续验证原来按 1 MiB 构造的边界场景。
process.env.CM_JOURNAL_PAYLOAD_LIMIT_TEST=String(1024*1024);
