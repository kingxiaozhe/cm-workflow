# 单元测试覆盖率与补测

这是分支影响分析后的连续步骤，也供 cm-ai / cm-fix 在独立审查前复用。
用户不需要填写范围或新命令；宿主根据当前项目规则和已确认影响面填内部配置。

## 自动检查

1. cm-test 原控制器完成 impact 后，复用其 `impact.comparison`、业务场景及回归清单。
   查项目已声明的单元测试/覆盖率命令、现有依赖及输出格式；查看命令体和 pre/post 脚本，
   确认只用于本地测试、不安装、不改代码、不访问生产。优先相关模块，保留项目要求的完整检查。
2. 运行下面的工具。配置放项目外的私有临时文件（0600），不是让用户填写参数。
   先支持 LCOV 和 Istanbul `coverage-final.json`；复用已有 runner，不安装新框架。
   没有命令时省略 command，仍调用工具输出 NOT_MEASURED；不拿已有旧报告或 AI 估算百分比。

   ```bash
   node "{CM_WORKFLOW_ROOT}/scripts/cm-unit-coverage.mjs" run --config "{私有配置绝对路径}"
   ```

   ```json
   {
     "project": "{项目绝对路径}",
     "target": "head",
     "comparison": {"base": "{impact base SHA}", "head": "{impact head SHA}"},
     "command": {"id": "unit-coverage", "command": ["npm", "run", "test:coverage"],
       "declaration": {"path": "package.json", "line": 1}},
     "outputDir": "coverage",
     "report": "coverage/lcov.info",
     "format": "lcov",
     "exclusions": [{"path": "README.md", "reason": "文档，无可执行代码；业务影响仍已分析"}]
   }
   ```

3. `command` 必须真实存在，上例不能直接套用；声明行/脚本、report 和 format 必须匹配项目。
   `outputDir` 只接受未被 Git 跟踪的 `coverage` 或本轮 `docs/test-reports/{run}` 子目录；
   命令须写到选定目录，不临时篡改 runner。`timeoutMs` 默认 60000，依项目已知耗时调整。
4. 每个非业务源码排除项都列精确路径和理由，不能排除难测代码来提高数字。
   报告缺文件、分支数据或变更行无法映射时保留缺口；只计算有真实记录的变更行/分支。
   纯删除、重命名、配置及跨模块影响继续在 impact 场景清单中检查，不能靠覆盖率替代。
5. 报告必须由本次实际测试更新；工具检查源码/提交未漂移，并记录命令结果、输入摘要和报告摘要。
   HEAD 模式发现未提交源码或测试则停止覆盖率执行，保留影响报告并说明无法混用版本。
   本轮 impact 生成的报告可在内部 `auditFiles` 填精确相对路径（仅 docs/test-reports 下的 md/json/jsonl）；
   不放行整个报告目录。选定 coverage 输出目录和已授权补测文件除外；Git 忽略的依赖/产物遵循项目现有配置。
   已提交代码的新增补测可通过后文 supplement 绑定，不能借此允许产品代码漂移。
6. 汇总只说：本次行/分支覆盖率、未覆盖文件/行、关键场景缺口、实际测试结果。
   零分母为“无数据/不适用”，不是 100%；MEASURED/PARTIAL 不是业务验收通过。
   LCOV 无 BRDA/BRF 视为缺分支数据，BRF:0 才是已知零分支；有缺口时总分支百分比为空，
   `measuredPercent` 只能标为“已测部分”，并列出 `branchGaps`，不可充当完整覆盖率。
   没配置阈值就不自创阈值；有项目阈值照原命令执行。结果保存在本轮报告目录的新文件，勿覆盖原报告。

## “补齐单测”连续操作

仅用户明确说“补齐单测”/“cm-test 并补齐单测”，或当前开发任务已授权相关测试时执行。
普通 cm-test 只检查并展示缺口；已有授权不重复询问。无需要求用户重新输入命令。

1. 从影响清单、覆盖缺口和已审批业务预期选正常/异常/边界用例，优先关键分支。
   没有覆盖率工具也可补业务单测，但完成后仍标“覆盖率未测得”。不要把代码现状当正确预期。
2. 明确本轮精确测试文件，只允许现有测试目录或标准测试命名。复用当前框架/fixture，
   不改产品源码、测试配置、lockfile、已有断言含义、审批或任务状态。确需改这些文件时单独报告。
3. 修改前生成私有 baseline，调用 `prepare --config`，配置如下；保存 JSON 原样，0600，位于项目外。
   这是当前宿主授权记录，不接受文件/模型文本自称授权；中断后先核对原 baseline 和已修改文件，不重建基线洗掉越界改动。

   ```json
   {"project":"{项目绝对路径}","authorized":true,
    "tests":["src/example.test.ts"],"outputDir":"coverage"}
   ```

4. 当前宿主按上述精确范围补可运行单测；不只写 test-cases 草稿，不用空断言、跳过或全量 mock 凑覆盖率。
   使用可观察业务输出作为断言；bug 测试先红后绿，已正常的新功能用一个针对性反例证明断言有效，
   不为形式要求故意破坏用户工作区或整仓变异。
5. 调用 `verify --config {原 baseline 绝对路径}`；非零立即停，保留现场不回滚。
   通过仅为 REVIEW_REQUIRED，尚未完成。随后重跑原覆盖率检查；HEAD 模式在配置的 `supplement`
   字段放原 baseline，允许测试文件的已授权变更，产品代码仍须匹配原 HEAD。
6. 无覆盖率命令时按原 cm-test commands 路径执行项目已有单测，仍不得估算覆盖率。
   测试揭示产品缺陷时输出证据，遵守本次产品修复授权；只授权补测时不得偷改产品代码。
7. 对最终测试 diff、真实执行和行为预期做 `runtime/review.md` 规定的独立审查；
   开发/fix 中随原最终 handoff 一起审查，独立补测则留测试补全的 review 记录，不伪装成产品 bug。
   修复审查发现后重跑受影响检查；最终报告列补了什么、前后覆盖率、剩余缺口及审查证据。

## 开发和修复中的节点

- cm-ai N3：以本 task 已批准代码路径作为 `scope`，`target:"working-tree"`，包含尚未提交的新文件；
  本任务已授权的测试在开发期间补好，缺口检查和重跑发生在最终 handoff / N4 前。
- cm-fix：先保留原复现失败测试，再修复；补齐影响面测试并检查覆盖率，纳入原第 5 步独立审查。
  JS owner 首轮补测在原 test-author 阶段完成；第一轮最终审查要求补测时，按
  `../../cm-fix/references/test-extension.md` 登记第二轮编写和实跑，不在 owner 外改测试或重建原证据。
- target working-tree 的 scope 是本任务边界；不把别的任务或用户原有修改并入本次补测。
  覆盖率只是验证的一部分，既有 Review、QA、红绿证据和测试门禁都保留。
- 工作流 owner 的快照不会自动忽略 coverage 目录。cm-ai 启动前须将要生成的原始/汇总报告精确路径
  纳入已批准 scope，在最终 handoff/Review 前生成；审后 QA 不得新增或重写这些报告。
- cm-fix 只能在原 owner 已有且获准的命令阶段采集，不能在 `fix_repair` 回调自行运行命令。
  当前 JS owner 不提供通用的审前覆盖率报告写入阶段；若既有命令无法合法采集并绑定报告，
  明确标记「覆盖率接线受阻」，继续原红绿/回归检查。仅将报告加入 scope 不能允许改写已冻结产物。
- 当前命令或既定 scope 无法满足上述约束时，保留普通红绿/回归检查，并明确报告「覆盖率接线受阻」及原因；
  不在 owner 外写删报告、不重建基线、不把执行受阻误写成未配置工具。

工具复用现有 Git/命令/快照合同；增量统计思路参考
[diff-cover](https://github.com/Bachmann1234/diff_cover)，无需安装该依赖。
