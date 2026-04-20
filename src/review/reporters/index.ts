/**
 * Reporter Plugin System
 *
 * Plugin-based report output mechanism.
 * Built-in plugins: markdown, json, summary, pr-comments, jira.
 */

import { ReporterRegistry } from './registry.js';
import { markdownReporter } from './markdown-reporter.js';
import { jsonReporter } from './json-reporter.js';
import { summaryReporter } from './summary-reporter.js';
import { prCommentsReporter } from './pr-comments-reporter.js';
import { jiraReporter } from './jira-reporter.js';

// Types
export type {
  ReporterPlugin,
  ReporterContext,
  ReporterConfig,
  ReporterResult,
  IssueUpdate,
  ExternalReference,
} from './types.js';

// Registry
export { ReporterRegistry, type ExecuteAllResult } from './registry.js';

// Built-in plugins
export { markdownReporter } from './markdown-reporter.js';
export { jsonReporter } from './json-reporter.js';
export { summaryReporter } from './summary-reporter.js';
export { prCommentsReporter } from './pr-comments-reporter.js';
export { jiraReporter } from './jira-reporter.js';

/**
 * Create a registry with all built-in reporter plugins pre-registered.
 */
export function createDefaultRegistry(): ReporterRegistry {
  const registry = new ReporterRegistry();

  registry.register(markdownReporter);
  registry.register(jsonReporter);
  registry.register(summaryReporter);
  registry.register(prCommentsReporter);
  registry.register(jiraReporter);

  return registry;
}
