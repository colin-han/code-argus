/**
 * JSON Reporter Plugin
 *
 * Formats the review report as JSON output.
 * Migrated from report.ts formatAsJson().
 */

import type { ReporterPlugin, ReporterContext, ReporterConfig, ReporterResult } from './types.js';
import type { ReviewReport } from '../types.js';
import { formatAsJson } from '../report.js';

export const jsonReporter: ReporterPlugin = {
  name: 'json',
  description: 'Output review report in JSON format',
  type: 'formatter',

  async execute(
    report: ReviewReport,
    context: ReporterContext,
    config: ReporterConfig
  ): Promise<ReporterResult> {
    const output = formatAsJson(report, {
      language: context.language,
      includeChecklist: (config.includeChecklist as boolean) ?? true,
      includeMetadata: (config.includeMetadata as boolean) ?? true,
      includeEvidence: (config.includeEvidence as boolean) ?? false,
    });

    return {
      reporter: 'json',
      success: true,
      output,
    };
  },
};
