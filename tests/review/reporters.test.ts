import { describe, it, expect, vi } from 'vitest';
import {
  ReporterRegistry,
  createDefaultRegistry,
  markdownReporter,
  jsonReporter,
  summaryReporter,
  prCommentsReporter,
  jiraReporter,
} from '../../src/review/reporters/index.js';
import type { ReporterContext, ReporterPlugin } from '../../src/review/reporters/types.js';
import type { ReviewReport, ValidatedIssue } from '../../src/review/types.js';
import {
  formatAsMarkdown,
  formatAsJson,
  formatAsSummary,
  formatAsPRComments,
} from '../../src/review/report.js';

// ============================================================================
// Test Fixtures
// ============================================================================

const mockIssue: ValidatedIssue = {
  id: 'test-issue-1',
  file: 'src/app.ts',
  line_start: 10,
  line_end: 15,
  category: 'security',
  severity: 'error',
  title: 'SQL Injection vulnerability',
  description: 'User input is not sanitized',
  suggestion: 'Use parameterized queries',
  code_snippet: 'db.query(`SELECT * FROM users WHERE id = ${userId}`)',
  confidence: 0.85,
  source_agent: 'security-reviewer',
  validation_status: 'confirmed',
  grounding_evidence: {
    checked_files: ['src/app.ts'],
    checked_symbols: [],
    related_context: 'Direct database query with string interpolation',
    reasoning: 'The userId is directly interpolated into SQL string',
  },
  final_confidence: 0.85,
};

const mockReport: ReviewReport = {
  summary: '**Issues Found**: 1 error',
  risk_level: 'medium',
  issues: [mockIssue],
  checklist: [
    {
      id: 'check-1',
      category: 'security',
      question: 'Are inputs sanitized?',
      result: 'fail',
      details: 'SQL injection found',
    },
  ],
  metrics: {
    total_scanned: 5,
    confirmed: 1,
    rejected: 4,
    uncertain: 0,
    by_severity: { critical: 0, error: 1, warning: 0, suggestion: 0 },
    by_category: { security: 1, logic: 0, performance: 0, style: 0, maintainability: 0 },
    files_reviewed: 3,
  },
  metadata: {
    review_time_ms: 5000,
    tokens_used: 1000,
    agents_used: ['security-reviewer'],
  },
};

const mockContext: ReporterContext = {
  repoPath: '/tmp/test-repo',
  sourceRef: 'feat/test',
  targetRef: 'main',
  language: 'zh',
  verbose: false,
};

// ============================================================================
// ReporterRegistry Tests
// ============================================================================

describe('ReporterRegistry', () => {
  it('should register and retrieve plugins', () => {
    const registry = new ReporterRegistry();
    registry.register(markdownReporter);
    expect(registry.get('markdown')).toBe(markdownReporter);
    expect(registry.has('markdown')).toBe(true);
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('should throw on duplicate registration', () => {
    const registry = new ReporterRegistry();
    registry.register(markdownReporter);
    expect(() => registry.register(markdownReporter)).toThrow('already registered');
  });

  it('should list all registered plugins', () => {
    const registry = new ReporterRegistry();
    registry.register(markdownReporter);
    registry.register(jsonReporter);
    expect(registry.list()).toEqual(['markdown', 'json']);
  });

  it('should handle missing reporters gracefully in executeAll', async () => {
    const registry = new ReporterRegistry();
    const { results } = await registry.executeAll(['nonexistent'], mockReport, mockContext);
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.error).toContain('not registered');
  });

  it('should execute formatters before exporters', async () => {
    const executionOrder: string[] = [];

    const fakeFormatter: ReporterPlugin = {
      name: 'fmt',
      description: 'test formatter',
      type: 'formatter',
      async execute() {
        executionOrder.push('fmt');
        return { reporter: 'fmt', success: true, output: 'formatted' };
      },
    };

    const fakeExporter: ReporterPlugin = {
      name: 'exp',
      description: 'test exporter',
      type: 'exporter',
      async execute() {
        executionOrder.push('exp');
        return { reporter: 'exp', success: true };
      },
    };

    const registry = new ReporterRegistry();
    registry.register(fakeFormatter);
    registry.register(fakeExporter);

    await registry.executeAll(['exp', 'fmt'], mockReport, mockContext);
    expect(executionOrder[0]).toBe('fmt');
    expect(executionOrder[1]).toBe('exp');
  });

  it('should merge issueUpdates into updatedReport', async () => {
    const exporter: ReporterPlugin = {
      name: 'test-exporter',
      description: 'test',
      type: 'exporter',
      async execute() {
        return {
          reporter: 'test-exporter',
          success: true,
          issueUpdates: [
            {
              issueId: 'test-issue-1',
              externalRefs: {
                jira: {
                  system: 'jira',
                  externalId: 'PROJ-100',
                  url: 'https://jira.example.com/browse/PROJ-100',
                  status: 'Open',
                  createdAt: '2025-01-01T00:00:00Z',
                },
              },
            },
          ],
        };
      },
    };

    const registry = new ReporterRegistry();
    registry.register(exporter);

    const { updatedReport } = await registry.executeAll(['test-exporter'], mockReport, mockContext);

    expect(updatedReport.issues[0]!.externalRefs).toBeDefined();
    expect(updatedReport.issues[0]!.externalRefs!.jira.externalId).toBe('PROJ-100');
  });

  it('should call syncStatus on plugins that support it', async () => {
    const syncFn = vi.fn().mockResolvedValue({
      reporter: 'sync-plugin',
      success: true,
      output: 'synced',
    });

    const plugin: ReporterPlugin = {
      name: 'sync-plugin',
      description: 'test',
      type: 'exporter',
      async execute() {
        return { reporter: 'sync-plugin', success: true };
      },
      syncStatus: syncFn,
    };

    const registry = new ReporterRegistry();
    registry.register(plugin);

    const prevReport = { ...mockReport };
    const results = await registry.syncAll(['sync-plugin'], mockReport, prevReport, mockContext);

    expect(syncFn).toHaveBeenCalledOnce();
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(true);
  });

  it('should skip plugins without syncStatus in syncAll', async () => {
    const plugin: ReporterPlugin = {
      name: 'no-sync',
      description: 'test',
      type: 'formatter',
      async execute() {
        return { reporter: 'no-sync', success: true };
      },
      // No syncStatus method
    };

    const registry = new ReporterRegistry();
    registry.register(plugin);

    const results = await registry.syncAll(['no-sync'], mockReport, mockReport, mockContext);

    expect(results).toHaveLength(0);
  });
});

// ============================================================================
// createDefaultRegistry Tests
// ============================================================================

describe('createDefaultRegistry', () => {
  it('should register all 5 built-in plugins', () => {
    const registry = createDefaultRegistry();
    expect(registry.has('markdown')).toBe(true);
    expect(registry.has('json')).toBe(true);
    expect(registry.has('summary')).toBe(true);
    expect(registry.has('pr-comments')).toBe(true);
    expect(registry.has('jira')).toBe(true);
    expect(registry.list()).toHaveLength(5);
  });
});

// ============================================================================
// Built-in Plugin Output Compatibility Tests
// ============================================================================

describe('Built-in plugin output compatibility', () => {
  it('markdownReporter should match formatAsMarkdown output', async () => {
    const result = await markdownReporter.execute(mockReport, mockContext, {});
    const legacy = formatAsMarkdown(mockReport, { language: 'zh' });
    expect(result.success).toBe(true);
    expect(result.output).toBe(legacy);
  });

  it('jsonReporter should match formatAsJson output', async () => {
    const result = await jsonReporter.execute(mockReport, mockContext, {});
    const legacy = formatAsJson(mockReport, { language: 'zh' });
    expect(result.success).toBe(true);
    expect(result.output).toBe(legacy);
  });

  it('summaryReporter should match formatAsSummary output', async () => {
    const result = await summaryReporter.execute(mockReport, mockContext, {});
    const legacy = formatAsSummary(mockReport);
    expect(result.success).toBe(true);
    expect(result.output).toBe(legacy);
  });

  it('prCommentsReporter should match formatAsPRComments output', async () => {
    const result = await prCommentsReporter.execute(mockReport, mockContext, {});
    const legacy = formatAsPRComments(mockReport);
    expect(result.success).toBe(true);
    expect(result.output).toBe(legacy);
  });
});

// ============================================================================
// JIRA Reporter Tests
// ============================================================================

describe('jiraReporter', () => {
  it('should have correct metadata', () => {
    expect(jiraReporter.name).toBe('jira');
    expect(jiraReporter.type).toBe('exporter');
  });

  it('should throw on missing projectKey', () => {
    expect(() => jiraReporter.validateConfig!({})).toThrow('projectKey');
  });

  it('should throw on missing baseUrl', () => {
    expect(() => jiraReporter.validateConfig!({ projectKey: 'PROJ' })).toThrow('baseUrl');
  });

  it('should throw on missing auth credentials', () => {
    // Clear env vars to ensure clean test
    const origUser = process.env.JIRA_USERNAME;
    const origToken = process.env.JIRA_API_TOKEN;
    delete process.env.JIRA_USERNAME;
    delete process.env.JIRA_API_TOKEN;

    try {
      expect(() =>
        jiraReporter.validateConfig!({
          projectKey: 'PROJ',
          baseUrl: 'https://jira.example.com',
        })
      ).toThrow('authentication');
    } finally {
      // Restore
      if (origUser) process.env.JIRA_USERNAME = origUser;
      if (origToken) process.env.JIRA_API_TOKEN = origToken;
    }
  });

  it('should skip issues that already have jira externalRefs', async () => {
    const reportWithRef: ReviewReport = {
      ...mockReport,
      issues: [
        {
          ...mockIssue,
          externalRefs: {
            jira: {
              system: 'jira',
              externalId: 'PROJ-999',
              createdAt: '2025-01-01T00:00:00Z',
            },
          },
        },
      ],
    };

    // Set env vars for auth
    const origUser = process.env.JIRA_USERNAME;
    const origToken = process.env.JIRA_API_TOKEN;
    process.env.JIRA_USERNAME = 'test@example.com';
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const result = await jiraReporter.execute(reportWithRef, mockContext, {
        projectKey: 'PROJ',
        baseUrl: 'https://jira.example.com',
        dryRun: true,
      });

      expect(result.success).toBe(true);
      // No new issues should be created since the issue already has a JIRA ref
      expect(result.metadata?.created).toBe(0);
    } finally {
      if (origUser) process.env.JIRA_USERNAME = origUser;
      else delete process.env.JIRA_USERNAME;
      if (origToken) process.env.JIRA_API_TOKEN = origToken;
      else delete process.env.JIRA_API_TOKEN;
    }
  });

  it('should create issues in dryRun mode and return issueUpdates', async () => {
    const origUser = process.env.JIRA_USERNAME;
    const origToken = process.env.JIRA_API_TOKEN;
    process.env.JIRA_USERNAME = 'test@example.com';
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const result = await jiraReporter.execute(mockReport, mockContext, {
        projectKey: 'PROJ',
        baseUrl: 'https://jira.example.com',
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.metadata?.created).toBe(1);
      expect(result.metadata?.dryRun).toBe(true);
      expect(result.issueUpdates).toHaveLength(1);
      expect(result.issueUpdates![0]!.issueId).toBe('test-issue-1');
      expect(result.issueUpdates![0]!.externalRefs!.jira.externalId).toBe('DRY-RUN');
    } finally {
      if (origUser) process.env.JIRA_USERNAME = origUser;
      else delete process.env.JIRA_USERNAME;
      if (origToken) process.env.JIRA_API_TOKEN = origToken;
      else delete process.env.JIRA_API_TOKEN;
    }
  });

  it('should filter issues by minSeverity', async () => {
    const reportWithSuggestion: ReviewReport = {
      ...mockReport,
      issues: [{ ...mockIssue, severity: 'suggestion' }],
    };

    const origUser = process.env.JIRA_USERNAME;
    const origToken = process.env.JIRA_API_TOKEN;
    process.env.JIRA_USERNAME = 'test@example.com';
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const result = await jiraReporter.execute(reportWithSuggestion, mockContext, {
        projectKey: 'PROJ',
        baseUrl: 'https://jira.example.com',
        dryRun: true,
        minSeverity: 'error',
      });

      expect(result.success).toBe(true);
      expect(result.metadata?.created).toBe(0);
    } finally {
      if (origUser) process.env.JIRA_USERNAME = origUser;
      else delete process.env.JIRA_USERNAME;
      if (origToken) process.env.JIRA_API_TOKEN = origToken;
      else delete process.env.JIRA_API_TOKEN;
    }
  });
});
