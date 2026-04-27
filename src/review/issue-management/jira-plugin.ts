/**
 * JIRA Issue Management Plugin
 *
 * Manages issues in JIRA using:
 * - Branch isolation via `branch:{name}` labels
 * - Identification labels for recognizing Argus-created tickets
 * - ID replacement: UUID → JIRA Key after save
 * - Status mapping between Argus and JIRA workflows
 */

import type {
  IssueManagementPlugin,
  PluginConfig,
  PluginContext,
  QueryResult,
  SaveResult,
  SyncResult,
} from './types.js';
import type { ValidatedIssue } from '../types.js';
import type { IssueStatus } from './types.js';

// ============================================================================
// Types
// ============================================================================

interface JiraPluginConfig {
  baseUrl: string;
  username: string;
  apiToken: string;
  projectKey: string;
  issueType?: string;
  identificationLabels?: string[];
  statusMapping?: {
    open?: string[];
    resolved?: string[];
    ignored?: string[];
  };
  dryRun?: boolean;
}

interface JiraIssue {
  key: string;
  self: string;
  fields: {
    summary: string;
    description: string;
    status: { name: string };
    labels: string[];
    priority: { name: string };
    issuetype: { name: string };
    created: string;
    updated: string;
  };
}

interface JiraSearchResponse {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JiraIssue[];
}

// ============================================================================
// Severity to Priority Mapping
// ============================================================================

const SEVERITY_TO_PRIORITY: Record<string, string> = {
  critical: 'Highest',
  error: 'High',
  warning: 'Medium',
  suggestion: 'Low',
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get config value from config object or environment variable
 */
function getConfigValue(config: PluginConfig, key: string, envKey: string): string | undefined {
  return (config[key] as string) || process.env[envKey];
}

/**
 * Resolve and validate JIRA configuration
 */
function resolveConfig(config: PluginConfig): JiraPluginConfig {
  const baseUrl = getConfigValue(config, 'baseUrl', 'JIRA_BASE_URL');
  if (!baseUrl) {
    throw new Error("JIRA plugin requires 'baseUrl' config or JIRA_BASE_URL environment variable");
  }

  const username = getConfigValue(config, 'username', 'JIRA_USERNAME');
  const apiToken = getConfigValue(config, 'apiToken', 'JIRA_API_TOKEN');
  if (!username || !apiToken) {
    throw new Error(
      'JIRA plugin requires authentication: set JIRA_USERNAME and JIRA_API_TOKEN environment variables'
    );
  }

  const projectKey = config.projectKey as string;
  if (!projectKey) {
    throw new Error("JIRA plugin requires 'projectKey' config");
  }

  return {
    baseUrl,
    username,
    apiToken,
    projectKey,
    issueType: (config.issueType as string) ?? 'Bug',
    identificationLabels: (config.identificationLabels as string[]) ?? [
      'code-review',
      'auto-generated',
    ],
    statusMapping: config.statusMapping as {
      open?: string[];
      resolved?: string[];
      ignored?: string[];
    },
    dryRun: (config.dryRun as boolean) ?? false,
  };
}

/**
 * Create Basic Auth header
 */
function createAuthHeader(username: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${username}:${apiToken}`).toString('base64')}`;
}

/**
 * Make authenticated request to JIRA API
 */
/* eslint-disable no-undef */
async function jiraFetch(
  url: string,
  username: string,
  apiToken: string,
  options?: RequestInit
): Promise<Response> {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: createAuthHeader(username, apiToken),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...options?.headers,
    },
  });
  return response;
}

/**
 * Build JQL query to find Argus-created issues for this branch
 */
function buildJQL(config: JiraPluginConfig, branch: string): string {
  const idLabels = config.identificationLabels ?? [];
  const branchLabel = `branch:${sanitizeLabelValue(branch)}`;

  // Build label filter
  const labelConditions = [
    ...idLabels.map((l) => `label = "${sanitizeJql(l)}"`),
    `label = "${sanitizeJql(branchLabel)}"`,
  ];

  // Build status filter (all statuses for complete diff analysis)
  const defaultStatuses = [
    'TO DO',
    'IN PROGRESS',
    'IN REVIEW',
    'DONE',
    'CLOSED',
    "WON'T FIX",
    'CANCELLED',
  ];

  // Gather all mapped statuses
  const allStatuses = new Set(defaultStatuses);
  config.statusMapping?.open?.forEach((s) => allStatuses.add(s.toUpperCase()));
  config.statusMapping?.resolved?.forEach((s) => allStatuses.add(s.toUpperCase()));
  config.statusMapping?.ignored?.forEach((s) => allStatuses.add(s.toUpperCase()));

  const statusCondition = `status IN (${Array.from(allStatuses)
    .map((s) => `"${s}"`)
    .join(', ')})`;

  return `project = "${config.projectKey}" AND ${labelConditions.join(' AND ')} AND ${statusCondition}`;
}

/**
 * Sanitize value for use in JIRA label
 */
function sanitizeLabelValue(value: string): string {
  return value.replace(/[^a-zA-Z0-9-_]/g, '-');
}

/**
 * Sanitize string for JQL query
 */
function sanitizeJql(value: string): string {
  return value.replace(/"/g, '\\"').replace(/'/g, "\\'");
}

/**
 * Map JIRA status to Argus Issue status
 */
function mapJiraStatusToIssueStatus(jiraStatus: string, config: JiraPluginConfig): IssueStatus {
  const upperStatus = jiraStatus.toUpperCase();

  // Check resolved mapping
  if (config.statusMapping?.resolved?.some((s) => s.toUpperCase() === upperStatus)) {
    return 'resolved';
  }

  // Check ignored mapping
  if (config.statusMapping?.ignored?.some((s) => s.toUpperCase() === upperStatus)) {
    return 'ignored';
  }

  // Check open mapping or default
  if (
    !config.statusMapping?.open ||
    config.statusMapping.open.some((s) => s.toUpperCase() === upperStatus)
  ) {
    return 'open';
  }

  // Default to open for unmapped statuses
  return 'open';
}

/**
 * Convert JIRA issue to ValidatedIssue
 */
function jiraIssueToValidatedIssue(jiraIssue: JiraIssue, config: JiraPluginConfig): ValidatedIssue {
  // Parse file and line from description

  // Parse file and line from description
  const fileMatch = jiraIssue.fields.description.match(/\*File:\*\s*`([^`]+)`/);
  const lineMatch = jiraIssue.fields.description.match(/\*File:\*\s*`[^`]+`[^0-9]*(\d+)/);

  const file = fileMatch?.[1] || 'unknown';
  const line = lineMatch?.[1] ? parseInt(lineMatch[1], 10) : 1;

  // Parse severity from description
  const severityMatch = jiraIssue.fields.description.match(/\*Severity:\*\s*(\w+)/);
  const severity = severityMatch?.[1]?.toLowerCase() || 'warning';

  // Parse category from description
  const categoryMatch = jiraIssue.fields.description.match(/\*Category:\*\s*(\w+)/);
  const category = (categoryMatch?.[1]?.toLowerCase() || 'logic') as
    | 'security'
    | 'logic'
    | 'performance'
    | 'style'
    | 'maintainability';

  // Parse confidence from description
  const confidenceMatch = jiraIssue.fields.description.match(/\*Confidence:\*\s*(\d+)%/);
  const confidence = confidenceMatch?.[1] ? parseInt(confidenceMatch[1], 10) / 100 : 0.8;

  // Parse title (remove prefix)
  const title = jiraIssue.fields.summary.replace(/^\[Code Review\]\s*/, '');

  // Extract description content
  const descLines = jiraIssue.fields.description.split('\n');
  const descStart = descLines.findIndex((l) => l.includes('**') || l.startsWith('*File:*'));
  const description = descLines
    .slice(descStart >= 0 ? descStart + 6 : 0)
    .join('\n')
    .trim();

  // Determine status
  const status = mapJiraStatusToIssueStatus(jiraIssue.fields.status.name, config);

  return {
    id: jiraIssue.key, // Use JIRA key as ID (dual-purpose)
    file,
    line_start: line,
    line_end: line,
    category,
    severity: severity as 'critical' | 'error' | 'warning' | 'suggestion',
    title,
    description,
    code_snippet: undefined,
    confidence,
    source_agent: 'validator',
    status,
    validation_status: 'confirmed',
    grounding_evidence: {
      checked_files: [],
      checked_symbols: [],
      related_context: `From JIRA ticket ${jiraIssue.key}`,
      reasoning: `Imported from JIRA with status "${jiraIssue.fields.status.name}"`,
    },
    final_confidence: confidence,
  };
}

/**
 * Create JIRA issue description from ValidatedIssue
 */
function createIssueDescription(issue: ValidatedIssue, context: PluginContext): string {
  const lines: string[] = [];

  lines.push(`h3. ${issue.title}`);
  lines.push('');
  lines.push(`*File:* \`${issue.file}\` (Line ${issue.line_start})`);
  lines.push(`*Severity:* ${issue.severity}`);
  lines.push(`*Category:* ${issue.category}`);
  lines.push(`*Confidence:* ${Math.round(issue.final_confidence * 100)}%`);
  lines.push(`*Agent:* ${issue.source_agent}`);
  lines.push('');
  lines.push(issue.description);

  if (issue.code_snippet) {
    lines.push('');
    lines.push('{code}');
    lines.push(issue.code_snippet);
    lines.push('{code}');
  }

  if (issue.suggestion) {
    lines.push('');
    lines.push('h4. Suggestion');
    lines.push(issue.suggestion);
  }

  if (context.sourceRef || context.targetRef) {
    lines.push('');
    lines.push('----');
    lines.push(`_Source: ${context.sourceRef || 'N/A'} → ${context.targetRef || 'N/A'}_`);
    lines.push(`_Repository: ${context.repoPath}_`);
    lines.push(`_Issue ID: ${issue.id}_`);
  }

  return lines.join('\n');
}

/**
 * Build issue creation payload
 */
function buildCreatePayload(
  issue: ValidatedIssue,
  context: PluginContext,
  config: JiraPluginConfig
) {
  return {
    fields: {
      project: { key: config.projectKey },
      summary: `[Code Review] ${issue.title}`,
      description: createIssueDescription(issue, context),
      issuetype: { name: config.issueType },
      priority: { name: SEVERITY_TO_PRIORITY[issue.severity] || 'Medium' },
      labels: [
        ...(config.identificationLabels ?? []),
        `branch:${sanitizeLabelValue(context.branch)}`,
        issue.category,
      ],
    },
  };
}

// ============================================================================
// JIRA Plugin Implementation
// ============================================================================

export class JiraPlugin implements IssueManagementPlugin {
  name = 'jira';
  description = 'JIRA issue management with branch isolation';

  async validate(config: PluginConfig): Promise<void> {
    const resolved = resolveConfig(config);
    const auth = createAuthHeader(resolved.username, resolved.apiToken);

    // Test authentication
    const myselfUrl = `${resolved.baseUrl.replace(/\/$/, '')}/rest/api/2/myself`;
    const myselfRes = await fetch(myselfUrl, {
      headers: { Authorization: auth, Accept: 'application/json' },
    });

    if (!myselfRes.ok) {
      const body = await myselfRes.text().catch(() => '');
      throw new Error(
        `JIRA authentication failed (HTTP ${myselfRes.status}): invalid username or API token${body ? ` — ${body}` : ''}`
      );
    }

    // Test project access
    const projectUrl = `${resolved.baseUrl.replace(/\/$/, '')}/rest/api/2/project/${resolved.projectKey}`;
    const projectRes = await fetch(projectUrl, {
      headers: { Authorization: auth, Accept: 'application/json' },
    });

    if (!projectRes.ok) {
      if (projectRes.status === 404) {
        throw new Error(`JIRA project '${resolved.projectKey}' does not exist`);
      }
      const body = await projectRes.text().catch(() => '');
      throw new Error(
        `JIRA project '${resolved.projectKey}' lookup failed (HTTP ${projectRes.status})${body ? `: ${body}` : ''}`
      );
    }
  }

  async query(context: PluginContext, config: PluginConfig): Promise<QueryResult> {
    const resolved = resolveConfig(config);
    const baseUrl = resolved.baseUrl.replace(/\/$/, '');

    // Build JQL query
    const jql = buildJQL(resolved, context.branch);

    // Search for issues
    const searchUrl = `${baseUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=summary,description,status,labels,priority,issuetype,created,updated`;
    const response = await jiraFetch(searchUrl, resolved.username, resolved.apiToken);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`JIRA search failed (HTTP ${response.status}): ${body}`);
    }

    const data = (await response.json()) as JiraSearchResponse;

    // Convert JIRA issues to ValidatedIssue
    const issues: ValidatedIssue[] = data.issues.map((jiraIssue) =>
      jiraIssueToValidatedIssue(jiraIssue, resolved)
    );

    return { issues };
  }

  async save(
    newIssues: ValidatedIssue[],
    changedIssues: ValidatedIssue[],
    context: PluginContext,
    config: PluginConfig
  ): Promise<SaveResult> {
    const resolved = resolveConfig(config);
    const baseUrl = resolved.baseUrl.replace(/\/$/, '');
    const failed: Array<{ issue: ValidatedIssue; error: string }> = [];
    const created: string[] = [];

    // Create new issues
    for (const issue of newIssues) {
      const payload = buildCreatePayload(issue, context, resolved);

      if (resolved.dryRun) {
        console.log(`[JIRA Plugin] Would create issue: ${issue.title}`);
        issue.id = `DRY-RUN-${issue.id}`;
        continue;
      }

      try {
        const response = await jiraFetch(
          `${baseUrl}/rest/api/2/issue`,
          resolved.username,
          resolved.apiToken,
          { method: 'POST', body: JSON.stringify(payload) }
        );

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`HTTP ${response.status}: ${body}`);
        }

        const result = (await response.json()) as { key: string; self: string };

        // Replace issue.id with JIRA key (ID field dual-purpose)
        issue.id = result.key;
        created.push(result.key);
      } catch (error) {
        failed.push({
          issue,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Update changed issues (if any)
    for (const issue of changedIssues) {
      if (!issue.id || issue.id.startsWith('DRY-RUN')) {
        continue;
      }

      if (resolved.dryRun) {
        console.log(`[JIRA Plugin] Would update issue: ${issue.id}`);
        continue;
      }

      // TODO: Implement issue update if needed
      // For now, status sync is handled by the sync() method
    }

    return {
      failed,
      info: {
        created: created.length,
        updated: changedIssues.length,
        keys: created,
      },
    };
  }

  async sync(
    issues: ValidatedIssue[],
    _context: PluginContext,
    config: PluginConfig
  ): Promise<SyncResult> {
    const resolved = resolveConfig(config);
    const baseUrl = resolved.baseUrl.replace(/\/$/, '');
    const failed: Array<{ issue: ValidatedIssue; error: string }> = [];
    const synced: Array<{ key: string; from: IssueStatus; to: string }> = [];

    // Get available transitions for each issue and perform status transition
    for (const issue of issues) {
      if (!issue.id || issue.id.startsWith('DRY-RUN')) {
        continue;
      }

      // Map Argus status to JIRA status
      const targetStatus = this.mapArgusStatusToJiraStatus(issue.status, resolved);
      if (!targetStatus) {
        continue; // No transition needed
      }

      if (resolved.dryRun) {
        console.log(`[JIRA Plugin] Would transition ${issue.id} to ${targetStatus}`);
        synced.push({ key: issue.id, from: issue.status, to: targetStatus });
        continue;
      }

      try {
        // Get available transitions
        const transitionsUrl = `${baseUrl}/rest/api/2/issue/${issue.id}/transitions`;
        const transitionsRes = await jiraFetch(
          transitionsUrl,
          resolved.username,
          resolved.apiToken
        );

        if (!transitionsRes.ok) {
          throw new Error(`Failed to get transitions for ${issue.id}`);
        }

        const transitionsData = (await transitionsRes.json()) as {
          transitions: Array<{ id: string; name: string }>;
        };

        // Find matching transition (case-insensitive)
        const transition = transitionsData.transitions.find(
          (t) => t.name.toLowerCase() === targetStatus.toLowerCase()
        );

        if (!transition) {
          failed.push({
            issue,
            error: `No transition to "${targetStatus}" available for ${issue.id}`,
          });
          continue;
        }

        // Execute transition
        const doTransitionUrl = `${baseUrl}/rest/api/2/issue/${issue.id}/transitions`;
        const doTransitionRes = await jiraFetch(
          doTransitionUrl,
          resolved.username,
          resolved.apiToken,
          {
            method: 'POST',
            body: JSON.stringify({ transition: { id: transition.id } }),
          }
        );

        if (!doTransitionRes.ok) {
          throw new Error(`Failed to transition ${issue.id} to ${targetStatus}`);
        }

        synced.push({ key: issue.id, from: issue.status, to: targetStatus });
      } catch (error) {
        failed.push({
          issue,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      failed,
      info: {
        synced: synced.length,
        details: synced,
      },
    };
  }

  /**
   * Map Argus Issue status to target JIRA status
   */
  private mapArgusStatusToJiraStatus(status: IssueStatus, config: JiraPluginConfig): string | null {
    switch (status) {
      case 'resolved':
        // Return first mapped resolved status, or default to "Done"
        return config.statusMapping?.resolved?.[0] || 'Done';
      case 'ignored':
        // Return first mapped ignored status, or default to "Won't Fix"
        return config.statusMapping?.ignored?.[0] || "Won't Fix";
      case 'open':
        // No transition needed for open status
        return null;
    }
  }
}

/**
 * Singleton instance for use in the application
 */
export const jiraPlugin = new JiraPlugin();
