# Issue Management Plugin 改进计划

## 概述

本文档详细描述新的 IssueManagementPlugin 系统的完整改进计划。新设计将 issue 管理（持久化、查询、状态同步）从简单的报告输出中分离出来，形成一个独立且功能完整的子系统。

---

## 1. 架构对比

### 1.1 现有架构 (ReporterPlugin)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Orchestrator ──→ Review ──→ ReporterRegistry                      │
│                                                                      │
│  多个 Reporter (可同时使用):                                         │
│  ├─ Formatter (formatter类型, 顺序执行)                            │
│  │  ├─ markdown                                                     │
│  │  ├─ json                                                         │
│  │  └─ summary                                                      │
│  └─ Exporter (exporter类型, 并行执行)                              │
│     └─ jira                                                         │
│                                                                      │
│  增量审查依赖:                                                       │
│  └─ --previous-report 参数 (手动传递历史数据)                       │
└─────────────────────────────────────────────────────────────────────┘
```

**现有架构的问题**：

1. Reporter 混合了两种职责：输出格式化和外部系统集成
2. 增量审查需要用户手动管理历史文件
3. JIRA reporter 只能创建 issue，无法有效支持增量审查
4. 多个 reporter 同时执行导致状态管理复杂
5. 没有"问题状态"的概念，只有验证状态

### 1.2 新架构 (IssueManagementPlugin + Output)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Orchestrator ──→ Review ──→ 两个独立维度                            │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ 数据持久化维度 (Issue Management Plugin)                       │ │
│  │ 配置: issueManagement: "local-file" | "jira"                   │ │
│  │                                                                  │ │
│  │ • LocalFilePlugin - 本地 .argus/issues/*.json                  │ │
│  │ • JiraPlugin      - JIRA tickets (branch:xxx 标签隔离)         │ │
│  │                                                                  │ │
│  │ 核心能力:                                                         │ │
│  │   ├─ save()   - 保存新发现的 issues                              │ │
│  │   ├─ query()  - 查询已存在的 issues (所有状态)                   │ │
│  │   ├─ sync()   - 同步状态变化到外部系统                           │ │
│  │   └─ validate() - 验证配置和连接                                 │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ 终端输出维度 (--output)                                         │ │
│  │ CLI 参数: --output markdown | json | summary                   │
│  │                                                                  │ │
│  │ • summary (默认)  - 仅汇总信息                                   │ │
│  │ • markdown       - 完整输出每个问题                              │ │
│  │ • json           - 机器可读输出                                  │ │
│  │                                                                  │ │
│  │ 由 Orchestrator 内置实现，非插件系统                             │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  使用示例：                                                           │
│  argus review repo feature master                    # summary      │
│  argus review repo feature master --output markdown   # 完整输出    │
│  argus review repo feature master --issue-management jira           │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

**新架构的优势**：

1. **关注点分离**：数据管理与输出展示完全独立
2. **职责清晰**：Issue Management Plugin 作为 issue 生命周期的真相源
3. **自动增量**：Plugin 自主管理历史，无需用户干预
4. **状态管理**：完整的 issue 状态（open/resolved/ignored）支持
5. **灵活配置**：数据持久化和输出格式都支持配置文件，CLI 参数可覆盖
6. **分支隔离**：通过 branch:{name} label 实现多分支并行

---

## 2. 接口对比

### 2.1 方法对比

| 现有 ReporterPlugin                               | 新 IssueManagementPlugin     | 变化说明                         |
| ------------------------------------------------- | ---------------------------- | -------------------------------- |
| `validateConfig(config)`                          | 合并到 `validate()`          | 配置验证与连接验证合并为一个方法 |
| `validate(config)`                                | `validate(config, options?)` | 增加 `skipConnectionTest` 选项   |
| `execute(report, context, config)`                | 拆分为 `save()` 和 `query()` | 职责分离：保存 vs 查询           |
| `syncStatus(report, prevReport, context, config)` | `sync(updates, context)`     | 参数简化，专注于状态更新         |
| (无)                                              | `query(context)`             | 新增：查询已存在的 issues        |

### 2.2 类型对比

#### ReporterPlugin Context vs IssueManagementPlugin Context

| 现有 ReporterContext | 新 SaveContext/QueryContext | 变化说明                             |
| -------------------- | --------------------------- | ------------------------------------ |
| `repoPath`           | 保留                        | 无变化                               |
| `sourceRef`          | `sourceBranch`              | 名称更清晰，表示分支名               |
| `targetRef`          | `targetBranch`              | 名称更清晰                           |
| `language`           | 移除                        | 不需要，issue 保存为原始语言         |
| `verbose`            | 移除                        | 不需要，日志由 orchestrator 管理     |
| `authorEmail`        | 移除 save，保留 query       | Jira auto-assign 需要在 query 时获取 |
| (无)                 | `reviewMetadata`            | 新增：审查元数据                     |
| (无)                 | `config`                    | 新增：插件配置直接传递               |

#### 返回值对比

| 现有 ReporterResult           | 新 SaveResult/QueryResult       | 变化说明                |
| ----------------------------- | ------------------------------- | ----------------------- |
| `success: boolean`            | 保留                            | 无变化                  |
| `output: string`              | 移除                            | 不再返回文本输出        |
| `error: string`               | `failed: Array<{issue, error}>` | 更详细，支持部分失败    |
| `metadata: Record`            | `info?: Record`                 | 重命名，语义更清晰      |
| `issueUpdates: IssueUpdate[]` | 移除                            | 不再需要 writeback 机制 |

---

## 3. 配置系统变化

### 4.1 CLI 参数变化

#### 移除的参数

| 参数                       | 说明              | 替代方案                         |
| -------------------------- | ----------------- | -------------------------------- |
| `--previous-report <path>` | 手动指定历史报告  | Plugin 自动查询                  |
| `--reporter <names>`       | 选择多个 reporter | `--issue-management <name>`      |
| `--reporter-opt <options>` | Reporter 配置     | 配置文件中的 `issueManagement.*` |

#### 新增的参数

| 参数                        | 说明                                  | 可选值                        | 配置支持 | 示例                      |
| --------------------------- | ------------------------------------- | ----------------------------- | -------- | ------------------------- |
| `--issue-management <name>` | 临时覆盖 Issue Management Plugin 选择 | `local-file`, `jira`          | ✅       | `--issue-management jira` |
| `--output <format>`         | 终端输出格式控制                      | `markdown`, `json`, `summary` | ✅       | `--output markdown`       |

#### 保留的参数

所有其他参数保持不变，包括：

- 位置参数：`<repoPath> <sourceBranch> <targetBranch>`
- `--format`, `--language`, `--verbose` 等

### 4.2 配置文件变化

#### 新增配置项

```typescript
interface ArgusConfig {
  // ... 现有配置项保持不变 ...

  // === 新增 ===

  /**
   * Issue Management Plugin 选择
   * - "local-file": 本地JSON文件（默认）
   * - "jira": JIRA集成
   */
  issueManagement?: 'local-file' | 'jira';

  /**
   * Local File Plugin 配置
   */
  localFile?: {
    outputDir?: string; // 默认: .argus/issues
    filenamePattern?: 'branch' | 'timestamp' | 'branch-timestamp';
    keepHistory?: boolean; // 默认: true
  };

  /**
   * JIRA Plugin 配置（扩展现有 jira 配置）
   */
  jira?: {
    // ... 现有字段保持不变 ...

    // === 新增 ===

    /**
     * 识别标签列表（用于识别 Argus 创建的 tickets）
     * 默认值: ["code-review", "auto-generated"]
     */
    labels?: string[];

    /**
     * Argus Issue 状态与 JIRA 状态的映射关系
     */
    statusMapping?: {
      open?: string[]; // ["TO DO", "IN PROGRESS"]
      resolved?: string[]; // ["DONE", "CLOSED"]
      ignored?: string[]; // ["CANCELED", "ARCHIVED"]
    };
  };
}
```

#### 配置优先级

1. CLI 参数 `--issue-management`（最高优先级）
2. 项目配置 `<repoPath>/.argus/config.json`
3. 全局配置 `~/.argus/config.json`
4. 默认值 `"local-file"`（最低优先级）

---

## 4. Orchestrator 集成变化

### 4.1 执行流程变化

#### 现有流程

```
1. 构建上下文
2. 运行 agents
3. 去重 + 验证
4. 聚合生成 ReviewReport
5. 执行所有 Reporter (formatter 顺序, exporter 并行)
```

#### 新流程

```
1. 选择 Issue Management Plugin
2. 调用 plugin.validate() 验证配置
3. 调用 plugin.query() 查询已存在的 issues（所有状态）
4. 构建上下文
5. 运行 agents
6. 去重 + 验证
7. 聚合生成 currentIssues
8. 差异分析 (current vs existing) - 简单的位置匹配和状态继承
9. 调用 plugin.save() 保存 issues
10. 调用 Fix Verify 验证 matchedExisting 和 unmatchedExisting
11. 根据 Fix Verify 结果更新 issue 状态
12. 如果有状态变化，调用 plugin.sync() 同步
13. 根据 --output 参数生成终端输出（内置格式化器）
```

### 4.2 差异分析逻辑

#### 设计原则

差异分析采用**简化设计**，只负责收集和简单关联，复杂的匹配和验证交给 Fix Verify Agent 处理。

**理由**：

1. Fix Verify Agent 可以看到当前 diff，能自然处理代码偏移
2. Agent 有 Read/Grep 工具，可以直接读取代码进行深度分析
3. Agent 的判断比规则更准确，能理解复杂的代码变化
4. 避免过度设计，让专业的工具做专业的事

#### 差异分析结果结构

```typescript
interface DiffAnalysisResult {
  /** 新发现的 issues（标记为 open） */
  newIssues: ValidatedIssue[];

  /** 精确匹配的 existing issues（需要 fix verify 验证） */
  matchedExisting: ValidatedIssue[];

  /** 未匹配的 existing issues（需要 fix verify 深度分析） */
  unmatchedExisting: ValidatedIssue[];

  /** 最终合并后的所有 issues */
  allIssues: ValidatedIssue[];
}
```

#### 简化的匹配算法

```typescript
function analyzeDiff(
  currentIssues: ValidatedIssue[],
  existingIssues: ValidatedIssue[]
): DiffAnalysisResult {
  const existingMap = new Map<string, ValidatedIssue>();
  for (const issue of existingIssues) {
    const key = `${issue.file}:${issue.line_start}:${issue.line_end}:${issue.category}`;
    existingMap.set(key, issue);
  }

  const newIssues: ValidatedIssue[] = [];
  const matchedExisting: ValidatedIssue[] = [];
  const allIssues: ValidatedIssue[] = [];

  for (const curr of currentIssues) {
    const key = `${curr.file}:${curr.line_start}:${curr.line_end}:${curr.category}`;
    const existing = existingMap.get(key);

    if (existing) {
      // 精确位置匹配
      matchedExisting.push(existing);
      allIssues.push({
        ...curr,
        status: existing.status === 'ignored' ? 'ignored' : 'open', // 继承 ignored 状态
      });
      existingMap.delete(key);
    } else {
      // 新 issue
      newIssues.push({ ...curr, status: 'open' });
      allIssues.push({ ...curr, status: 'open' });
    }
  }

  // 剩下的 existing issues 是未匹配的
  const unmatchedExisting = Array.from(existingMap.values());

  // 将未匹配的 existing 加入 allIssues（状态保持不变，等 fix verify 判断）
  for (const issue of unmatchedExisting) {
    if (issue.status !== 'ignored') {
      allIssues.push(issue);
    }
  }

  return { newIssues, matchedExisting, unmatchedExisting, allIssues };
}
```

#### Fix Verify 的处理

| 类型                | 处理方式                                                      |
| ------------------- | ------------------------------------------------------------- |
| `newIssues`         | 跳过，直接标记为 open                                         |
| `matchedExisting`   | 验证状态变化（可能仍为 open，或变为 resolved/false_positive） |
| `unmatchedExisting` | 深度分析：可能已修复（位置对不上）、已删除、或代码偏移        |

**Fix Verify Agent 的能力**：

- ✅ 可以看到当前 diffContent，发现代码变化
- ✅ 可以使用 Read/Grep 工具直接检查代码
- ✅ 可以理解"之前在第42行的问题，现在可能偏移到了第52行"
- ✅ 可以判断问题的实际状态（fixed/missed/false_positive）

### 5.3 ReporterRegistry 变化

#### 现有实现

- 管理 `ReporterPlugin[]`
- 方法：`register()`, `executeAll()`, `validateAll()`, `syncAll()`

#### 新实现

- 管理 `IssueManagementPlugin`（单一）
- 方法：
  - `get(name)` - 获取插件
  - `register(plugin)` - 注册插件
  - `list()` - 列出所有插件
- 移除：`executeAll()`, `validateAll()`, `syncAll()`（由 orchestrator 直接调用）

### 5.4 输出格式设计

#### 格式选项

| 格式       | 说明               | 适用场景               |
| ---------- | ------------------ | ---------------------- |
| `summary`  | 仅汇总信息（默认） | 快速了解审查结果       |
| `markdown` | 完整输出每个问题   | 详细人工审查           |
| `json`     | 机器可读输出       | CI/CD 集成、自动化处理 |

#### 输出与数据持久化的关系

**关键原则**：输出格式是只读的，不影响数据持久化

```
运行 argus review repo feature master --output markdown

1. 数据持久化：由 Issue Management Plugin 处理
   └──> .argus/issues/feature.json 被创建/更新

2. 终端输出：由 Orchestrator 内置格式化器处理
   └──> 显示完整的 markdown 报告
```

**示例场景**：

```bash
# 场景 1：本地文件 + summary 输出
argus review repo feature master
# → 保存到 .argus/issues/feature.json
# → 终端显示摘要

# 场景 2：JIRA + markdown 输出
argus review repo feature master --issue-management jira --output markdown
# → 创建/更新 JIRA tickets
# → 终端显示完整报告

# 场景 3：JIRA + JSON 输出（CI/CD）
argus review repo feature master --issue-management jira --output json
# → 创建/更新 JIRA tickets
# → 终端输出 JSON（可被其他工具解析）
```

#### 输出格式的配置方式

输出格式支持两种配置方式：

1. **配置文件**：设置默认输出格式

   ```json
   {
     "output": "markdown"
   }
   ```

2. **CLI 参数**：临时覆盖配置文件
   ```bash
   argus review repo feature master --output json
   ```

**优先级**：CLI 参数 > 配置文件 > 默认值

**设计理由**：

- 用户可以设置常用的输出格式为默认值
- 需要时可以通过 CLI 参数临时切换
- 与其他配置项保持一致的行为模式

---

## 5. 类型系统变化

### 5.1 ValidatedIssue 变化

#### 现有字段

```typescript
interface ValidatedIssue {
  id: string;
  file: string;
  line_start: number;
  line_end: number;
  category: IssueCategory;
  severity: IssueSeverity;
  title: string;
  description: string;
  code_snippet?: string;
  suggestion?: string;
  confidence: number;
  source_agent: AgentType;
  validation_status: 'pending' | 'confirmed' | 'rejected' | 'uncertain';
  grounding_evidence: GroundingEvidence;
  final_confidence: number;
}
```

#### 新字段

```typescript
interface ValidatedIssue {
  // ... 保留所有现有字段，除了 validation_status ...

  // === 替换 validation_status ===
  status: 'open' | 'resolved' | 'ignored';

  // ... 其他字段保持不变 ...
}
```

---

## 6. 状态管理设计

### 6.1 Issue 状态定义

#### 新状态

| 状态       | 含义               | 触发条件                          |
| ---------- | ------------------ | --------------------------------- |
| `open`     | 问题存在，需要修复 | 初始发现、用户重新激活            |
| `resolved` | 问题已修复         | Fix Verify 确认已修复             |
| `ignored`  | 已忽略，不需要修复 | 用户手工标记、Fix Verify 确认误报 |

#### 状态转换图

```
     ┌─────────┐
     │  open   │  (初始状态)
     └────┬────┘
          │
    ┌─────┴────────┐
    ▼              ▼
┌─────────┐   ┌─────────┐
│resolved│   │ ignored │
└────┬────┘   └────┬────┘
     │            │
     │            │ (用户可重新激活)
     └────────────┴────→ open
```

### 6.2 Fix Verify 与状态

#### Fix Verify 结果映射

| Fix Verify 结果  | 映射到的 Issue 状态 | 说明             |
| ---------------- | ------------------- | ---------------- |
| `fixed`          | `resolved`          | 已修复           |
| `missed`         | `open`              | 未修复，仍需处理 |
| `false_positive` | `ignored`           | 误报，忽略       |
| `obsolete`       | `resolved`          | 已过时，视为解决 |
| `uncertain`      | `open`              | 不确定，保持开放 |

---

## 7. JIRA Plugin 详细设计

### 8.1 标签策略

#### 标签规范

| 标签类型 | 格式            | 示例                            | 用途                      |
| -------- | --------------- | ------------------------------- | ------------------------- |
| 识别标签 | 固定值          | `code-review`, `auto-generated` | 识别 Argus 创建的 tickets |
| 分支标签 | `branch:{name}` | `branch:feature/auth`           | 分支级别隔离              |
| 类别标签 | 固定值          | `security`, `logic` 等          | 标识问题类别              |

#### 分支隔离实现

- 创建 ticket 时添加 `branch:{branchName}` 标签
- 查询时通过 JQL 过滤：`labels = "branch:feature/auth"`
- 不同分支的 issues 互不干扰

### 8.2 状态映射配置

#### 默认映射

```typescript
const DEFAULT_STATUS_MAPPING = {
  open: ['TO DO', 'IN PROGRESS', 'IN REVIEW'],
  resolved: ['DONE', 'CLOSED'],
  ignored: ['CANCELED', 'ARCHIVED'],
};

const DEFAULT_LABELS = ['code-review', 'auto-generated'];
```

#### 查询逻辑

查询时需要检查**所有状态**的 issues（open、resolved、ignored），以便进行完整的差异分析：

```javascript
// 构建识别标签的 JQL 条件
const identificationLabels = this.config.labels || DEFAULT_LABELS;
const labelConditions = identificationLabels.map((label) => `labels = "${label}"`).join(' AND ');

// 收集所有可能的状态（用于查询）
const allStatuses = [...statusMapping.open, ...statusMapping.resolved, ...statusMapping.ignored];

// 查询所有状态的 issues
const jql = `project = "${this.project}" AND
             ${labelConditions} AND
             labels = "branch:${branchName}" AND
             status IN ("${allStatuses.join('", "')}")`;

// 示例生成的 JQL:
// project = "COL" AND
// labels = "code-review" AND
// labels = "auto-generated" AND
// labels = "branch:feature/auth" AND
// status IN ("TO DO", "IN PROGRESS", "IN REVIEW", "DONE", "CLOSED", "CANCELED", "ARCHIVED")
```

**说明**：

- 查询所有状态是为了完整了解当前分支的问题历史
- 后续差异分析会根据状态变化识别：新问题、已解决、被忽略等
- 如果只查询 open 状态，就无法检测到已解决的问题是否被重新引入

#### 更新逻辑

```javascript
// 将 issue 状态更新为 "resolved"
const targetStatus = statusMapping.resolved[0]; // 使用第一个
await transitionIssue(issueKey, targetStatus);
```

### 8.3 Description 格式

#### JIRA Ticket Description

```text
h3. {title}

*File:* `{file}` (Lines {line_start}-{line_end})
*Severity:* {severity}
*Category:* {category}
*Confidence:* {confidence}%
*Agent:* {source_agent}

{description}

{code_snippet}

h4. Suggestion
{suggestion}

----
_Repository: {repoPath}_
_Source: {sourceRef} → {targetRef}_
_Issue ID: {id}_
```

**说明**：

- Description 只用于人类可读的显示
- 不需要序列化完整的 JSON（Agent 可以通过 diffContent 自行分析）
- query() 返回的 issues 只用于差异分析的状态继承

### 8.4 ID 字段处理

#### ID 的双重用途

`ValidatedIssue.id` 字段在 JIRA Plugin 中具有两个阶段的不同用途：

| 阶段         | id 值                        | 说明                      |
| ------------ | ---------------------------- | ------------------------- |
| **新建前**   | UUID (如 `a1b2c3d4-e5f6...`) | Agent 生成的本地 ID       |
| **保存后**   | JIRA Key (如 `COL-13`)       | 替换为 JIRA ticket 的 key |
| **状态同步** | JIRA Key (如 `COL-13`)       | 用于定位和更新 ticket     |

#### query() 实现逻辑

```typescript
async query(context: PluginContext): Promise<ValidatedIssue[]> {
  // 1. 构建包含所有识别标签和所有状态的 JQL 查询
  const identificationLabels = this.config.labels || DEFAULT_LABELS;
  const labelConditions = identificationLabels.map(label => `labels = "${label}"`).join(' AND ');

  // 收集所有状态（查询所有状态以进行完整差异分析）
  const allStatuses = [
    ...this.statusMapping.open,
    ...this.statusMapping.resolved,
    ...this.statusMapping.ignored,
  ];

  const jql = `project = "${this.project}" AND
               ${labelConditions} AND
               labels = "branch:${context.branch}" AND
               status IN ("${allStatuses.join('", "')}")`;

  // 示例: project = "COL" AND
  //        labels = "code-review" AND
  //        labels = "auto-generated" AND
  //        labels = "branch:feature/auth" AND
  //        status IN ("TO DO", "IN PROGRESS", "IN REVIEW", "DONE", "CLOSED", "CANCELED", "ARCHIVED")

  const tickets = await this.api.search(jql);

  // 2. 从 ticket description 还原 ValidatedIssue
  const issues: ValidatedIssue[] = tickets.map(ticket => {
    return {
      // 关键：id 直接使用 JIRA ticket key
      id: ticket.key,

      // 从 description 中解析其他字段
      file: parseField(ticket.description, 'File'),
      line_start: parseField(ticket.description, 'Line Start'),
      // ... 其他字段

      // 从 status 映射回 argus status
      status: mapJiraStatusToArgus(ticket.status),
    };
  });

  return issues;
}
```

#### save() 实现逻辑

```typescript
async save(
  newIssues: ValidatedIssue[],
  changedIssues: ValidatedIssue[],
  context: PluginContext
): Promise<SaveResult> {
  const failed: Array<{issue: ValidatedIssue, error: string}> = [];

  // 1. 创建新的 tickets
  for (const issue of newIssues) {
    try {
      const ticket = await this.api.create({
        summary: issue.title,
        description: formatDescription(issue),
        labels: [...this.defaultLabels, `branch:${context.branch}`],
      });

      // 关键：将 id 替换为 JIRA ticket key
      issue.id = ticket.key;
    } catch (error) {
      failed.push({ issue, error: error.message });
    }
  }

  // 2. 更新已变更的 tickets（如果有内容变化）
  for (const issue of changedIssues) {
    try {
      // id 此时已经是 JIRA key，直接用于定位
      await this.api.update(issue.id, {
        description: formatDescription(issue),
      });
    } catch (error) {
      failed.push({ issue, error: error.message });
    }
  }

  return { failed, info: { created: newIssues.length } };
}
```

#### sync() 实现逻辑

```typescript
async sync(
  issues: ValidatedIssue[],
  context: PluginContext
): Promise<SyncResult> {
  const failed: Array<{issue: ValidatedIssue, error: string}> = [];

  for (const issue of issues) {
    try {
      // id 此时已经是 JIRA key，直接用于状态转换
      const targetStatus = this.statusMapping[issue.status][0];
      await this.api.transition(issue.id, targetStatus);
    } catch (error) {
      failed.push({ issue, error: error.message });
    }
  }

  return { failed, info: { synced: issues.length - failed.length } };
}
```

#### 关键设计决策

1. **ID 替换策略**：保存后直接替换，而非保留原始 UUID
   - **优点**：简化状态同步逻辑，不需要额外的映射表
   - **缺点**：丢失原始 UUID，但实际使用中没有影响

2. **ID 作为唯一标识**：
   - Local File Plugin：id 始终是 UUID
   - JIRA Plugin：id 在保存后变为 JIRA key
   - 两者互不干扰，因为用户只会选择一个 plugin

3. **错误处理**：
   - 如果 ticket 创建失败，id 保持原 UUID（不会影响其他 issues）
   - 如果状态同步失败，记录错误但不影响后续流程

---

## 8. Local File Plugin 设计

### 9.1 文件结构

#### 目录结构

```
.argus/
├── config.json           # 项目配置
└── issues/
    ├── feature-auth.json     # 当前分支的 issues
    ├── main.json             # main 分支的 issues
    └── .history/             # 历史文件（可选）
        ├── feature-auth.2025-01-15.json
        └── feature-auth.2025-01-16.json
```

#### 文件内容格式

```json
{
  "branch": "feature/auth",
  "timestamp": "2025-01-16T10:30:00Z",
  "sourceRef": "origin/feature/auth",
  "targetRef": "origin/main",
  "issues": [
    {
      "id": "issue-xxx",
      "status": "open",
      "file": "src/auth.ts",
      "line_start": 42,
      "line_end": 45,
      "category": "security",
      "severity": "error",
      "title": "Missing input validation",
      "description": "...",
      "suggestion": "...",
      "confidence": 0.9,
      "source_agent": "security-reviewer",
      "final_confidence": 0.9,
      "grounding_evidence": { ... }
    }
  ]
}
```

### 9.2 实现要点

#### save() 方法

1. 确保输出目录存在
2. 根据配置决定文件命名模式
3. 如果启用了 `keepHistory`，将当前文件重命名/复制到 `.history/`
4. 写入新的 issues 文件

#### query() 方法

1. 构建文件路径（基于分支名）
2. 读取文件内容
3. 解析 JSON
4. 返回 `issues` 数组

#### sync() 方法

1. 可选实现（本地文件不需要同步）
2. 可以实现为空操作或仅更新文件

---

## 9. 实现优先级

### Phase 1: 基础设施 (P0-P1)

| 任务                              | 工作量 | 产出                                               |
| --------------------------------- | ------ | -------------------------------------------------- |
| 定义 `IssueManagementPlugin` 接口 | 2天    | `src/review/issue-management/types.ts`             |
| 定义配置类型扩展                  | 1天    | 更新 `src/config/types.ts`                         |
| 实现 `LocalFilePlugin`            | 3天    | `src/review/issue-management/local-file-plugin.ts` |
| 单元测试 (LocalFilePlugin)        | 2天    | `src/review/issue-management/*.test.ts`            |

### Phase 2: Orchestrator 集成 (P2)

| 任务                         | 工作量 | 产出                          |
| ---------------------------- | ------ | ----------------------------- |
| 重构 `StreamingOrchestrator` | 5天    | 新的执行流程                  |
| 实现差异分析逻辑             | 3天    | `src/review/diff-analyzer.ts` |
| 更新 `ValidatedIssue` 类型   | 1天    | 新增状态字段                  |
| 集成测试                     | 3天    | 端到端测试                    |

### Phase 3: CLI 更新 (P3)

| 任务                           | 工作量 | 产出                        |
| ------------------------------ | ------ | --------------------------- |
| 移除 `--reporter*` 参数        | 1天    | 更新 `src/index.ts`         |
| 添加 `--issue-management` 参数 | 1天    | 更新 `src/index.ts`         |
| 更新配置加载逻辑               | 2天    | 更新 `src/config/loader.ts` |
| CLI 测试                       | 1天    | 测试脚本更新                |

### Phase 4: JIRA Plugin (P4)

| 任务                | 工作量 | 产出                                         |
| ------------------- | ------ | -------------------------------------------- |
| 实现 `JiraPlugin`   | 8天    | `src/review/issue-management/jira-plugin.ts` |
| 实现 `query()` 方法 | 3天    | JQL 查询 + 还原逻辑                          |
| 实现 `sync()` 方法  | 2天    | 状态映射 + transition                        |
| 标签策略实现        | 1天    | branch:{name} 标签                           |
| JIRA Plugin 测试    | 3天    | 集成测试 + Mock                              |

### Phase 5: 文档与清理 (P5-P7)

| 任务                 | 工作量 | 产出                         |
| -------------------- | ------ | ---------------------------- |
| 更新用户文档         | 2天    | README, 配置示例             |
| 移除旧 Reporter 代码 | 2天    | 清理 `src/review/reporters/` |
| 更新示例配置         | 1天    | `.argus/config.example`      |

**总计**: 约 46 天

---

## 10. 风险与缓解

### 10.1 技术风险

| 风险                 | 影响 | 缓解措施                   |
| -------------------- | ---- | -------------------------- |
| JIRA API 限制        | 高   | 实现查询分页、添加重试逻辑 |
| Description 大小限制 | 中   | 压缩存储、使用 attachments |
| 还原失败 (query)     | 高   | 添加降级逻辑、错误处理     |
| 并发冲突             | 中   | 文件锁、事务处理           |

---

## 11. 测试策略

### 11.1 单元测试

- Plugin 接口实现测试
- 差异分析逻辑测试
- 状态映射测试
- 配置加载测试

### 11.2 集成测试

- Local File Plugin 端到端测试
- JIRA Plugin Mock 测试
- Orchestrator 流程测试

### 11.3 手动测试

- 真实 JIRA 环境测试
- 多分支场景测试
- 增量审查测试
- Fix Verify 集成测试

---

## 12. 回滚计划

如果新系统出现重大问题：

1. **保留旧代码**：在 `src/review/reporters/` 中保留现有实现
2. **功能开关**：通过配置项启用/禁用新系统
3. **数据兼容**：确保新系统可以读取旧格式的数据

---

## 附录：关键决策记录

### A. 为什么废弃 Formatter 类型的 Reporter？

**决策**：将 markdown、json、summary 输出移至 orchestrator 直接处理

**理由**：

1. 这些输出是审查流程的固有部分，不属于"外部系统"
2. 简化架构，减少抽象层级
3. 输出格式化不需要插件化扩展

### B. 为什么单一 Plugin 而非多个？

**决策**：每次只能选择一个 Issue Management Plugin

**理由**：

1. 避免状态冲突：多个插件同时管理 issue 状态会导致一致性问题
2. 简化配置：用户不需要理解复杂的插件组合
3. 职责清晰：Issue management 是单一职责，不应分散

### C. 为什么需要 query() 方法？

**决策**：Plugin 必须实现 query() 方法

**理由**：

1. 支持增量审查：自动获取历史 issues
2. 支持状态同步：需要查询现有状态才能更新
3. 支持分支隔离：查询时自动过滤分支标签

### D. 为什么 status 需要简化？

**决策**：从 4 个验证状态简化为 3 个 issue 状态

**理由**：

1. 用户视角：用户只关心"需要修复"、"已修复"、"不需要修复"
2. 状态流转：简化状态转换，减少混淆
3. 映射清晰：与外部系统的状态映射更直观
