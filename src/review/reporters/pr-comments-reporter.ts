/**
 * PR Comments Reporter Plugin
 *
 * Formats the review report as PR comment data for integration.
 * Migrated from report.ts formatAsPRComments().
 */

import type { ReporterPlugin, ReporterContext, ReporterConfig, ReporterResult } from './types.js';
import type { ReviewReport } from '../types.js';
import { formatAsPRComments } from '../report.js';

export const prCommentsReporter: ReporterPlugin = {
  name: 'pr-comments',
  description: 'Output review issues as PR comment data (JSON)',
  type: 'formatter',

  async execute(
    report: ReviewReport,
    _context: ReporterContext,
    _config: ReporterConfig
  ): Promise<ReporterResult> {
    const output = formatAsPRComments(report);

    return {
      reporter: 'pr-comments',
      success: true,
      output,
    };
  },
};
