/**
 * Reporter Plugin Type Definitions
 *
 * Defines the plugin interface for report output.
 * Each reporter converts a ReviewReport into a specific output format
 * or performs side effects (e.g., creating JIRA issues).
 */

import type { ReviewReport } from '../types.js';

// ============================================================================
// Configuration & Context
// ============================================================================

/**
 * Reporter plugin configuration (passed via CLI or config file)
 */
export interface ReporterConfig {
  /** Plugin-specific key-value configuration */
  [key: string]: unknown;
}

/**
 * Reporter plugin execution context
 */
export interface ReporterContext {
  /** Repository path */
  repoPath: string;
  /** Source branch/ref */
  sourceRef?: string;
  /** Target branch/ref */
  targetRef?: string;
  /** Output language */
  language: 'en' | 'zh';
  /** Verbose mode */
  verbose: boolean;
}

// ============================================================================
// External References & Issue Updates
// ============================================================================

/**
 * External system reference (e.g., JIRA issue)
 */
export interface ExternalReference {
  /** External system type */
  system: string;
  /** Unique ID in the external system (e.g., JIRA issue key: PROJ-123) */
  externalId: string;
  /** URL in the external system */
  url?: string;
  /** Current status in the external system */
  status?: string;
  /** Creation time */
  createdAt: string;
  /** Last update time */
  updatedAt?: string;
}

/**
 * Update for a single issue (writeback from exporter plugins)
 */
export interface IssueUpdate {
  /** Issue ID to update (corresponds to ValidatedIssue.id) */
  issueId: string;
  /** External references to write back */
  externalRefs?: Record<string, ExternalReference>;
}

// ============================================================================
// Reporter Result
// ============================================================================

/**
 * Reporter plugin execution result
 */
export interface ReporterResult {
  /** Plugin name */
  reporter: string;
  /** Whether execution succeeded */
  success: boolean;
  /** Text output (for stdout-producing plugins) */
  output?: string;
  /** Error message */
  error?: string;
  /** Plugin-specific result data */
  metadata?: Record<string, unknown>;
  /**
   * Issue update list for writeback
   * Exporter plugins can use this to write back external system IDs to issues.
   * For example, JIRA reporter writes back JIRA issue keys after creation.
   */
  issueUpdates?: IssueUpdate[];
}

// ============================================================================
// Reporter Plugin Interface
// ============================================================================

/**
 * Reporter plugin interface
 *
 * Each reporter converts a ReviewReport into one form of output.
 * Output can be text (Markdown, JSON) or side effects (JIRA issue creation).
 */
export interface ReporterPlugin {
  /** Unique plugin name, used for CLI reference */
  name: string;

  /** Plugin description */
  description: string;

  /**
   * Plugin type:
   * - 'formatter': Pure text output (e.g., markdown, json, summary)
   * - 'exporter':  Side-effect output (e.g., JIRA, Slack, webhook)
   */
  type: 'formatter' | 'exporter';

  /**
   * Validate configuration before execution.
   * Throw an error if required config is missing.
   */
  validateConfig?(config: ReporterConfig): void;

  /**
   * Validate plugin availability before review starts.
   * Perform runtime checks (e.g., API connectivity, token validity, resource existence).
   * Called once before the review begins; if it throws, the review aborts early.
   *
   * @param config - Plugin configuration
   * @throws Error if the plugin is not usable (e.g., invalid credentials, missing project)
   */
  validate?(config: ReporterConfig): Promise<void>;

  /**
   * Execute report output.
   *
   * @param report  - Complete review report
   * @param context - Execution context (repo info, language, etc.)
   * @param config  - Plugin configuration
   * @returns Execution result (async), may contain issueUpdates for writeback
   */
  execute(
    report: ReviewReport,
    context: ReporterContext,
    config: ReporterConfig
  ): Promise<ReporterResult>;

  /**
   * Sync external system status (optional).
   * Called when --verify-fixes is used, to sync issue status in external systems.
   * For example: mark a JIRA issue as fixed.
   *
   * @param report       - Current review report
   * @param prevReport   - Previous review report (containing externalRefs)
   * @param context      - Execution context
   * @param config       - Plugin configuration
   */
  syncStatus?(
    report: ReviewReport,
    prevReport: ReviewReport,
    context: ReporterContext,
    config: ReporterConfig
  ): Promise<ReporterResult>;
}
