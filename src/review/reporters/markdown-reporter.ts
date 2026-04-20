/**
 * Markdown Reporter Plugin
 *
 * Formats the review report as Markdown output.
 * Migrated from report.ts formatAsMarkdown().
 */

import type { ReporterPlugin, ReporterContext, ReporterConfig, ReporterResult } from './types.js';
import type { ReviewReport } from '../types.js';
import { formatAsMarkdown } from '../report.js';

export const markdownReporter: ReporterPlugin = {
  name: 'markdown',
  description: 'Output review report in Markdown format',
  type: 'formatter',

  async execute(
    report: ReviewReport,
    context: ReporterContext,
    config: ReporterConfig
  ): Promise<ReporterResult> {
    const output = formatAsMarkdown(report, {
      language: context.language,
      includeChecklist: (config.includeChecklist as boolean) ?? true,
      includeMetadata: (config.includeMetadata as boolean) ?? true,
      includeEvidence: (config.includeEvidence as boolean) ?? false,
    });

    return {
      reporter: 'markdown',
      success: true,
      output,
    };
  },
};
