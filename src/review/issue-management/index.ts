/**
 * Issue Management Plugin System
 *
 * Provides plugins for persisting and managing code review issues:
 * - LocalFilePlugin: Local JSON file storage (.argus/issues/{branch}.json)
 * - JiraPlugin: JIRA integration with branch isolation
 */

// Types
export type {
  // Plugin interface
  IssueManagementPlugin,
  // Context and config
  PluginContext,
  PluginConfig,
  // Results
  QueryResult,
  SaveResult,
  SyncResult,
  // Issue status
  IssueStatus,
  // Diff analysis
  DiffAnalysisResult,
} from './types.js';

// Plugins
export { LocalFilePlugin, localFilePlugin } from './local-file-plugin.js';
export { JiraPlugin, jiraPlugin } from './jira-plugin.js';

// Diff analyzer
export { analyzeDiff } from '../diff-analyzer.js';
