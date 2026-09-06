# Windows cp1252 日志结果输出失败

## 现象

GitHub Actions 的 `windows-install` 检查在 Claude PowerShell 安装后的运行时
自检中失败。`cm-log-event.py` 已写入日志，但在最终打印机器可读结果时退出 1：

```text
UnicodeEncodeError: 'charmap' codec can't encode characters
  File "scripts/cm-log-event.py", line 670, in main
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
```

## 复现

在行为夹具中以 `PYTHONIOENCODING=cp1252` 启动日志写入器，并让返回的
`project_log` 包含中文目录与 `运行日志.jsonl` 文件名。

修复前的红灯证据：

```text
AssertionError: expected exit 0, got 1
UnicodeEncodeError: 'charmap' codec can't encode characters in position 205-208
```

## 根因

日志文件始终显式按 UTF-8 写入，不受控制台代码页影响；但 CLI 的最终 stdout
使用 `ensure_ascii=False` 输出原始中文。Windows GitHub Actions 的 Python stdout
采用 cp1252，无法编码返回路径中的中文，因此在所有写入完成后仍以失败状态退出。

## 修法

仅把 CLI 结果的 JSON 序列化改为 `ensure_ascii=True`。stdout 因而只包含 ASCII，
任何标准 JSON 解析器都会把 `\uXXXX` 还原为原始 Unicode 字符。磁盘 JSONL、
事件 ID、索引和指针继续使用原有 UTF-8 表示。

放弃的方案：修改 PowerShell code page 或注入全局 `PYTHONIOENCODING=utf-8`。
这些方案依赖调用方环境，无法覆盖 CMD、第三方启动器或其他传统代码页。

## 波及面

- `scripts/cm-log-event.py` 的 stdout 机器接口；
- `scripts/test-cm-log-event.py` 的跨代码页行为夹具；
- 不改变日志文件格式、字段语义、路径值、权限或安全过滤。

## 回归结果

- `python3 scripts/test-cm-log-event.py`：PASSED；
- `pwsh -NoProfile -File scripts/cm-check-runtime.ps1 --log-fixtures`：PASSED；
- `./scripts/cm-check-runtime.sh`：PASSED，plugin v0.10.3；
- `python3 scripts/validate-public-repo.py`：PASSED；
- `python3 scripts/scan-public-safety.py`：PASSED；
- 官方 Codex plugin validator：PASSED；
- Python 编译与 `git diff --check`：PASSED；
- 独立 Codex CLI 审查：第 1 轮 1 项已修正，第 2 轮 approved。

## 防护网

测试文件：`scripts/test-cm-log-event.py`。夹具显式验证：

1. cp1252 环境下进程成功退出；
2. 原始 stdout 使用 ASCII Unicode 转义；
3. JSON 解析后仍得到中文 specs 目录和 `运行日志.jsonl` 文件名；
4. 全局日志写入状态保持成功。
