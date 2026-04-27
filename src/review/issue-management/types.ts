/**
 * Issue Management Plugin Type Definitions
 *
 * Defines the plugin interface for issue persistence and lifecycle management.
 * Each plugin manages issues in a different storage system (local file, JIRA, etc.).
 */

import type { ValidatedIssue } from '../types.js';

// ============================================================================
// Issue Status
// ============================================================================

/**
 * Issue status in the issue management system
 */
export type IssueStatus = 'open' | 'resolved' | 'ignored';

// ============================================================================
// Plugin Context
// ============================================================================

/**
 * Context provided to plugin methods
 */
export interface PluginContext {
  /** Repository path */
  repoPath: string;
  /** Source branch/ref */
  sourceRef: string;
  /** Target branch/ref */
  targetRef?: string;
  /** Branch name (derived from sourceRef) */
  branch: string;
  /** Output language */
  language: 'en' | 'zh';
}

// ============================================================================
// Plugin Results
// ============================================================================

/**
 * Result of query() operation
 */
export interface QueryResult {
  /** Issues retrieved from external system (all statuses) */
  issues: ValidatedIssue[];
}

/**
 * Result of save() operation
 */
export interface SaveResult {
  /** Failed saves with error details */
  failed: Array<{ issue: ValidatedIssue; error: string }>;
  /** Additional information */
  info?: Record<string, unknown>;
}

/**
 * Result of sync() operation
 */
export interface SyncResult {
  /** Failed syncs with error details */
  failed: Array<{ issue: ValidatedIssue; error: string }>;
  /** Additional information */
  info?: Record<string, unknown>;
}

// ============================================================================
// Plugin Configuration
// ============================================================================

/**
 * Base plugin configuration (passed via config file)
 */
export interface PluginConfig {
  /** Plugin-specific key-value configuration */
  [key: string]: unknown;
}

// ============================================================================
// Diff Analysis Result
// ============================================================================

/**
 * Result of diff analysis between current and existing issues
 */
export interface DiffAnalysisResult {
  /** New issues (not in existing) */
  newIssues: ValidatedIssue[];
  /** Issues that match existing ones by position (need fix verify) */
  matchedExisting: ValidatedIssue[];
  /** Issues from existing that have no match in current */
  unmatchedExisting: ValidatedIssue[];
}

// ============================================================================
// Issue Management Plugin Interface
// ============================================================================

/**
 * Issue Management Plugin interface
 *
 * Each plugin manages issue persistence in a different system:
 * - LocalFilePlugin: JSON files in .argus/issues/
 * - JiraPlugin: JIRA tickets with labels
 *
 * Only ONE plugin can be active at a time.
 */
export interface IssueManagementPlugin {
  /** Unique plugin name */
  name: string;

  /** Plugin description */
  description: string;

  /**
   * Validate configuration before review starts.
   * Perform runtime checks (e.g., API connectivity, directory permissions).
   * Called once before the review begins; if it throws, the review aborts early.
   *
   * @param config - Plugin configuration
   * @throws Error if the plugin is not usable
   */
  validate(config: PluginConfig): Promise<void>;

  /**
   * Query existing issues from the external system.
   * Should return ALL statuses (open, resolved, ignored) for complete diff analysis.
   *
   * @param context - Plugin execution context
   * @param config - Plugin configuration
   * @returns All existing issues for this branch
   */
  query(context: PluginContext, config: PluginConfig): Promise<QueryResult>;

  /**
   * Save issues to the external system.
   * For new issues, create external resources.
   * For changed issues, update external resources.
   *
   * IMPORTANT: For JiraPlugin, after successful save, the issue.id should be
   * replaced with the JIRA ticket key (e.g., "COL-13").
   *
   * @param newIssues - Issues to create
   * @param changedIssues - Issues to update
   * @param context - Plugin execution context
   * @param config - Plugin configuration
   * @returns Save result with any failures
   */
  save(
    newIssues: ValidatedIssue[],
    changedIssues: ValidatedIssue[],
    context: PluginContext,
    config: PluginConfig
  ): Promise<SaveResult>;

  /**
   * Sync issue status to external system.
   * Called when issue status changes (e.g., after fix verify).
   *
   * @param issues - Issues with status changes
   * @param context - Plugin execution context
   * @param config - Plugin configuration
   * @returns Sync result with any failures
   */
  sync(issues: ValidatedIssue[], context: PluginContext, config: PluginConfig): Promise<SyncResult>;
}
