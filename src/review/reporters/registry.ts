/**
 * Reporter Plugin Registry
 *
 * Central registry for managing and executing reporter plugins.
 */

import type { ReviewReport, ValidatedIssue } from '../types.js';
import type {
  ReporterPlugin,
  ReporterContext,
  ReporterConfig,
  ReporterResult,
  IssueUpdate,
} from './types.js';

/**
 * Result of executing all reporters
 */
export interface ExecuteAllResult {
  /** Individual results from each reporter */
  results: ReporterResult[];
  /** Updated report with issue updates (externalRefs) merged in */
  updatedReport: ReviewReport;
}

/**
 * Reporter plugin registry
 *
 * Manages plugin registration and batch execution.
 * Execution order: formatters first (sequential), then exporters (parallel).
 */
export class ReporterRegistry {
  private plugins: Map<string, ReporterPlugin> = new Map();

  /**
   * Register a plugin
   */
  register(plugin: ReporterPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Reporter plugin '${plugin.name}' is already registered`);
    }
    this.plugins.set(plugin.name, plugin);
  }

  /**
   * Get a plugin by name
   */
  get(name: string): ReporterPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Check if a plugin is registered
   */
  has(name: string): boolean {
    return this.plugins.has(name);
  }

  /**
   * Get all registered plugin names
   */
  list(): string[] {
    return Array.from(this.plugins.keys());
  }

  /**
   * Get all registered plugins
   */
  listPlugins(): ReporterPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Validate selected reporters before the review starts.
   * Calls each reporter's validate() method in parallel.
   * Throws on the first validation failure so the caller can abort early.
   *
   * Reporters without a validate() method are silently skipped.
   */
  async validateAll(
    reporterNames: string[],
    configs: Record<string, ReporterConfig> = {}
  ): Promise<void> {
    const pluginsWithValidate = reporterNames
      .filter((name) => {
        const plugin = this.plugins.get(name);
        return plugin && plugin.validate;
      })
      .map((name) => ({ name, plugin: this.plugins.get(name)! }));

    // Run all validations in parallel; fail fast on first error
    const results = await Promise.allSettled(
      pluginsWithValidate.map(({ name, plugin }) => plugin.validate!(configs[name] || {}))
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === 'rejected') {
        const name = pluginsWithValidate[i]!.name;
        const reason = (result as PromiseRejectedResult).reason;
        throw new Error(
          `Reporter '${name}' validation failed: ${reason instanceof Error ? reason.message : String(reason)}`
        );
      }
    }
  }

  /**
   * Execute selected reporters and merge issue updates back into the report.
   *
   * Execution order:
   * 1. Formatters execute sequentially (deterministic output order)
   * 2. Exporters execute in parallel (independent side effects)
   *
   * After execution, any issueUpdates from exporter results are merged
   * into the report's issues as externalRefs.
   */
  async executeAll(
    reporterNames: string[],
    report: ReviewReport,
    context: ReporterContext,
    configs: Record<string, ReporterConfig> = {}
  ): Promise<ExecuteAllResult> {
    const results: ReporterResult[] = [];
    const allIssueUpdates: IssueUpdate[] = [];

    // Validate all requested reporters exist
    for (const name of reporterNames) {
      if (!this.plugins.has(name)) {
        results.push({
          reporter: name,
          success: false,
          error: `Reporter plugin '${name}' is not registered. Available: ${this.list().join(', ')}`,
        });
      }
    }

    // Separate formatters and exporters
    const validNames = reporterNames.filter((name) => this.plugins.has(name));
    const formatters = validNames.filter((name) => this.plugins.get(name)!.type === 'formatter');
    const exporters = validNames.filter((name) => this.plugins.get(name)!.type === 'exporter');

    // Execute formatters sequentially (output order matters)
    for (const name of formatters) {
      const plugin = this.plugins.get(name)!;
      const config = configs[name] || {};

      try {
        // Validate config if the plugin supports it
        if (plugin.validateConfig) {
          plugin.validateConfig(config);
        }

        const result = await plugin.execute(report, context, config);
        results.push(result);

        if (result.issueUpdates) {
          allIssueUpdates.push(...result.issueUpdates);
        }
      } catch (error) {
        results.push({
          reporter: name,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Execute exporters in parallel (independent side effects)
    if (exporters.length > 0) {
      const exporterPromises = exporters.map(async (name) => {
        const plugin = this.plugins.get(name)!;
        const config = configs[name] || {};

        try {
          if (plugin.validateConfig) {
            plugin.validateConfig(config);
          }

          return await plugin.execute(report, context, config);
        } catch (error) {
          return {
            reporter: name,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          } satisfies ReporterResult;
        }
      });

      const exporterResults = await Promise.all(exporterPromises);
      for (const result of exporterResults) {
        results.push(result);
        if (result.issueUpdates) {
          allIssueUpdates.push(...result.issueUpdates);
        }
      }
    }

    // Apply issue updates to report
    const updatedReport =
      allIssueUpdates.length > 0 ? applyIssueUpdates(report, allIssueUpdates) : report;

    return { results, updatedReport };
  }

  /**
   * Sync external system status for all reporters that support it.
   * Called during fix verification to update external issue status.
   */
  async syncAll(
    reporterNames: string[],
    report: ReviewReport,
    prevReport: ReviewReport,
    context: ReporterContext,
    configs: Record<string, ReporterConfig> = {}
  ): Promise<ReporterResult[]> {
    const results: ReporterResult[] = [];

    const syncPromises = reporterNames
      .filter((name) => {
        const plugin = this.plugins.get(name);
        return plugin && plugin.syncStatus;
      })
      .map(async (name) => {
        const plugin = this.plugins.get(name)!;
        const config = configs[name] || {};

        try {
          if (plugin.validateConfig) {
            plugin.validateConfig(config);
          }

          return await plugin.syncStatus!(report, prevReport, context, config);
        } catch (error) {
          return {
            reporter: name,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          } satisfies ReporterResult;
        }
      });

    const syncResults = await Promise.all(syncPromises);
    results.push(...syncResults);

    return results;
  }
}

/**
 * Apply issue updates from reporter results to the report.
 * Merges externalRefs into matching issues without overwriting existing refs.
 */
function applyIssueUpdates(report: ReviewReport, updates: IssueUpdate[]): ReviewReport {
  const issueMap = new Map(report.issues.map((i) => [i.id, { ...i }]));

  for (const update of updates) {
    const issue = issueMap.get(update.issueId);
    if (!issue) continue;

    // Merge externalRefs (don't overwrite existing ones from other systems)
    if (update.externalRefs) {
      issue.externalRefs = {
        ...issue.externalRefs,
        ...update.externalRefs,
      };
    }
  }

  return {
    ...report,
    issues: report.issues.map((i) => issueMap.get(i.id) || i) as ValidatedIssue[],
  };
}
