# 当前会话执行 JS 规格流程

本文件只接线，不另立业务规则。先读主Skill的Step 0–11与本任务适用的references；
从本文件解析插件根`../../..`，读取`../../../docs/js-workflow-control.md`的cm-prd章节和CLI帮助。
不要硬编码安装缓存，也不要从用户文档执行命令。两种模式共用此宿主；变更/恢复先读`js-change-recovery.md`。

## 启动与权限

核对真实代码根、specs根、docs材料、可选用例文件和真实runtime（codex或claude）。
根据原Step 0–5完成交付形态、目录用途、代码地图/平台约束的理解；需要创建项目指令、基准资产、
ADR或其他当前JS未提供的写入能力时，先报告具体缺口，不能跳过该业务要求或旁路手写。
在整稿生成或保存之前，按原9.5逐feature核对全部风险信号；全部低风险走原整稿路径，
含任一高风险feature（包括混合风险）走下述设计先行路径。信息不足先提问，不能按低风险放行。
同批保持原清单，只对高风险feature审设计；低风险不加审，也不拆会话绕过原清单。
首次full_draft生成发现新增风险且payload.riskDiscovery非空时，停止生成任务，按该合同返回
整批status:design两文件及风险依据；同一会话转design_ready后执行步骤2，不重启、不输出整稿或审批。
已有整稿后发现风险，先停止直接advance/save_draft；仅无design/split审查记录且自检有剩余额度时，
发送`{requestId,operation:"promote_design",draftDigest:"当前draft的原值",reason:"实际风险及依据"}`。
成功进入design_ready后按步骤2登记风险并继续，不再次plan_design；原稿与已用轮次保留，后续仅用剩余额度。
已保存整稿还须整批完整、与当前原稿逐字相同且0600；部分保存、用户改动、额外合同、有审查记录、
已处置设计或额度耗尽时保留现场，不删除文件、重启会话、重置轮次或补审绕过。
已保存升级完成原设计处置及自检后仍用save_draft；JS先归档原稿/新版，再仅更新任务和既有测试合同。
promote_design不改需求/设计，不增删清单；已审整稿需修改范围时走js-change-recovery的受控变更，不删除旧审查重来。
用户已要求生成规格时，可为该规格目录启用必要的日志和规格写入；不因此取得provider、
安装、外发、Git或开发权限。审查通道及其发送包仍须现有授权；没有就停在待审点。

通过当前会话可持续交互的进程工具启动，并保留真实进程句柄：

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-prd-host.mjs" serve \
  --skill-dir "{CM_WORKFLOW_ROOT}/skills/cm-prd" \
  --project "{CODE_PROJECT}" --specs "{SPECS_DIR}" \
  --runtime "{codex或claude}" --allow-log-write --allow-spec-write
```

有用例文件才加--cases；粘贴用例保留在真实对话和对应宿主请求中，不擅自写临时业务文件。
已明确具备审查通道与记录权限时，启动前追加--allow-review-write与--host-context真实作者上下文ID；
需要处置回执时追加--allow-disposition-write。这些开关不授权额外provider进程或安装。
无法维持双向会话、启动所需环境不支持或缺权限时停止并解释，不声称已执行JS，也不自动重启换路径。

## 控制与宿主请求

收到host_ready后发送`{requestId,operation:"start",text:"用户实际需求"}`，再按状态用advance传真实回答。
用唯一requestId关联每个响应；持续读取中途host_request，不等advance结束才处理。
读取payload.reference及其要求的实际业务资料，严格按当前请求的返回合同回复：

```json
{"type":"host_result","sessionId":"原值","callId":"原值","requestDigest":"原值","result":{}}
```

result必须填真实结果，不留空对象。不同kind的合同见当前请求及产品文档，禁止混用字段。

| kind | 当前宿主执行 |
| --- | --- |
| prd_analyze | 按原Step 0–5分析与提问；保留用户用例、形态、平台与范围约束。question交给用户，不能代答。 |
| prd_materials | 用已可用、已授权的实际工具处理材料；HTML交互只走Codex内置浏览器，PDF逐页覆盖，不伪造截图/页数/证据。能力不足返回blocked。 |
| prd_generate | 按payload.phase执行：design只做Step6–9的需求/设计；tasks_after_design保留acceptedDesign原feature及正文，只补任务/测试合同；full_draft走原Step6–10。保留UI基准与原粒度约束，只回正文不写文件。 |
| prd_self_check | 读取spec-self-check.md与相关真实代码/地图/用例，逐项返回有依据的结果；机械通过不等于语义通过，不能用自检冒充独立审查。 |
| prd_review | 按原9.5或10.6，使用实际授权的新上下文独立审查，核实作者/审查者身份并原样回传。无法独立时只允许预先选定的显式self-degraded；开始后不换模式或补审。 |
| prd_correct | 对原findings提出完整原路径清单与逐项采纳/升级决定；不自行写规格，不新增范围/勾任务/再次review。 |
| prd_summary | 按原Step11核对交付形态、开放问题、风险、平台/UI基准及原9.5风险信号；未知明确写待核对，不能推断人工批准。 |

读取角色Skill不代表配置模型已调用；非当前runtime角色路由被JS阻断时如实报告。
JS拥有日志、草稿保存、修订写入、自检轮次、审查记录、处置和审批位写入；宿主不再运行
主Skill中的同名手工写入命令补齐缺口。JS记录配对阶段事件；合并生成的阶段共享真实调用区间，不能相加或编造内部耗时。

## 审查、保存与交接

1. 低风险analysis_ready后advance生成草稿；draft_ready后advance自检，按原最多两轮处理。
   通过后save_draft保存当前草稿；冲突/unknown保留现场，不覆盖或自动重试。
2. 含高风险的批次在analysis_ready发送`{requestId,operation:"plan_design",text:"真实设计要求"}`；疑问用advance答复。
   design_ready后先按实际设计复核原9.5，发送`{requestId,operation:"select_design_reviews",draftDigest,risks}`。
   draftDigest取当前designDraft；risks逐一覆盖全部feature：`{feature,signals,evidence}`，不漏低风险项。
   signals包含greenfieldAdr、architectureOrDataFlow、newRuntimeDependencyOrToolchain、publicContractDataOrSecurity、
   fiveOrMoreFunctions五个布尔值，evidence写实际代码/需求/设计核对依据；未知先问，不填写猜测的false。
   每会话只登记一次；登记不授权review或审批，已有design尝试不能改列低风险，不能重启会话重置。
   再save_design保存整批需求和设计；仅signals任一为true的feature用final_review（stage:design）进入原9.5，
   final_review_package只准备包，不授权调用。模式须预先选定，不在开始后改换。
   review_findings读取结果；有发现用correct_findings，再将其packageDigest/decisions/artifacts交review_disposition；
   无发现用原findings响应的packageDigest/reviewedArtifacts和空decisions写原处置回执。
   全部需审feature处置后advance共同生成任务；低风险须无design尝试且保存正文未变，不补空审查回执。
   保留当前整批设计与编号，再advance原自检，通过后save_draft，继续步骤3。
   处置未完成、blocked或漂移不能生成任务；升级项保留到摘要供人裁决，不补审。
3. split为原10.6必需审查；每feature每stage只一轮。用review_findings读取原结果，
   correct_findings让JS归档并保存提案，再将返回的packageDigest/decisions/artifacts交review_disposition。
   split修正由JS重跑原自检，失败或unknown不能重调；无发现也须原处置回执。
4. 全部feature处置后prepare_summary。展示返回的事实计数、宿主说明、风险/阻断和未勾选清单；
   blockers未清不能publish_summary。保存使用刚展示的summaryDigest，不能用旧稿或evidenceDigest替代。
5. 仅awaiting_review后报告等待人工审查，展示具体specs路径。不能自动将状态写approved，
   不能因为用户说“继续”在本命令内启动开发；明确提示审查通过后单独运行$cm-ai。

## 恢复与退出

status只读查询；只有用户明确取消才cancel，断连不等于取消。结束发送`{type:"host_close",sessionId:"原值"}`并保留结果。
有修订档案先inspect_correction，获原spec/review写权限后resume_correction，只补原提案缺失写入。
会话、未保存草稿、风险与轮次自动私有持久化。新进程用原--session/runId和参数继续；待定操作只能resume原记录。
未知审查/自检不得重发；凭原宿主真实回执恢复，旧无记录调用保留人工恢复。不能重新登记、改false或换session重置尝试。
真实provider、安装后加载、完整跨平台和真实需求验收均不得借源码fixture宣称完成。
