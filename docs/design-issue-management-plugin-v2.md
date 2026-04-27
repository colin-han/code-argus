# Issues Management Plugin 接口设计

## 1. 设计原则

### 核心变化

1. **丢弃老的 Reporter Plugin**：完全废弃 `ReporterPlugin` 接口
2. **单一 Issue Management Plugin**：每次运行只能选择一个plugin（不能同时使用多个）
3. **Local File Plugin 作为默认选项**：提供本地 JSON 文件持久化
4. **废弃 `--previous-review` 参数**：增量信息由 plugin 自主查询
5. **配置文件驱动**：plugin配置写入项目配置文件（如 `.argus/config.json`）
6. **独立的输出控制**：使用 `--output` 参数控制终端输出格式

### 架构转变

```
┌─────────────────────────────────────────────────────────────────────┐
│                        老架构 (To Be Discarded)                      │
├─────────────────────────────────────────────────────────────────────┤
│  Orchestrator ──→ Review ──→ ReporterPlugin ──→ JIRA/GitHub/Console │
│                          ↑                                          │
│                    --previous-review                                │
│                    (手动传递上次的 issues)                           │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                        新架构 (New Design)                           │
├─────────────────────────────────────────────────────────────────────┤
│  Orchestrator ──→ Review ──→ 两个独立维度                            │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ 数据持久化维度 (Issue Management Plugin)                       │ │
│  │ --issue-management local-file | jira                           │ │
│  │                                                                  │ │
│  │ • LocalFilePlugin - 本地 .argus/issues/*.json                  │ │
│  │ • JiraPlugin      - JIRA tickets (branch:xxx 标签隔离)         │ │
│  │                                                                  │ │
│  │ 配置: issueManagement: "local-file" | "jira"                   │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ 终端输出维度 (--output)                                         │ │
│  │ 配置: output: "markdown" | "json" | "summary"                 │ │
│  │ --output 参数可覆盖配置文件                                      │ │
│  │                                                                  │ │
│  │ • markdown - 完整输出每个问题 + 汇总                             │ │
│  │ • json     - JSON 格式输出（机器可读）                           │ │
│  │ • summary  - 仅汇总信息（默认）                                  │ │
│  │                                                                  │ │
│  │ 优先级: CLI 参数 > 配置文件 > 默认值(summary)                    │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  使用示例：                                                           │
│  argus review repo feature master                    # summary 输出  │
│  argus review repo feature master --output markdown   # 完整输出    │
│  argus review repo feature master --output json       # JSON 输出   │
│  argus review repo feature master --issue-management jira           │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. 核心接口设计

### 2.1 IssueManagementPlugin 接口

```typescript
/**
 * Issue Management Plugin Interface
 *
 * 作为issues的"真相源"（Source of Truth），负责：
 * 1. 持久化：将发现的issues保存到外部系统
 * 2. 查询：从外部系统查询已存在的issues
 * 3. 同步：更新issues的状态（验证后）
 * 4. 返回：能够还原完整的 ValidatedIssue 信息
 */
export interface IssueManagementPlugin {
  /** 插件名称 */
  name: string;

  /** 插件描述 */
  description?: string;

  /**
   * 验证配置和连接
   *
   * @param config - 插件配置
   * @param options - 验证选项
   */
  validate(config: IssueManagementConfig, options?: ValidateOptions): Promise<void>;

  /**
   * 核心方法：保存issues到外部系统
   *
   * 这是review完成后的唯一调用点，plugin负责：
   * 1. 保存完整的issue信息（用于后续查询还原）
   * 2. 返回可被用于后续查询的标识信息
   *
   * @param issues - 需要保存的issues
   * @param context - 保存上下文
   * @returns 保存结果
   */
  save(issues: ValidatedIssue[], context: SaveContext): Promise<SaveResult>;

  /**
   * 核心方法：查询已存在的issues
   *
   * 这是增量review的入口点，plugin需要返回：
   * 1. 能够用于fix verification的完整 ValidatedIssue 信息
   * 2. 足够的元数据用于差异分析
   *
   * **重要**：查询时应返回所有状态的issues（包括ignored），这样在
   * 差异分析阶段可以识别出用户已忽略的问题，避免重复报告。
   *
   * @param context - 查询上下文
   * @returns 查询结果（包含完整的issue信息）
   */
  query(context: QueryContext): Promise<QueryResult>;

  /**
   * 可选方法：同步issues状态
   *
   * 在fix verification后调用，用于更新外部系统中的issue状态
   * 如果外部系统不支持状态更新（如JSON文件），可以实现为空操作
   *
   * @param updates - 状态更新
   * @param context - 同步上下文
   */
  sync?(updates: StatusUpdate[], context: SyncContext): Promise<SyncResult>;
}
```

### 2.2 类型定义

```typescript
/**
 * Issue Management Plugin 配置
 */
export interface IssueManagementConfig {
  /** 插件类型标识 */
  type: string;

  /** 其他配置项（由各plugin自行定义） */
  [key: string]: unknown;
}

/**
 * 验证选项
 */
export interface ValidateOptions {
  /** 跳过连接测试（仅验证配置完整性） */
  skipConnectionTest?: boolean;
}

/**
 * 保存上下文
 */
export interface SaveContext {
  /** 源分支 */
  sourceBranch: string;

  /** 目标分支 */
  targetBranch: string;

  /** 仓库路径 */
  repoPath: string;

  /** 审查元数据（用于生成description等） */
  reviewMetadata: {
    sourceRef?: string;
    targetRef?: string;
    commitHash?: string;
    timestamp: string;
  };

  /** 插件配置 */
  config: IssueManagementConfig;
}

/**
 * 保存结果
 */
export interface SaveResult {
  /** 成功保存的issues数量 */
  savedCount: number;

  /** 保存失败的issues */
  failed: Array<{
    issue: ValidatedIssue;
    error: string;
  }>;

  /** 插件特定的返回信息（如JIRA issue keys） */
  info?: Record<string, unknown>;
}

/**
 * 查询上下文
 */
export interface QueryContext {
  /** 源分支（用于过滤特定分支的issues） */
  sourceBranch: string;

  /** 目标分支 */
  targetBranch: string;

  /** 仓库路径 */
  repoPath: string;

  /**
   * 可选的过滤条件
   *
   * 注意：默认情况下，query 应返回所有状态的issues（包括ignored），
   * 这样可以在差异分析时避免重复报告已忽略的问题。
   */
  filters?: {
    /** 可选：只查询特定状态的issues（通常不使用） */
    status?: IssueStatus[];
  };

  /** 插件配置 */
  config: IssueManagementConfig;
}

/**
 * 查询结果
 *
 * **关键**：返回完整的 ValidatedIssue 信息，用于增量review和fix verification
 */
export interface QueryResult {
  /** 查询到的issues（完整信息，可直接用于fix verification） */
  issues: ValidatedIssue[];

  /** 查询元数据 */
  metadata: {
    /** 查询时间 */
    timestamp: string;

    /** 匹配的分支 */
    branch: string;

    /** issues总数 */
    totalCount: number;

    /** 插件特定的元数据 */
    pluginInfo?: Record<string, unknown>;
  };
}

/**
 * 状态更新
 */
export interface StatusUpdate {
  /** argus issue ID */
  issueId: string;

  /** 新的验证状态 */
  newStatus: IssueStatus;

  /** 验证证据 */
  evidence?: GroundingEvidence;

  /** 备注（可选，用于添加comment等） */
  comment?: string;
}

/**
 * Argus Issue 状态
 */
export type IssueStatus =
  | 'open' // 开放：问题存在，需要修复
  | 'resolved' // 已解决：问题已修复
  | 'ignored'; // 已忽略：用户手工标记不需要修复

/**
 * 同步上下文
 */
export interface SyncContext extends QueryContext {
  /** 当前审查的所有issues */
  currentIssues: ValidatedIssue[];
}

/**
 * 同步结果
 */
export interface SyncResult {
  /** 成功同步的数量 */
  syncedCount: number;

  /** 同步失败的updates */
  failed: Array<{
    issueId: string;
    error: string;
  }>;
}
```

---

## 3. 插件职责

### 3.1 Local File Plugin 职责

| 职责         | 说明                                             |
| ------------ | ------------------------------------------------ |
| **保存**     | 将issues保存为本地JSON文件                       |
| **查询**     | 读取本地JSON文件，还原完整的 ValidatedIssue 信息 |
| **同步**     | （可选）更新文件中的issue状态                    |
| **文件管理** | 处理文件命名、目录结构、历史版本等               |

### 3.2 JIRA Plugin 职责

| 职责         | 说明                                                                                 |
| ------------ | ------------------------------------------------------------------------------------ |
| **保存**     | 为新issues创建JIRA ticket                                                            |
| **查询**     | 查询JIRA中已存在的tickets（**仅未完成的**），从description中还原 ValidatedIssue 信息 |
| **同步**     | 更新JIRA ticket状态（添加comment、关闭issue等）                                      |
| **标签管理** | 使用 `branch:{name}` 标签实现分支级别隔离                                            |

**重要**：JIRA Plugin 查询时会自动过滤掉已完成的issues（如 status = Done, Closed, Resolved 等），只返回"进行中"的issues用于增量review。

### 3.3 其他可能的 Plugin

| Plugin            | 职责                                      |
| ----------------- | ----------------------------------------- |
| **GitHub Issues** | 创建GitHub issues，使用labels进行分支隔离 |
| **GitLab Issues** | 创建GitLab issues，使用labels进行分支隔离 |

### 3.4 Plugin 选择

**重要**：每次运行只能选择一个 Issue Management Plugin

```bash
# 使用本地文件（默认）
argus review --branch feature/add-auth

# 使用JIRA
argus review --branch feature/add-auth --issue-management jira
```

在项目配置文件中设置默认plugin：

```json
{
  "issueManagement": "jira"
}
```

---

## 4. Labels 策略（用于远程系统）

### 4.1 标签规范

```typescript
const LABELS = {
  // === 识别标签 ===
  IDENTITY: ['code-review', 'auto-generated'],

  // === 分支标签（核心！）===
  BRANCH: (branch: string) => `branch:${branch}`,

  // === 类别标签 ===
  CATEGORY: {
    security: 'security',
    logic: 'logic',
    performance: 'performance',
    style: 'style',
    maintainability: 'maintainability',
  },
};
```

### 4.2 JQL 查询示例

```
project = "COL" AND
labels = "code-review" AND
labels = "auto-generated" AND
labels = "branch:feature/add-auth" AND
status IN ("TO DO", "IN PROGRESS")  -- 根据状态映射配置
```

---

## 5. Issue 状态管理

### 5.1 Argus Issue 状态

```typescript
/**
 * Argus Issue 状态（简化后）
 */
export type IssueStatus =
  | 'open' // 开放：问题存在，需要修复
  | 'resolved' // 已解决：问题已修复
  | 'ignored'; // 已忽略：用户手工标记不需要修复
```

**状态转换图**：

```
     ┌─────────┐
     │  open   │  (初始状态，新发现的issue)
     └────┬────┘
          │
    ┌─────┴────────┐
    ▼              ▼
┌─────────┐   ┌─────────┐
│resolved│   │ ignored │
└────┬────┘   └─────────┘
     │
     │ (用户可以重新激活)
     ▼
┌─────────┐
│  open   │
└─────────┘
```

**转换触发条件**：

| 当前状态   | 目标状态   | 触发方式                          | 说明                             |
| ---------- | ---------- | --------------------------------- | -------------------------------- |
| `open`     | `resolved` | Fix Verify 确认已修复             | 问题已被正确修复                 |
| `open`     | `ignored`  | 用户手工标记/ Fix Verify 确认误报 | 用户决定忽略此问题               |
| `resolved` | `open`     | 用户手工标记                      | 用户决定重新激活此问题           |
| `ignored`  | `open`     | 用户手工标记                      | 用户决定重新激活此问题           |
| `ignored`  | `resolved` | (不推荐)                          | 用户改变主意，决定修复并确认完成 |

**关键规则**：

1. `ignored` 状态的issue **不会被** Fix Verify 验证
2. `ignored` 状态的issue 在差异分析中会被识别（避免重复报告）
3. 状态变化由 plugin.sync() 同步到外部系统（如JIRA）

### 5.2 JIRA 状态映射

```typescript
/**
 * JIRA 状态映射配置
 */
interface JiraStatusMapping {
  /** 开放状态对应的 JIRA 状态（查询时使用，更新时用第一个） */
  open?: string[];

  /** 已解决状态对应的 JIRA 状态（查询时使用，更新时用第一个） */
  resolved?: string[];

  /** 已忽略状态对应的 JIRA 状态（查询时使用，更新时用第一个） */
  ignored?: string[];
}
```

**配置示例**：

```jsonc
{
  "jira": {
    "statusMapping": {
      "open": ["TO DO", "IN PROGRESS", "IN REVIEW"],
      "resolved": ["DONE", "CLOSED"],
      "ignored": ["CANCELED", "ARCHIVED"],
    },
  },
}
```

**查询逻辑**：

```javascript
// 查询所有 "open" 状态的 issues
const jqlStatuses = statusMapping.open.join('", "');
// 生成: status IN ("TO DO", "IN PROGRESS", "IN REVIEW")
```

**更新逻辑**：

```javascript
// 将 issue 标记为 "resolved"
const targetStatus = statusMapping.resolved[0];
// 使用第一个状态: "DONE"
```

### 5.3 ValidatedIssue 类型更新

```typescript
/**
 * ValidatedIssue 类型（更新后）
 */
export interface ValidatedIssue {
  /**
   * Issue 唯一标识，具有双重用途：
   * - 本地生成：初始为 UUID，用于本地去重和跟踪
   * - 外部引用：保存到 JIRA 后，替换为 JIRA ticket key（如 "COL-13"）
   * - 状态同步：直接用此 id 更新对应的外部系统 issue
   */
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

  // === 变更部分 ===
  /** Issue 状态（替代 validation_status） */
  status: IssueStatus;

  /** 验证证据（保留） */
  grounding_evidence: GroundingEvidence;

  /** 最终置信度（保留） */
  final_confidence: number;
}
```

**ID 字段的生命周期**：

| 阶段        | id 值                  | 说明                     |
| ----------- | ---------------------- | ------------------------ |
| Agent 发现  | UUID (如 `a1b2c3d4`)   | 本地生成，用于去重       |
| JIRA 保存后 | JIRA Key (如 `COL-13`) | 替换为外部系统 ID        |
| 状态同步    | JIRA Key (如 `COL-13`) | 用于定位和更新外部 issue |

**迁移说明**：

- `validation_status: 'pending'` → `status: 'open'`
- `validation_status: 'confirmed'` → `status: 'open'`
- `validation_status: 'rejected'` → `status: 'ignored'`（或根据用户选择）
- 新增 `status: 'ignored'` 用于手工标记

---

## 6. 新的审查流程

### 5.1 流程图

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Orchestrator                                 │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ 阶段1: Query Existing Issues                                   │ │
│  │ • 从选定的 plugin 查询已存在的issues                            │ │
│  │ • Local File: 读取 .argus/issues/{branch}.json                 │ │
│  │ • JIRA: 查询带有 branch:{branch} label 的issues（使用状态映射）  │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                 │                                   │
│                                 ▼                                   │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ 阶段2: Run Review (现有流程)                                    │ │
│  │ • 构建上下文                                                   │ │
│  │ • 运行agents                                                   │ │
│  │ • 去重 + 验证                                                  │ │
│  │ • 生成 currentIssues                                           │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                 │                                   │
│                                 ▼                                   │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ 阶段3: 差异分析                                                 │ │
│  │ • 比较 currentIssues vs existingIssues（包含所有状态）          │ │
│  │ • 识别: newIssues, changedIssues, unchangedIssues              │ │
│  │ • 识别: resolvedIssues, ignoredIssues                          │ │
│  │ • 新issue如果之前被ignored，自动继承该状态                      │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                 │                                   │
│                                 ▼                                   │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ 阶段4: Save Issues                                              │ │
│  │ • 调用 plugin.save()                                           │ │
│  │ • Local File: 保存到 .argus/issues/{branch}.json              │ │
│  │ • JIRA: 创建新的issues (添加branch label)                     │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                 │                                   │
│                                 ▼                                   │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ 阶段5: Sync Status (可选)                                       │ │
│  │ • 如果有状态变化（resolved, ignored），调用 plugin.sync()       │ │
│  │ • JIRA: 根据状态映射更新ticket状态                              │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.2 差异分析结果

```typescript
interface DiffAnalysisResult {
  /** 新发现的 issues（标记为 open） */
  newIssues: ValidatedIssue[];

  /** 精确匹配的 existing issues（需要 fix verify 验证） */
  matchedExisting: ValidatedIssue[];

  /** 未匹配的 existing issues（需要 fix verify 验证是否已解决） */
  unmatchedExisting: ValidatedIssue[];

  /** 最终合并后的所有 issues */
  allIssues: ValidatedIssue[];
}
```

**说明**：

- `newIssues`：当前发现，existing 中没有的
- `matchedExisting`：按位置精确匹配的，但需要 fix verify 验证实际状态
- `unmatchedExisting`：位置对不上的（可能是代码偏移或已删除），需要 fix verify 深度分析

### 5.3 差异分析逻辑说明

**设计原则**：差异分析只负责收集 issues，匹配和验证由 Fix Verify Agent 处理。

**关键点**：

1. **查询返回所有状态**：plugin.query() 返回所有状态的 issues（包括 ignored），这样差异分析可以识别状态继承

2. **状态继承规则**：
   - 新发现的 issue，如果 existing 中有相同位置且状态为 `ignored` → 自动继承 `ignored` 状态
   - 新发现的 issue，之前不存在或状态不是 `ignored` → 标记为 `open`

3. **位置匹配策略**：
   - 简单的位置匹配（文件 + 行号范围 + 类别）
   - 不处理复杂的位置偏移，交给 Fix Verify Agent 通过 diffContent 和代码工具判断

4. **Fix Verify 的作用**：
   - 验证 existing issues 是否已修复/误报/过时
   - Agent 可以看到当前 diff，使用 Read/Grep 工具深度分析代码
   - Agent 自己处理位置偏移、代码重构等复杂情况

---

## 7. Fix Verify（修复验证）

### 6.1 Fix Verify vs 差异分析

| 特性         | 差异分析                        | Fix Verify                              |
| ------------ | ------------------------------- | --------------------------------------- |
| **时机**     | 每次review时                    | 可选：单独运行或review后自动运行        |
| **输入**     | currentIssues vs existingIssues | previousReview.issues + 当前diff        |
| **处理方式** | 轻量级比较                      | Agent深度代码分析                       |
| **输出**     | 状态变化                        | 修复状态（fixed/missed/false_positive） |
| **目的**     | 识别新增和变化的问题            | 验证之前的问题是否被正确修复            |

### 6.2 Fix Verify 流程

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Fix Verifier Agent                             │
│                                                                      │
│  Phase 1: 快速筛查 (Batch Screening)                                │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ 对每个 previous issue 快速分类:                                  │ │
│  │ • resolved - 清晰的修复证据                                     │ │
│  │ • unresolved - 问题仍然存在                                     │ │
│  │ • unclear - 需要深入调查                                       │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                 │                                   │
│                                 ▼                                   │
│  Phase 2: 深度验证 (Deep Investigation)                             │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ 对 unresolved/unclear issues 深入分析:                          │ │
│  │ • 使用 Read/Grep/Glob 工具检查代码                             │ │
│  │ • 区分: missed（真没修）vs false_positive（误报）              │ │
│  │ • 提供更新后的issue描述（如果是missed）                         │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  输出: FixVerificationSummary                                        │
│  • fixed: 已修复的数量                                             │
│  • missed: 未修复的数量                                            │
│  • false_positive: 误报的数量                                      │
│  • obsolete: 已过时的数量                                         │
│  • uncertain: 不确定的数量                                         │
└─────────────────────────────────────────────────────────────────────┘
```

### 6.3 Fix Verify 结果映射到 Issue 状态

```typescript
// Fix Verify 结果 → Argus Issue 状态
const STATUS_MAPPING: Record<VerificationStatus, IssueStatus> = {
  fixed: 'resolved', // 已修复 → 已解决
  missed: 'open', // 未修复 → 仍开放
  false_positive: 'ignored', // 误报 → 已忽略
  obsolete: 'resolved', // 已过时 → 已解决
  uncertain: 'open', // 不确定 → 仍开放
};
```

**说明**：

- Fix verify 确认问题已修复 → issue 状态变为 `resolved`
- Fix verify 发现是误报 → issue 状态变为 `ignored`
- Fix verify 发现未修复 → issue 状态保持 `open`

### 6.4 Fix Verify 与 Plugin Sync 的关系

```
┌─────────────────────────────────────────────────────────────────────┐
│ 完整的 Issue 生命周期                                                 │
│                                                                      │
│  运行 N: argus review repo branch-A master                         │
│    → 差异分析发现 10 个新issues                                    │
│    → 保存到 plugin (状态: open)                                     │
│                                                                      │
│  运行 N+1: argus review repo branch-A master                         │
│    → 差异分析发现 3 个新issues + 10 个已存在的issues                   │
│    → 自动运行 Fix Verify 验证这10个issues                           │
│    → Fix verify 结果: 5 fixed, 3 missed, 2 false_positive            │
│    → 更新 issue 状态并保存                                          │
│    → 调用 plugin.sync() 同步到 JIRA                                 │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

**关键点**：

1. 差异分析识别已存在的issues
2. Fix verify 深度分析这些issues的修复状态
3. 根据验证结果更新issue状态
4. Plugin sync 将状态变化同步到外部系统（如JIRA）

---

## 8. 终端输出设计

### 8.1 设计原则

终端输出是一个**独立的维度**，与 Issue Management Plugin 分离：

| 维度             | 控制方式                 | 目的               |
| ---------------- | ------------------------ | ------------------ |
| Issue Management | 配置文件 + CLI 参数      | 数据持久化到哪里   |
| Output 格式      | 仅 CLI 参数 (`--output`) | 用户在终端看到什么 |

**关键决策**：

- Output 格式**不在配置文件中**配置
- 每次运行时通过 CLI 参数灵活选择
- 单选（不支持多选），因为多选没有实际价值

### 8.2 输出格式选项

#### summary（默认）

仅输出汇总信息，适合快速了解审查结果：

```
Code Review Summary for feature/add-auth → master

✓ Review completed
  Total issues found: 12
  - Critical: 1
  - Error: 3
  - Warning: 6
  - Suggestion: 2

  By category:
  - Security: 2
  - Logic: 5
  - Performance: 1
  - Style: 4

  Status changes:
  - New: 8
  - Resolved: 3
  - Ignored: 1

  Issues saved to: /path/to/repo/.argus/issues/feature-auth.json
```

#### markdown

完整输出每个问题的详细信息，适合人工审查：

````markdown
# Code Review Report: feature/add-auth → master

## Summary

- **Total Issues**: 12
- **Critical**: 1 | **Error**: 3 | **Warning**: 6 | **Suggestion**: 2

---

## 🔴 Critical Issues

### 1. Missing input validation in login handler

**File**: `src/auth/login.ts:42-45`
**Category**: Security | **Confidence**: 95%
**Agent**: security-reviewer

The login handler does not validate user input before processing...

**Code**:

```typescript
function login(username: string, password: string) {
  return db.query(`SELECT * FROM users WHERE username='${username}'`);
}
```
````

**Suggestion**:
Use parameterized queries to prevent SQL injection...

---

[... 其余问题 ...]

## Status Changes

- **New**: 8 issues
- **Resolved**: 3 issues (previously open, now fixed)
- **Ignored**: 1 issue (marked as false positive)

---

_Generated by Argus - AI Code Review_

````

#### json

机器可读的 JSON 格式输出，适合 CI/CD 集成：

```json
{
  "review": {
    "sourceBranch": "feature/add-auth",
    "targetBranch": "master",
    "timestamp": "2025-01-16T10:30:00Z",
    "repoPath": "/path/to/repo"
  },
  "summary": {
    "totalIssues": 12,
    "bySeverity": {
      "critical": 1,
      "error": 3,
      "warning": 6,
      "suggestion": 2
    },
    "byCategory": {
      "security": 2,
      "logic": 5,
      "performance": 1,
      "style": 4
    },
    "statusChanges": {
      "new": 8,
      "resolved": 3,
      "ignored": 1
    }
  },
  "issues": [
    {
      "id": "issue-xxx",
      "status": "open",
      "file": "src/auth/login.ts",
      "line_start": 42,
      "line_end": 45,
      "category": "security",
      "severity": "critical",
      "title": "Missing input validation in login handler",
      "description": "The login handler does not validate...",
      "suggestion": "Use parameterized queries...",
      "confidence": 0.95,
      "final_confidence": 0.95,
      "source_agent": "security-reviewer"
    }
    // ... 其余问题
  ]
}
````

### 8.3 输出格式与 Issue Management 的关系

**重要**：输出格式是**只读**的，不影响数据持久化

```
┌─────────────────────────────────────────────────────────────────────┐
│  执行流程                                                            │
│                                                                      │
│  1. 选择 Issue Management Plugin (local-file 或 jira)               │
│     └──> 决定数据持久化到哪里                                         │
│                                                                      │
│  2. 运行审查，生成 issues                                            │
│     └──> 生成 ValidatedIssue[]                                       │
│                                                                      │
│  3. 调用 plugin.save() 保存 issues                                   │
│     └──> 无论选择什么输出格式，数据都会被保存                        │
│                                                                      │
│  4. 根据 --output 参数生成终端输出                                   │
│     └──> 不影响数据持久化，只是用户能看到什么                        │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

**示例**：

```bash
# 数据保存到本地文件，终端只显示摘要
argus review repo feature master
# → .argus/issues/feature.json 被创建/更新
# → 终端显示 summary 格式

# 数据保存到 JIRA，终端显示完整 markdown
argus review repo feature master --issue-management jira --output markdown
# → JIRA tickets 被创建/更新
# → 终端显示完整的 markdown 报告

# 数据保存到 JIRA，终端不显示（仅保存）
argus review repo feature master --issue-management jira --output summary
# → JIRA tickets 被创建/更新
# → 终端仅显示简要摘要
```

### 8.4 输出格式实现

输出格式化由 Orchestrator 内置实现，不需要插件系统：

```typescript
// 内置的格式化器
class OutputFormatter {
  static formatSummary(issues: ValidatedIssue[], summary: ReviewSummary): string;
  static formatMarkdown(issues: ValidatedIssue[], summary: ReviewSummary): string;
  static formatJSON(issues: ValidatedIssue[], summary: ReviewSummary): string;
}
```

**为什么不需要插件化**：

- 输出格式是固定的几种，不需要用户扩展
- 如果用户需要自定义格式，可以通过处理 JSON 输出实现
- 简化系统，减少抽象层级
- 支持配置文件设置默认值，CLI 参数临时覆盖

---

## 9. CLI 参数变更

### 9.1 移除的参数

```bash
# ❌ 移除
--previous-report <path>    # 不再需要手动传递
--reporter <names>          # 被新的 --issue-management 替代
--reporter-opt <options>    # 被配置文件中的 plugin 配置替代
```

### 9.2 新增的参数

```bash
# ✅ 新增 - Issue Management Plugin 选择
--issue-management <name>   # 选择的 issue management plugin（可选）
                              # 用于临时覆盖配置文件中的设置
                              # 示例: --issue-management jira

# ✅ 新增 - 终端输出格式控制
--output <format>           # 终端输出格式（可选）
                              # 可选值: markdown | json | summary
                              # 默认值: summary
                              # 示例: --output markdown
```

### 9.3 配置文件

**保持原有设计**：

- **全局配置**：`~/.argus/config.json`
- **本地配置**：`<repoPath>/.argus/config.json`
- **优先级**：本地配置覆盖全局配置

**新增配置项**（扩展现有的 `ArgusConfig`）：

```typescript
interface ArgusConfig {
  // === 现有配置项（保持不变） ===
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  agentModel?: string;
  lightModel?: string;
  dedupModel?: string;
  maxConcurrency?: number;

  // === 新增配置项 ===

  /**
   * Issue Management Plugin 选择
   * - "local-file": 本地JSON文件（默认）
   * - "jira": JIRA集成
   * - 未来可扩展: "github", "gitlab" 等
   */
  issueManagement?: 'local-file' | 'jira';

  /**
   * 终端输出格式
   * - "summary": 仅汇总信息（默认）
   * - "markdown": 完整输出每个问题
   * - "json": 机器可读输出
   *
   * 可通过 --output CLI 参数覆盖
   */
  output?: 'summary' | 'markdown' | 'json';

  /**
   * Local File Plugin 配置
   */
  localFile?: {
    /** 输出目录（相对于repoPath，默认: .argus/issues） */
    outputDir?: string;
    /** 文件命名模式: "branch" | "timestamp" | "branch-timestamp" */
    filenamePattern?: 'branch' | 'timestamp' | 'branch-timestamp';
    /** 是否保留历史文件 */
    keepHistory?: boolean;
  };

  /**
   * JIRA Plugin 配置（扩展现有的 jira 配置）
   */
  jira?: {
    // === 现有字段（保持不变） ===
    baseUrl?: string;
    username?: string;
    apiToken?: string;
    projectKey?: string;
    issueType?: string;
    minSeverity?: string;
    labels?: string;
    dryRun?: boolean;

    /**
     * Argus Issue 状态与 JIRA 状态的映射关系
     *
     * 一个 argus 状态可以对应多个 jira 状态：
     * - 查询时：所有对应的 jira 状态都当作源 argus 状态
     * - 更新时：使用数组中第一个状态
     */
    statusMapping?: {
      /** 开放状态 -> [TO DO, IN PROGRESS] */
      open?: string[];

      /** 已解决状态 -> [DONE] */
      resolved?: string[];

      /** 已忽略状态 -> [CANCELED, ARCHIVED] */
      ignored?: string[];
    };
  };
}
```

### 9.4 配置示例

**全局配置** (`~/.argus/config.json`)：

```jsonc
{
  "apiKey": "sk-ant-xxx",
  "model": "claude-opus-4-5-20251101",
  "issueManagement": "local-file",
  "output": "summary",
}
```

**本地配置** (`<repoPath>/.argus/config.json`)：

```jsonc
{
  "issueManagement": "jira",
  "jira": {
    "projectKey": "COL",
    "baseUrl": "https://your-domain.atlassian.net",
    "username": "${JIRA_USERNAME}",
    "apiToken": "${JIRA_API_TOKEN}",
    "statusMapping": {
      "open": ["TO DO", "IN PROGRESS", "IN REVIEW"],
      "resolved": ["DONE", "CLOSED"],
      "ignored": ["CANCELED", "ARCHIVED"],
    },
  },
}
```

### 9.5 JIRA 状态映射说明

**默认映射**（如果未配置 `statusMapping`）：

```typescript
const DEFAULT_STATUS_MAPPING = {
  open: ['TO DO', 'IN PROGRESS'],
  resolved: ['DONE', 'CLOSED'],
  ignored: ['CANCELED', 'ARCHIVED'],
};
```

**查询逻辑**：

```javascript
// 查询 "open" 状态的 issues 时，JQL 为：
status IN ("TO DO", "IN PROGRESS", "IN REVIEW")
```

**更新逻辑**：

```javascript
// 将 issue 状态更新为 "resolved" 时，转换为 JIRA 状态：
transitionTo = statusMapping.resolved[0]; // 使用第一个，即 "DONE"
```

### 9.6 使用示例

```bash
# === 基本使用 ===

# 默认配置：本地文件持久化 + summary 输出
argus review /path/to/repo feature/add-auth master

# 完整的 markdown 输出
argus review /path/to/repo feature/add-auth master --output markdown

# JSON 格式输出（机器可读）
argus review /path/to/repo feature/add-auth master --output json

# === Issue Management Plugin 选择 ===

# 临时覆盖为使用 JIRA
argus review /path/to/repo feature/add-auth master --issue-management jira

# 组合使用：JIRA + markdown 输出
argus review /path/to/repo feature/add-auth master --issue-management jira --output markdown

# === 配置文件覆盖 ===

# 假设配置文件中设置了 "issueManagement": "jira"
# 可以临时切换回本地文件
argus review /path/to/repo feature/add-auth master --issue-management local-file
```

**注意**：

1. 分支信息来自位置参数：
   - `feature/add-auth` → sourceBranch（当前分支）
   - `master` → targetBranch（目标分支）

2. `--output` 参数是独立的维度，不影响数据持久化
   - 无论选择哪种输出格式，issues 都会被保存到选定的 Issue Management Plugin
   - `--output` 只控制终端显示的内容

---

## 10. Orchestrator 集成要点

### 10.1 Plugin 选择

```typescript
class StreamingOrchestrator {
  // 选定的plugin（单一）
  private issueManagementPlugin?: IssueManagementPlugin;

  // 根据配置选择plugin
  private selectPlugin(name: string): IssueManagementPlugin;

  // 获取plugin配置
  private getPluginConfig(name: string): IssueManagementConfig;
}
```

### 10.2 核心流程

```typescript
async executeReview(options: ReviewOptions): Promise<ReviewReport> {
  // 选择plugin
  const pluginName = options.issueManagement || config.issueManagement;
  const plugin = this.selectPlugin(pluginName);
  const pluginConfig = this.getPluginConfig(pluginName);

  // 1. Query existing issues（包含所有状态：open, resolved, ignored）
  const existingIssues = await plugin.query({
    sourceBranch: options.sourceBranch,
    targetBranch: options.targetBranch,
    repoPath: options.repoPath,
    config: pluginConfig,
    // 不设置 filters，查询所有状态
  });

  // 2. Run review
  const currentIssues = await this.runReview(options);

  // 3. Analyze diff（处理ignored状态的继承）
  const diff = this.analyzeDiff(currentIssues, existingIssues.issues);

  // 4. Save issues（包含状态更新）
  await plugin.save(diff.allIssues, {
    sourceBranch: options.sourceBranch,
    targetBranch: options.targetBranch,
    repoPath: options.repoPath,
    reviewMetadata: { ... },
    config: pluginConfig,
  });

  // 5. Sync status changes（resolved + ignored）
  if (diff.statusChanges.length > 0 && plugin.sync) {
    await plugin.sync(diff.statusChanges, {
      sourceBranch: options.sourceBranch,
      targetBranch: options.targetBranch,
      repoPath: options.repoPath,
      currentIssues: diff.allIssues,
      config: pluginConfig,
    });
  }

  return { issues: diff.allIssues };
}

interface DiffAnalysisResult {
  /** 所有issues（包含状态更新后的） */
  allIssues: ValidatedIssue[];

  /** 需要同步的状态变化 */
  statusChanges: StatusUpdate[];
}
```

---

## 11. 实现优先级

| 优先级 | 任务                                 | 复杂度 | 依赖   |
| ------ | ------------------------------------ | ------ | ------ |
| P0     | 定义新的 IssueManagementPlugin 接口  | 低     | 无     |
| P1     | 实现 Local File Plugin               | 低     | P0     |
| P2     | 修改 Orchestrator 以支持新的插件系统 | 高     | P0, P1 |
| P3     | 更新 CLI 参数                        | 中     | P0, P2 |
| P4     | 实现 JIRA Plugin                     | 高     | P0     |
| P5     | 编写单元测试                         | 中     | P0-P4  |
| P6     | 编写迁移文档                         | 低     | P0-P5  |
| P7     | 清理旧的 ReporterPlugin 代码         | 中     | P0-P6  |

---

## 12. 待讨论的问题（已决策）

### ✅ 已决策

1. **错误处理**：plugin操作失败时中断执行
   - save失败：立即中断，抛出错误
   - query失败：立即中断，抛出错误

2. **性能考虑**：query操作显示进度
   - 对于JIRA等网络操作，显示查询进度

3. **已完成issues的处理**：不需要单独的历史查询命令
   - 用户可以直接去JIRA查询历史
   - 历史issues仅更新状态，继续保留

4. **Local File 的历史文件管理**：继续保留
   - 历史文件保留用于追溯
   - 可以考虑添加清理命令（可选）

5. **查询所有状态**：query 时返回所有状态的issues（包括ignored）
   - 避免重复报告用户已忽略的问题
   - 新发现的issue如果之前被ignored，自动继承该状态

6. **ignore 状态的用户交互**：
   - 不需要单独的命令
   - 用户直接在JIRA上操作（关闭issue、添加comment等）
   - 下次query时会同步回来

7. **状态同步的触发时机**：
   - 自动同步
   - 在fix verify完成后自动调用 plugin.sync()

8. **ignored issues 的显示**：
   - 没有复杂的report输出
   - 仅在运行结束后报告issues状态变化的数量
   - 例如："x 新增; x 解决; x 标记为误报; x 问题仍然待解决"

9. **输出格式设计**：
   - 不作为插件系统的一部分，而是独立的维度
   - 支持配置文件设置默认值：`output: "summary" | "markdown" | "json"`
   - CLI 参数 `--output` 可覆盖配置文件
   - 优先级：CLI 参数 > 配置文件 > 默认值
   - 单选设计，不支持多选（多选没有实际价值）
   - 输出格式是只读的，不影响数据持久化
   - 由 Orchestrator 内置实现，不需要插件化
