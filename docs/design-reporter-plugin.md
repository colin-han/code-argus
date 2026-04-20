# Reporter 插件机制技术设计

> **实现状态**: ✅ 已完成（Phase 1-7）
>
> 本设计文档中描述的插件架构已完整实现，包括：
>
> - 插件接口与注册中心（`src/review/reporters/types.ts`, `registry.ts`, `index.ts`）
> - 5 个内置插件（markdown, json, summary, pr-comments, jira）
> - CLI 参数支持（`--reporters`, `--reporter-opt`, `--reporter-dir`）
> - 第三方插件加载机制
> - 完整测试覆盖（20 个测试用例）

## 1. 背景与目标

### 1.1 当前问题

当前报告生成逻辑硬编码在 `src/review/report.ts` 的 `formatReport()` 中，通过 switch-case 分发到 4 个内置格式函数：

```typescript
// 现状：硬编码分发，无法扩展
switch (opts.format) {
  case 'json':
    return formatAsJson(report, opts);
  case 'markdown':
    return formatAsMarkdown(report, opts);
  case 'summary':
    return formatAsSummary(report);
  case 'pr-comments':
    return formatAsPRComments(report);
}
```

局限性：

- 新增输出方式必须修改核心代码
- 无法支持有副作用的操作（如 JIRA API 调用）
- 无法同时输出多种格式
- 第三方无法扩展

### 1.2 目标

- 将 4 种输出格式改为独立的 Reporter 插件
- 支持新增 JIRA Reporter 插件（将问题上报到 JIRA）
- 支持一次 review 同时激活多个 Reporter
- 第三方可通过目录加载自定义 Reporter
- 保持向后兼容（`--format` 参数继续可用）

---

## 2. 核心接口设计

### 2.1 ReporterPlugin 接口

```typescript
// src/review/reporters/types.ts

import type { ReviewReport, ValidatedIssue, ReviewContext } from '../types.js';

/**
 * Reporter 插件的配置项（由用户通过 CLI 或配置文件传入）
 */
export interface ReporterConfig {
  /** 插件特有配置，key-value 形式 */
  [key: string]: unknown;
}

/**
 * Reporter 插件执行上下文
 */
export interface ReporterContext {
  /** 仓库路径 */
  repoPath: string;
  /** 源分支/ref */
  sourceRef?: string;
  /** 目标分支/ref */
  targetRef?: string;
  /** 语言 */
  language: 'en' | 'zh';
  /** 是否 verbose 模式 */
  verbose: boolean;
}

/**
 * 对单个 issue 的回写更新
 */
export interface IssueUpdate {
  /** 要更新的 issue ID（对应 ValidatedIssue.id） */
  issueId: string;
  /** 要写入的外部引用信息 */
  externalRefs?: Record<string, ExternalReference>;
}

/**
 * 外部系统引用（如 JIRA issue）
 */
export interface ExternalReference {
  /** 外部系统类型 */
  system: string;
  /** 外部系统中的唯一 ID（如 JIRA issue key: PROJ-123） */
  externalId: string;
  /** 外部系统中的 URL */
  url?: string;
  /** 外部系统中的当前状态 */
  status?: string;
  /** 创建时间 */
  createdAt: string;
  /** 最后更新时间 */
  updatedAt?: string;
}

/**
 * Reporter 插件执行结果
 */
export interface ReporterResult {
  /** 插件名称 */
  reporter: string;
  /** 是否成功 */
  success: boolean;
  /** 文本输出（可选，用于 stdout 输出的插件） */
  output?: string;
  /** 错误信息 */
  error?: string;
  /** 插件特有的结果数据 */
  metadata?: Record<string, unknown>;
  /**
   * issue 回写更新列表
   * exporter 插件可通过此字段将外部系统 ID 回写到 issue 中
   * 例如 JIRA reporter 创建 issue 后，将 JIRA key 写回
   */
  issueUpdates?: IssueUpdate[];
}

/**
 * Reporter 插件接口
 *
 * 每个 Reporter 负责将 ReviewReport 转化为一种输出。
 * 输出可以是文本（Markdown、JSON），也可以是副作用（JIRA 创建 issue）。
 */
export interface ReporterPlugin {
  /** 插件唯一名称，用于 CLI 参数引用 */
  name: string;

  /** 插件描述 */
  description: string;

  /**
   * 插件类型：
   * - 'formatter': 纯文本输出（如 markdown, json, summary）
   * - 'exporter':  有副作用的输出（如 JIRA, Slack, webhook）
   */
  type: 'formatter' | 'exporter';

  /**
   * 验证配置是否有效
   * 在执行前调用，如缺少必要配置可抛出错误
   */
  validateConfig?(config: ReporterConfig): void;

  /**
   * 执行报告输出
   *
   * @param report  - 完整的审查报告
   * @param context - 执行上下文（仓库信息、语言等）
   * @param config  - 插件配置
   * @returns 执行结果（可异步），可包含 issueUpdates 回写外部引用
   */
  execute(
    report: ReviewReport,
    context: ReporterContext,
    config: ReporterConfig
  ): Promise<ReporterResult>;

  /**
   * 同步外部系统状态（可选）
   * 当使用 --verify-fixes 时调用，用于同步外部系统中的 issue 状态
   * 例如：将 JIRA issue 标记为已修复
   *
   * @param report       - 当前审查报告
   * @param prevReport   - 上一次审查报告（含 externalRefs）
   * @param context      - 执行上下文
   * @param config       - 插件配置
   */
  syncStatus?(
    report: ReviewReport,
    prevReport: ReviewReport,
    context: ReporterContext,
    config: ReporterConfig
  ): Promise<ReporterResult>;
}
```

### 2.2 核心设计决策

| 决策点           | 选择                          | 理由                                                |
| ---------------- | ----------------------------- | --------------------------------------------------- |
| 同步 vs 异步     | `execute()` 统一为 `async`    | JIRA 等 exporter 需要异步网络调用                   |
| 单输出 vs 多输出 | 支持同时激活多个 Reporter     | 常见需求：输出 Markdown 到控制台 + 同时上报 JIRA    |
| 类型区分         | `formatter` vs `exporter`     | formatter 产生文本可 stdout 输出；exporter 有副作用 |
| 配置传递         | 通过 `ReporterConfig` 扁平 KV | 简单灵活，支持 CLI `--reporter-opt key=value`       |
| issue 回写       | `ReporterResult.issueUpdates` | exporter 创建外部资源后回写 ID，支持后续状态同步    |
| 状态同步         | `syncStatus()` 可选钩子       | 修复验证时可同步外部系统状态（如关闭 JIRA issue）   |

---

## 3. 插件注册中心

```typescript
// src/review/reporters/registry.ts

export class ReporterRegistry {
  private plugins: Map<string, ReporterPlugin> = new Map();

  /** 注册一个插件 */
  register(plugin: ReporterPlugin): void;

  /** 获取插件 */
  get(name: string): ReporterPlugin | undefined;

  /** 获取所有已注册插件名 */
  list(): string[];

  /** 批量执行选中的 reporters，执行后自动将 issueUpdates 回写到 report */
  async executeAll(
    reporterNames: string[],
    report: ReviewReport,
    context: ReporterContext,
    configs: Record<string, ReporterConfig>
  ): Promise<{ results: ReporterResult[]; updatedReport: ReviewReport }>;

  /** 批量同步外部系统状态（修复验证场景） */
  async syncAll(
    reporterNames: string[],
    report: ReviewReport,
    prevReport: ReviewReport,
    context: ReporterContext,
    configs: Record<string, ReporterConfig>
  ): Promise<ReporterResult[]>;
}

/** 全局默认 registry 实例 */
export function createDefaultRegistry(): ReporterRegistry;
```

`createDefaultRegistry()` 会预注册 5 个内置插件（markdown, json, summary, pr-comments, jira）。

---

## 4. 内置插件迁移

### 4.1 文件结构

```
src/review/reporters/
├── types.ts              # 接口定义
├── registry.ts           # 注册中心
├── index.ts              # 统一导出 + createDefaultRegistry
├── markdown-reporter.ts  # 从 report.ts formatAsMarkdown 迁移
├── json-reporter.ts      # 从 report.ts formatAsJson 迁移
├── summary-reporter.ts   # 从 report.ts formatAsSummary 迁移
├── pr-comments-reporter.ts  # 从 report.ts formatAsPRComments 迁移
└── jira-reporter.ts      # 新增
```

### 4.2 迁移示例：Markdown Reporter

```typescript
// src/review/reporters/markdown-reporter.ts

import type { ReporterPlugin, ReporterContext, ReporterConfig, ReporterResult } from './types.js';
import type { ReviewReport } from '../types.js';

export const markdownReporter: ReporterPlugin = {
  name: 'markdown',
  description: '输出 Markdown 格式的审查报告',
  type: 'formatter',

  async execute(
    report: ReviewReport,
    context: ReporterContext,
    config: ReporterConfig
  ): Promise<ReporterResult> {
    const includeChecklist = (config.includeChecklist as boolean) ?? true;
    const includeMetadata = (config.includeMetadata as boolean) ?? true;
    const includeEvidence = (config.includeEvidence as boolean) ?? false;

    // 原 formatAsMarkdown 逻辑迁移至此
    const output = formatMarkdown(report, {
      language: context.language,
      includeChecklist,
      includeMetadata,
      includeEvidence,
    });

    return {
      reporter: 'markdown',
      success: true,
      output, // CLI 层负责 console.log(output)
    };
  },
};
```

### 4.3 其他 3 个内置插件同理

| 插件                   | 源函数                 | type      |
| ---------------------- | ---------------------- | --------- |
| `json-reporter`        | `formatAsJson()`       | formatter |
| `summary-reporter`     | `formatAsSummary()`    | formatter |
| `pr-comments-reporter` | `formatAsPRComments()` | formatter |

---

## 5. JIRA Reporter 插件

### 5.1 设计

```typescript
// src/review/reporters/jira-reporter.ts

export const jiraReporter: ReporterPlugin = {
  name: 'jira',
  description: '将发现的问题上报到 JIRA 项目中',
  type: 'exporter',

  validateConfig(config: ReporterConfig): void {
    if (!config.projectKey) throw new Error('jira reporter 需要配置 projectKey');
    if (!config.baseUrl)    throw new Error('jira reporter 需要配置 baseUrl');
    // auth 通过环境变量 JIRA_API_TOKEN / JIRA_USERNAME
  },

  async execute(
    report: ReviewReport,
    context: ReporterContext,
    config: ReporterConfig
  ): Promise<ReporterResult> {
    const projectKey = config.projectKey as string;
    const baseUrl = config.baseUrl as string;
    const issueType = (config.issueType as string) ?? 'Bug';
    const minSeverity = (config.minSeverity as string) ?? 'warning';
    const dryRun = (config.dryRun as boolean) ?? false;
    const labels = (config.labels as string[]) ?? ['code-review', 'auto-generated'];

    // 过滤：只上报指定严重度以上的问题
    const severityOrder = { critical: 0, error: 1, warning: 2, suggestion: 3 };
    const threshold = severityOrder[minSeverity] ?? 2;
    const issuesToReport = report.issues.filter(¬
      (i) => severityOrder[i.severity] <= threshold
    );

    if (issuesToReport.length === 0) {
      return {
        reporter: 'jira',
        success: true,
        metadata: { created: 0, skipped: report.issues.length },
      };
    }

    const createdIssues: Array<{ key: string; summary: string }> = [];

    for (const issue of issuesToReport) {
      const jiraIssue = mapToJiraIssue(issue, {
        projectKey,
        issueType,
        labels,
        sourceRef: context.sourceRef,
        targetRef: context.targetRef,
        repoPath: context.repoPath,
      });

      if (dryRun) {
        createdIssues.push({ key: 'DRY-RUN', summary: jiraIssue.summary });
        continue;
      }

      // 调用 JIRA REST API 创建 issue
      const result = await createJiraIssue(baseUrl, jiraIssue);
      createdIssues.push({ key: result.key, summary: jiraIssue.summary });
    }

    return {
      reporter: 'jira',
      success: true,
      output: `已创建 ${createdIssues.length} 个 JIRA issue`,
      metadata: {
        created: createdIssues.length,
        skipped: report.issues.length - issuesToReport.length,
        issues: createdIssues,
        dryRun,
      },
    };
  },
};
```

### 5.2 JIRA Issue 映射规则

| ReviewReport 字段           | JIRA 字段     | 映射规则                                                     |
| --------------------------- | ------------- | ------------------------------------------------------------ |
| `issue.title`               | `summary`     | 前缀加 `[Code Review]`                                       |
| `issue.description`         | `description` | Markdown 格式，含文件路径、行号、代码片段                    |
| `issue.severity`            | `priority`    | critical→Highest, error→High, warning→Medium, suggestion→Low |
| `issue.category`            | `labels`      | 追加到 labels 中                                             |
| `issue.file` + `line_start` | `description` | 嵌入到描述中                                                 |
| `context.sourceRef`         | `description` | 注明来源分支                                                 |

### 5.3 JIRA 认证方式

```bash
# 环境变量配置
export JIRA_BASE_URL=https://your-org.atlassian.net
export JIRA_USERNAME=user@example.com
export JIRA_API_TOKEN=your-api-token
```

### 5.4 去重与回写策略

避免重复创建 JIRA issue + 回写外部引用：

1. 创建 JIRA issue 后，通过 `issueUpdates` 将 JIRA key 回写到 `ValidatedIssue.externalRefs`
2. 回写后的 report 被持久化（JSON 文件），作为下次 `--previous-review` 的输入
3. 下次 review 时，`syncStatus()` 钩子读取上次 report 中的 `externalRefs`，找到对应 JIRA issue 并更新状态

```typescript
// JIRA reporter execute() 返回 issueUpdates 示例：
return {
  reporter: 'jira',
  success: true,
  issueUpdates: [
    {
      issueId: 'security-reviewer-1718000000-abc12', // ValidatedIssue.id
      externalRefs: {
        jira: {
          system: 'jira',
          externalId: 'PROJ-456', // 创建的 JIRA issue key
          url: 'https://org.atlassian.net/browse/PROJ-456',
          status: 'Open',
          createdAt: '2025-04-16T14:00:00Z',
        },
      },
    },
  ],
};
```

### 5.5 状态同步流程（syncStatus）

当用户使用 `--verify-fixes --previous-review prev.json` 时：

```
prev.json (上次 report)
  └── issues[0].externalRefs.jira.externalId = "PROJ-456"

当前 review 发现该 issue 已修复 (fix_verification.status = 'fixed')
  ↓
jiraReporter.syncStatus() 被调用
  ↓
读取 prevReport.issues[0].externalRefs.jira.externalId
  ↓
调用 JIRA API: transition PROJ-456 → "Done"
添加 comment: "该问题已在 feat 分支中修复，由 Code-Argus 自动验证"
```

```typescript
// JIRA reporter syncStatus() 实现要点：
async syncStatus(report, prevReport, context, config) {
  const fixResults = report.fix_verification?.results ?? [];

  for (const result of fixResults) {
    // 从上次 report 中找到对应 issue 的 JIRA 引用
    const prevIssue = prevReport.issues.find(
      (i) => i.id === result.original_issue_id
    );
    const jiraRef = prevIssue?.externalRefs?.jira;
    if (!jiraRef) continue;

    switch (result.status) {
      case 'fixed':
        // 将 JIRA issue 转为 Done
        await transitionJiraIssue(jiraRef.externalId, 'Done');
        await addJiraComment(jiraRef.externalId,
          `✅ 已验证修复 (confidence: ${result.confidence})`);
        break;
      case 'missed':
        // 追加评论说明仍未修复
        await addJiraComment(jiraRef.externalId,
          `⚠️ 问题仍未修复，请继续关注`);
        break;
      case 'false_positive':
        // 关闭为 Won't Fix
        await transitionJiraIssue(jiraRef.externalId, "Won't Fix");
        await addJiraComment(jiraRef.externalId,
          `ℹ️ 经复核确认为误报: ${result.false_positive_reason}`);
        break;
    }
  }
}
```

---

## 6. CLI 参数设计

### 6.1 新增参数

```bash
# 使用单个 reporter（向后兼容 --format）
argus review /repo feat main --format markdown

# 使用新的 --reporters 参数（可指定多个）
argus review /repo feat main --reporters markdown,jira

# 配置特定 reporter 的参数
argus review /repo feat main \
  --reporters markdown,jira \
  --reporter-opt jira.projectKey=PROJ \
  --reporter-opt jira.minSeverity=error \
  --reporter-opt jira.dryRun=true
```

### 6.2 向后兼容

| 用户输入                    | 实际行为                                       |
| --------------------------- | ---------------------------------------------- |
| `--format markdown`         | 等价于 `--reporters markdown`                  |
| `--format json`             | 等价于 `--reporters json`                      |
| 无 --format 无 --reporters  | 默认 `--reporters markdown`                    |
| `--reporters markdown,jira` | 同时输出 Markdown 到 stdout + 创建 JIRA issues |

### 6.3 输出行为

```
formatter 插件 → output 写入 stdout（多个 formatter 按顺序输出，用分隔线隔开）
exporter 插件 → 执行副作用，结果写入 stderr / 进度日志
```

---

## 7. 执行流程

```
═══ 正常执行流程 ═══

ReviewReport
     │
     ▼
ReporterRegistry.executeAll(["markdown", "jira"], report, context, configs)
     │
     ├──▶ [formatter] markdownReporter.execute(report)
     │         │
     │         ▼
     │    ReporterResult { output: "# 代码审查报告\n..." }
     │         │
     │         ▼
     │    CLI: console.log(result.output)  ← stdout
     │
     └──▶ [exporter] jiraReporter.execute(report)
               │
               ▼
          对每个 issue 调用 JIRA REST API 创建 ticket
               │
               ▼
          ReporterResult {
            metadata: { created: 3 },
            issueUpdates: [                       ← 回写 JIRA key
              { issueId: "xxx", externalRefs: { jira: { externalId: "PROJ-456" } } },
              ...
            ]
          }
               │
               ▼
     Registry 自动将 issueUpdates 合并到 report.issues
               │
               ▼
     返回 { results, updatedReport }  ← updatedReport 含 externalRefs
               │
               ▼
     CLI: 持久化 updatedReport 为 JSON（供下次 --previous-review 使用）


═══ 修复验证流程（--verify-fixes --previous-review prev.json）═══

当前 ReviewReport + prev.json
     │
     ▼
ReporterRegistry.syncAll(["jira"], report, prevReport, context, configs)
     │
     ▼
jiraReporter.syncStatus(report, prevReport)
     │
     ├── fix_verification[i].status == 'fixed'
     │    └──▶ JIRA API: transition PROJ-456 → Done + 添加 comment
     │
     ├── fix_verification[i].status == 'missed'
     │    └──▶ JIRA API: 添加 comment "仍未修复"
     │
     └── fix_verification[i].status == 'false_positive'
          └──▶ JIRA API: transition → Won't Fix + comment
```

### 7.1 并行 vs 串行

- **formatter** 类型插件：串行执行（输出顺序确定）
- **exporter** 类型插件：可并行执行（彼此无依赖）
- formatter 先执行，exporter 后执行（确保 stdout 输出不被 exporter 日志干扰）

---

## 8. 第三方插件加载

支持从目录加载自定义 Reporter：

```bash
argus review /repo feat main --reporter-dirs ./my-reporters
```

### 8.1 自定义插件规范

```typescript
// my-reporters/slack-reporter.ts
import type { ReporterPlugin } from 'code-argus/reporters';

const plugin: ReporterPlugin = {
  name: 'slack',
  description: '发送审查摘要到 Slack channel',
  type: 'exporter',
  async execute(report, context, config) {
    // Slack webhook 调用...
    return { reporter: 'slack', success: true };
  },
};

export default plugin;
```

### 8.2 加载机制

与现有 `custom-agents` 加载机制对齐：

1. 扫描目录下的 `*-reporter.ts` / `*-reporter.js` 文件
2. 动态 import
3. 验证导出对象符合 `ReporterPlugin` 接口
4. 注册到 `ReporterRegistry`

---

## 9. 对现有代码的影响

### 9.1 需要修改的文件

| 文件                                   | 变更                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/review/report.ts`                 | `formatReport()` 改为调用 `ReporterRegistry`；原 `formatAs*` 函数保留但标记 `@deprecated` |
| `src/review/types.ts`                  | `ReportOptions.format` 扩展为 `string`；`ValidatedIssue` 新增 `externalRefs?` 字段        |
| `src/review/index.ts`                  | 新增导出 reporters 模块                                                                   |
| `src/index.ts`                         | CLI 解析新增 `--reporters`、`--reporter-opt`、`--reporter-dirs` 参数                      |
| `src/review/streaming-orchestrator.ts` | review 完成后调用 registry.executeAll()                                                   |

### 9.2 不需要修改的文件

- Agent 相关代码（agent-selector, streaming-validator 等）
- Git 相关代码
- 所有 Agent prompt 文件

### 9.3 向后兼容保证

- `formatAsMarkdown()` 等函数保留导出，标记 `@deprecated`
- `--format` CLI 参数继续可用，内部映射到 `--reporters`
- 默认行为不变：不传参时输出 Markdown

---

## 10. 测试策略

| 测试类型  | 内容                                                        |
| --------- | ----------------------------------------------------------- |
| 单元测试  | 每个内置 Reporter 的 execute() 输出与原 formatAs\* 函数一致 |
| 集成测试  | ReporterRegistry 多插件批量执行                             |
| JIRA 测试 | dryRun 模式验证映射逻辑；mock HTTP 验证 API 调用            |
| CLI 测试  | `--reporters` 参数解析、`--reporter-opt` 配置传递           |
| 兼容测试  | `--format markdown` 行为与改造前完全一致                    |

---

## 11. 实施步骤

| 阶段        | 内容                                                    | 风险                     |
| ----------- | ------------------------------------------------------- | ------------------------ |
| **Phase 1** | 创建 `reporters/` 目录，定义接口和注册中心              | 低                       |
| **Phase 2** | 迁移 4 个内置 formatter 为插件（保留原函数 deprecated） | 低                       |
| **Phase 3** | 实现 JIRA Reporter 插件                                 | 中（需要 JIRA API 集成） |
| **Phase 4** | 改造 CLI 支持 `--reporters` / `--reporter-opt`          | 低                       |
| **Phase 5** | 支持 `--reporter-dirs` 加载第三方插件                   | 低                       |
| **Phase 6** | 补充测试 + 文档                                         | 低                       |

建议按 Phase 顺序逐步推进，每个 Phase 可独立提交。

---

## 12. 数据模型变更

### 12.1 ValidatedIssue 扩展

在现有 `ValidatedIssue` 接口中新增 `externalRefs` 字段：

```typescript
// src/review/types.ts

export interface ValidatedIssue extends RawIssue {
  validation_status: ValidationStatus;
  grounding_evidence: GroundingEvidence;
  final_confidence: number;
  rejection_reason?: string;
  revised_description?: string;
  revised_severity?: Severity;

  // ✅ 新增：外部系统引用（由 reporter 插件回写）
  externalRefs?: Record<string, ExternalReference>;
}
```

这是一个可选字段，不影响现有逻辑。只有当 exporter 插件返回 `issueUpdates` 时，
`ReporterRegistry.executeAll()` 才会将其合并进去。

### 12.2 回写合并逻辑（Registry 内部）

```typescript
// ReporterRegistry.executeAll 内部逻辑示意：
function applyIssueUpdates(report: ReviewReport, updates: IssueUpdate[]): ReviewReport {
  const issueMap = new Map(report.issues.map((i) => [i.id, i]));

  for (const update of updates) {
    const issue = issueMap.get(update.issueId);
    if (!issue) continue;

    // 合并 externalRefs（不覆盖已有的）
    if (update.externalRefs) {
      issue.externalRefs = {
        ...issue.externalRefs,
        ...update.externalRefs,
      };
    }
  }

  return { ...report, issues: Array.from(issueMap.values()) };
}
```

### 12.3 生命周期概览

```
第一次 Review:
  Agent 发现 issue → 验证 → 聚合 → Report
  → JIRA Reporter: 创建 PROJ-456，回写 externalRefs.jira
  → 持久化 report-v1.json (issues[0].externalRefs.jira.externalId = "PROJ-456")

第二次 Review (--previous-review report-v1.json --verify-fixes):
  Agent 重新审查 → Fix Verification 发现 issue 已修复
  → JIRA Reporter syncStatus(): transition PROJ-456 → Done
  → 新 issue 继续创建新 JIRA ticket
  → 持久化 report-v2.json
```
