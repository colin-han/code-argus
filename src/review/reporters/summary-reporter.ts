/**
 * Summary Reporter Plugin
 *
 * Formats the review report as a concise CLI summary.
 * Migrated from report.ts formatAsSummary().
 */

import type { ReporterPlugin, ReporterContext, ReporterConfig, ReporterResult } from './types.js';
import type { ReviewReport } from '../types.js';
import { formatAsSummary } from '../report.js';

export const summaryReporter: ReporterPlugin = {
  name: 'summary',
  description: 'Output concise CLI summary of the review',
  type: 'formatter',

  async execute(
    report: ReviewReport,
    _context: ReporterContext,
    _config: ReporterConfig
  ): Promise<ReporterResult> {
    const output = formatAsSummary(report);

    return {
      reporter: 'summary',
      success: true,
      output,
    };
  },
};
