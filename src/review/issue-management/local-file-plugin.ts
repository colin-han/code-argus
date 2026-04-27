/**
 * Local File Issue Management Plugin
 *
 * Stores issues as JSON files in .argus/issues/ directory.
 * Each branch has its own file: {sanitized-branch-name}.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import type {
  IssueManagementPlugin,
  PluginConfig,
  PluginContext,
  QueryResult,
  SaveResult,
  SyncResult,
} from './types.js';
import type { ValidatedIssue } from '../types.js';

/**
 * Sanitize branch name for use as filename.
 * Reslashes and other special characters with hyphens.
 */
function sanitizeBranchName(branch: string): string {
  return branch.replace(/[/\\]/g, '-').replace(/[^a-zA-Z0-9-_]/g, '-');
}

/**
 * Read issues from a JSON file.
 */
function loadIssuesFromFile(filePath: string): ValidatedIssue[] {
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content);

    // Handle both array format and object format with issues property
    if (Array.isArray(data)) {
      return data as ValidatedIssue[];
    }

    if (data.issues && Array.isArray(data.issues)) {
      return data.issues as ValidatedIssue[];
    }

    return [];
  } catch {
    return [];
  }
}

/**
 * Write issues to a JSON file.
 */
function saveIssuesToFile(
  filePath: string,
  issues: ValidatedIssue[],
  context: PluginContext
): void {
  const data = {
    branch: context.branch,
    timestamp: new Date().toISOString(),
    sourceRef: context.sourceRef,
    targetRef: context.targetRef,
    issues,
  };

  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Local File Plugin implementation.
 */
export class LocalFilePlugin implements IssueManagementPlugin {
  name = 'local-file';
  description = 'Local file issue management (JSON storage in .argus/issues/)';

  /**
   * Validate - check directory write permissions.
   */
  async validate(_config: PluginConfig): Promise<void> {
    // Validation is done during actual file operations
    // No pre-validation needed for local file plugin
  }

  /**
   * Query - read issues from .argus/issues/{branch}.json
   */
  async query(context: PluginContext, _config: PluginConfig): Promise<QueryResult> {
    const issuesDir = join(context.repoPath, '.argus', 'issues');
    const branchFile = join(issuesDir, `${sanitizeBranchName(context.branch)}.json`);

    const issues = loadIssuesFromFile(branchFile);

    return { issues };
  }

  /**
   * Save - write issues to .argus/issues/{branch}.json
   */
  async save(
    newIssues: ValidatedIssue[],
    changedIssues: ValidatedIssue[],
    context: PluginContext,
    _config: PluginConfig
  ): Promise<SaveResult> {
    const failed: Array<{ issue: ValidatedIssue; error: string }> = [];
    const issuesDir = join(context.repoPath, '.argus', 'issues');
    const branchFile = join(issuesDir, `${sanitizeBranchName(context.branch)}.json`);

    try {
      // Ensure directory exists
      if (!existsSync(issuesDir)) {
        mkdirSync(issuesDir, { recursive: true });
      }

      // Load existing issues
      const existingIssues = loadIssuesFromFile(branchFile);
      const issueMap = new Map<string, ValidatedIssue>(
        existingIssues.map((issue) => [issue.id, issue])
      );

      // Add new issues
      for (const issue of newIssues) {
        issueMap.set(issue.id, { ...issue });
      }

      // Update changed issues
      for (const issue of changedIssues) {
        issueMap.set(issue.id, { ...issue });
      }

      // Save all issues
      saveIssuesToFile(branchFile, Array.from(issueMap.values()), context);
    } catch (error) {
      // If save fails, mark all issues as failed
      for (const issue of [...newIssues, ...changedIssues]) {
        failed.push({
          issue,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { failed, info: { saved: newIssues.length + changedIssues.length } };
  }

  /**
   * Sync - not needed for local file plugin.
   * Status is updated directly in the issue object during save().
   */
  async sync(
    _issues: ValidatedIssue[],
    _context: PluginContext,
    _config: PluginConfig
  ): Promise<SyncResult> {
    // Local file plugin doesn't need explicit sync
    // Status changes are saved immediately during save()
    return { failed: [], info: { synced: 0, note: 'Local file sync is implicit' } };
  }
}

/**
 * Singleton instance for use in the application.
 */
export const localFilePlugin = new LocalFilePlugin();
