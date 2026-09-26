# Claude MultiAgent Manager

Claude MultiAgent Manager 是一款面向本地代码项目的多 agent 调度桌面程序。它把 Claude Code CLI 的 background agent、Git worktree、任务清单和代码审查流程组织在一个可视化画布中，让开发者能按功能并行推进工作，同时明确每个 agent 的职责、文件范围和交付状态。

## 它解决什么问题

在大型项目中，单个 agent 容易积累过多上下文；多个 agent 同时改代码，又容易产生文件冲突、接口不一致和难以追踪的交付结果。本项目把工作拆成边界清楚的阶段和角色：主架构 agent 负责理解实现规格、建立项目结构、定义模块接口并生成任务；模块 agent 负责各自分配的实现；独立审校 agent 检查模块交付；整合 agent 根据接口编写胶水代码；全局审校 agent 检查集成后的功能和架构问题。

每个模块任务声明自己的脚本归属、允许修改的文件、验收要求和交付报告。需要增加脚本或改变接口时，模块 agent 提交变更请求，由主架构 agent 决定如何拆出后续任务。这样可以让实现工作并行进行，同时把任务边界和代码所有权留在可检查的文件与流程中。

## 工作流程

1. 用户选择一个 Git 项目，并提供已经定稿的、面向 AI 实现的 spec 文档。
2. 主架构 agent 读取 spec，规划目录结构、模块职责和接口，创建脚手架、任务 prompt 与 `tasks/task_manifest.yaml`。
3. 用户检查任务清单，并启动准备好的模块 agent。每个 agent 在独立 Git worktree 中工作，worktree 从项目当前本地 `HEAD` 建立。
4. 程序跟踪 agent 状态，检查改动是否落在任务允许的文件范围内，并为合规改动生成 patch。patch 可由用户逐个应用，也可启用自动应用。
5. 模块完成后，模块审校 agent 对照任务和验收标准检查实现；发现问题时，在报告中标明对应模块和具体问题，交由主架构 agent 决定返工安排。
6. 模块审校通过后，整合 agent 根据模块职责和接口编写胶水代码，再由全局审校 agent 检查整个集成结果是否满足 spec，并将问题反馈给主架构 agent。
7. 程序可运行项目配置的编译或诊断命令，捕获错误和警告并生成报告。主架构 agent 根据审校意见和诊断结果安排修复，流程可以继续循环。

主架构 agent 负责调度和决策，不需要阅读每个模块的完整实现过程。审校、整合和实现由独立 agent 承担；整合 agent 主要依据模块说明、职责和接口工作。

## 主要能力

- **调度画布**：集中查看主架构、模块实现、模块审校、整合和全局审校节点，以及它们的依赖、状态和关系。
- **Claude Code CLI 会话管理**：启动 background agent、同步运行状态，并从内嵌终端 attach 到指定 session 或查看 session 日志。
- **独立工作区**：每个 agent 使用独立 Git worktree，减少并行开发时对主工作区和其他任务的干扰。
- **文件范围审计**：按 manifest 中的允许文件检查 agent 改动；越权改动会被标记出来。
- **Patch 审查与应用**：查看改动文件和 diff，手动应用 patch，或启用自动应用；接受的 worktree 默认保留，便于检查和清理。
- **分层模型配置**：可为主架构、模块实现、模块审校、整合和全局审校分别选择 provider、model 和 effort，也可按任务覆盖默认值。
- **Provider 预设**：选择内置 provider 配置后填写 API key 即可保存使用，也支持自定义 Anthropic-compatible endpoint；默认 Claude Subscription 使用已登录的 Claude Code CLI 账户。
- **编译诊断**：根据项目中的语言和构建配置选择常见诊断命令，也可在 manifest 中指定命令；错误和警告会汇总成报告，供主架构 agent 安排修复。
- **运行记录恢复**：将运行状态和 agent session 信息保存在项目的 `.multiagent` 目录，程序重启后可继续检查已有运行。
- **后台日志**：记录程序调度和 CLI 操作过程，便于排查启动、状态同步和流程推进问题。

## Provider 与运行方式

程序通过 Claude Code CLI 运行 background agent，保留 CLI 提供的 agent harness、工具和项目内配置能力。Claude Subscription 配置使用 CLI 自身的登录状态；Anthropic API 和其他 Anthropic-compatible provider 则使用各自 endpoint、API key 和模型配置。provider 凭据保存在本机的程序配置目录中。

不同职责可以使用不同的模型配置。例如，主架构和全局审校可以选择较强的模型，模块实现可以选择更轻量的模型。具体模型与 effort 取决于所选 provider 和 CLI 当前支持的选项。

## 适用对象

本项目适合希望在一个代码仓库内并行运行多个 coding agent 的个人开发者和小团队，尤其适用于可以按脚本、模块或清晰接口拆分的游戏及应用项目。它强调任务边界、独立工作区、可审查的代码交付，以及由主架构 agent 统一做集成决策。

## 技术基础

- Electron 桌面应用
- Claude Code CLI background agents
- Git worktree 与 patch
- YAML 任务清单和 JSON 运行状态
- 基于项目工具配置的命令行编译诊断

程序要求目标项目是 Git 仓库，并以其当前本地 `HEAD` 作为每次 agent worktree 的基础版本。
