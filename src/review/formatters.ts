/**
 * Built-in Output Formatters
 *
 * Provides three output formats for review results:
 * - summary: Brief overview only
 * - markdown: Full detailed output
 * - json: Machine-readable output
 */

import type { ReviewReport } from './types.js';

/**
 * Format result for output formatters
 */
export interface FormatResult {
  /** Formatted output string */
  output: string;
  /** Whether output should be printed to stdout */
  print: boolean;
}

/**
 * Format report as summary (brief overview)
 */
export function formatSummary(report: ReviewReport): string {
  const lines: string[] = [];

  lines.push('# Code Review Summary');
  lines.push('');

  // Overall assessment
  lines.push(`**Risk Level:** ${report.risk_level.toUpperCase()}`);
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push(report.summary);
  lines.push('');

  // Metrics
  lines.push('## Metrics');
  lines.push(`- **Total Issues:** ${report.metrics.confirmed}`);
  lines.push(`- **By Severity:**`);
  for (const [severity, count] of Object.entries(report.metrics.by_severity)) {
    if (count > 0) {
      lines.push(`  - ${severity}: ${count}`);
    }
  }
  lines.push(`- **By Category:**`);
  for (const [category, count] of Object.entries(report.metrics.by_category)) {
    if (count > 0) {
      lines.push(`  - ${category}: ${count}`);
    }
  }
  lines.push('');

  // Checklist
  if (report.checklist.length > 0) {
    lines.push('## Checklist');
    for (const item of report.checklist) {
      const icon = item.result === 'pass' ? '✓' : item.result === 'fail' ? '✗' : '○';
      lines.push(`${icon} ${item.question}`);
      if (item.details) {
        lines.push(`  _${item.details}_`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format report as markdown (full detailed output)
 */
export function formatMarkdown(report: ReviewReport): string {
  const lines: string[] = [];

  lines.push('# Code Review Report');
  lines.push('');

  // Overall assessment
  lines.push(`**Risk Level:** ${report.risk_level.toUpperCase()}`);
  lines.push(`**Total Issues:** ${report.metrics.confirmed}`);
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push(report.summary);
  lines.push('');

  // Issues by severity
  const critical = report.issues.filter((i) => i.severity === 'critical');
  const errors = report.issues.filter((i) => i.severity === 'error');
  const warnings = report.issues.filter((i) => i.severity === 'warning');
  const suggestions = report.issues.filter((i) => i.severity === 'suggestion');

  if (critical.length > 0) {
    lines.push(`## Critical Issues (${critical.length})`);
    lines.push(formatIssues(critical));
    lines.push('');
  }

  if (errors.length > 0) {
    lines.push(`## Errors (${errors.length})`);
    lines.push(formatIssues(errors));
    lines.push('');
  }

  if (warnings.length > 0) {
    lines.push(`## Warnings (${warnings.length})`);
    lines.push(formatIssues(warnings));
    lines.push('');
  }

  if (suggestions.length > 0) {
    lines.push(`## Suggestions (${suggestions.length})`);
    lines.push(formatIssues(suggestions));
    lines.push('');
  }

  // Checklist
  if (report.checklist.length > 0) {
    lines.push('## Checklist');
    for (const item of report.checklist) {
      const icon = item.result === 'pass' ? '✓' : item.result === 'fail' ? '✗' : '○';
      lines.push(`${icon} ${item.question}`);
      if (item.details) {
        lines.push(`  _${item.details}_`);
      }
    }
    lines.push('');
  }

  // Metadata
  lines.push('---');
  lines.push(`_Review time: ${(report.metadata.review_time_ms / 1000).toFixed(2)}s_`);
  lines.push(`_Tokens used: ${report.metadata.tokens_used}_`);
  lines.push(`_Agents: ${report.metadata.agents_used.join(', ')}_`);

  return lines.join('\n');
}

/**
 * Format issue list as markdown
 */
function formatIssues(issues: import('./types.js').ValidatedIssue[]): string {
  return issues
    .map((issue) => {
      const statusIcon = issue.status === 'open' ? '🔴' : issue.status === 'resolved' ? '✅' : '⏭️';
      const lines = [
        `### ${statusIcon} ${issue.title}`,
        '',
        `**File:** \`${issue.file}:${issue.line_start}\``,
        `**Severity:** ${issue.severity}`,
        `**Category:** ${issue.category}`,
        `**Confidence:** ${Math.round(issue.confidence * 100)}%`,
        '',
        issue.description,
        '',
      ];

      if (issue.suggestion) {
        lines.push('**Suggestion:**');
        lines.push(issue.suggestion);
        lines.push('');
      }

      if (issue.code_snippet) {
        lines.push('```' + getLanguage(issue.file));
        lines.push(issue.code_snippet);
        lines.push('```');
        lines.push('');
      }

      return lines.join('\n');
    })
    .join('\n');
}

/**
 * Detect programming language from file extension
 */
function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    ts: 'typescript',
    js: 'javascript',
    py: 'python',
    java: 'java',
    go: 'go',
    rs: 'rust',
    cpp: 'cpp',
    c: 'c',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
  };
  return languageMap[ext || ''] || 'text';
}

/**
 * Format report as JSON (machine-readable)
 */
export function formatJson(report: ReviewReport): string {
  return JSON.stringify(report, null, 2);
}

/**
 * Format report based on output format preference
 */
export function formatReport(
  report: ReviewReport,
  format: 'summary' | 'markdown' | 'json' = 'summary'
): FormatResult {
  switch (format) {
    case 'summary':
      return { output: formatSummary(report), print: true };
    case 'markdown':
      return { output: formatMarkdown(report), print: true };
    case 'json':
      return { output: formatJson(report), print: true };
    default:
      return { output: formatSummary(report), print: true };
  }
}
