/**
 * JIRA Reporter Plugin
 *
 * Reports discovered issues to JIRA by creating tickets.
 * Supports issue deduplication via externalRefs writeback and
 * status synchronization during fix verification.
 *
 * Configuration:
 *   - projectKey: JIRA project key (required)
 *   - baseUrl: JIRA base URL (required, or JIRA_BASE_URL env var)
 *   - username: JIRA username (or JIRA_USERNAME env var)
 *   - apiToken: JIRA API token (or JIRA_API_TOKEN env var)
 *   - issueType: Issue type to create (default: 'Bug')
 *   - minSeverity: Minimum severity to report (default: 'warning')
 *   - labels: Labels to add (default: ['code-review', 'auto-generated'])
 *   - dryRun: If true, simulate without creating issues (default: false)
 */

import type {
  ReporterPlugin,
  ReporterContext,
  ReporterConfig,
  ReporterResult,
  IssueUpdate,
} from './types.js';
import type { ReviewReport, ValidatedIssue } from '../types.js';

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  error: 1,
  warning: 2,
  suggestion: 3,
};

const SEVERITY_TO_PRIORITY: Record<string, string> = {
  critical: 'Highest',
  error: 'High',
  warning: 'Medium',
  suggestion: 'Low',
};

/**
 * Resolve a config value from config object or environment variable
 */
function resolveConfig(config: ReporterConfig, key: string, envKey: string): string | undefined {
  return (config[key] as string) || process.env[envKey];
}

/**
 * Map a ValidatedIssue to a JIRA issue creation payload
 */
function mapToJiraPayload(
  issue: ValidatedIssue,
  options: {
    projectKey: string;
    issueType: string;
    labels: string[];
    sourceRef?: string;
    targetRef?: string;
    repoPath: string;
  }
): Record<string, unknown> {
  const lineRange =
    issue.line_start === issue.line_end
      ? `Line ${issue.line_start}`
      : `Lines ${issue.line_start}-${issue.line_end}`;

  const descriptionParts: string[] = [
    `h3. ${issue.title}`,
    '',
    `*File:* \`${issue.file}\` (${lineRange})`,
    `*Severity:* ${issue.severity}`,
    `*Category:* ${issue.category}`,
    `*Confidence:* ${Math.round(issue.final_confidence * 100)}%`,
    `*Agent:* ${issue.source_agent}`,
    '',
    issue.description,
  ];

  if (issue.code_snippet) {
    descriptionParts.push('', '{code}', issue.code_snippet, '{code}');
  }

  if (issue.suggestion) {
    descriptionParts.push('', 'h4. Suggestion', issue.suggestion);
  }

  if (options.sourceRef || options.targetRef) {
    descriptionParts.push(
      '',
      `----`,
      `_Source: ${options.sourceRef || 'N/A'} → ${options.targetRef || 'N/A'}_`,
      `_Repository: ${options.repoPath}_`,
      `_Issue ID: ${issue.id}_`
    );
  }

  return {
    fields: {
      project: { key: options.projectKey },
      summary: `[Code Review] ${issue.title}`,
      description: descriptionParts.join('\n'),
      issuetype: { name: options.issueType },
      priority: { name: SEVERITY_TO_PRIORITY[issue.severity] || 'Medium' },
      labels: [...options.labels, issue.category],
    },
  };
}

/**
 * Create a JIRA issue via REST API
 */
async function createJiraIssue(
  baseUrl: string,
  username: string,
  apiToken: string,
  payload: Record<string, unknown>
): Promise<{ key: string; self: string }> {
  const url = `${baseUrl.replace(/\/$/, '')}/rest/api/2/issue`;
  const auth = Buffer.from(`${username}:${apiToken}`).toString('base64');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`JIRA API error (${response.status}): ${errorBody}`);
  }

  return (await response.json()) as { key: string; self: string };
}

/**
 * Transition a JIRA issue to a new status
 */
async function transitionJiraIssue(
  baseUrl: string,
  username: string,
  apiToken: string,
  issueKey: string,
  targetStatus: string
): Promise<void> {
  const auth = Buffer.from(`${username}:${apiToken}`).toString('base64');
  const baseHeaders = {
    Authorization: `Basic ${auth}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  // Get available transitions
  const transitionsUrl = `${baseUrl.replace(/\/$/, '')}/rest/api/2/issue/${issueKey}/transitions`;
  const transitionsRes = await fetch(transitionsUrl, { headers: baseHeaders });
  if (!transitionsRes.ok) return;

  const transitionsData = (await transitionsRes.json()) as {
    transitions: Array<{ id: string; name: string }>;
  };
  const transition = transitionsData.transitions.find(
    (t) => t.name.toLowerCase() === targetStatus.toLowerCase()
  );
  if (!transition) return;

  // Execute transition
  await fetch(transitionsUrl, {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({ transition: { id: transition.id } }),
  });
}

/**
 * Add a comment to a JIRA issue
 */
async function addJiraComment(
  baseUrl: string,
  username: string,
  apiToken: string,
  issueKey: string,
  comment: string
): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, '')}/rest/api/2/issue/${issueKey}/comment`;
  const auth = Buffer.from(`${username}:${apiToken}`).toString('base64');

  await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ body: comment }),
  });
}

/**
 * Search for a JIRA user by email address
 * Returns the accountId (Cloud) or name (Server/DC) for assignment.
 */
async function searchJiraUser(
  baseUrl: string,
  username: string,
  apiToken: string,
  email: string
): Promise<{ accountId?: string; name?: string; displayName: string } | null> {
  const url = `${baseUrl.replace(/\/$/, '')}/rest/api/2/user/search?query=${encodeURIComponent(email)}`;
  const auth = Buffer.from(`${username}:${apiToken}`).toString('base64');

  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) return null;

  const users = (await response.json()) as Array<{
    accountId?: string;
    name?: string;
    displayName: string;
    emailAddress?: string;
    active: boolean;
  }>;

  // Prefer exact email match among active users
  const exactMatch = users.find(
    (u) => u.active && u.emailAddress?.toLowerCase() === email.toLowerCase()
  );
  if (exactMatch) {
    return {
      accountId: exactMatch.accountId,
      name: exactMatch.name,
      displayName: exactMatch.displayName,
    };
  }

  // Fall back to first active user
  const firstActive = users.find((u) => u.active);
  if (firstActive) {
    return {
      accountId: firstActive.accountId,
      name: firstActive.name,
      displayName: firstActive.displayName,
    };
  }

  return null;
}

/**
 * Assign a JIRA issue to a user
 * Uses accountId for Cloud, name for Server/Data Center.
 */
async function assignJiraIssue(
  baseUrl: string,
  username: string,
  apiToken: string,
  issueKey: string,
  assigneeId: string,
  isCloud: boolean
): Promise<boolean> {
  const url = `${baseUrl.replace(/\/$/, '')}/rest/api/2/issue/${issueKey}/assignee`;
  const auth = Buffer.from(`${username}:${apiToken}`).toString('base64');

  const body = isCloud ? { accountId: assigneeId } : { name: assigneeId };

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  return response.ok;
}

/**
 * Detect if a JIRA instance is Cloud (atlassian.net) or Server/DC
 */
function isJiraCloud(baseUrl: string): boolean {
  return baseUrl.includes('atlassian.net');
}

export const jiraReporter: ReporterPlugin = {
  name: 'jira',
  description: 'Report discovered issues to JIRA',
  type: 'exporter',

  validateConfig(config: ReporterConfig): void {
    const projectKey = config.projectKey as string;
    if (!projectKey) {
      throw new Error(
        "JIRA reporter requires 'projectKey' config (--reporter-opt jira.projectKey=PROJ)"
      );
    }

    const baseUrl = resolveConfig(config, 'baseUrl', 'JIRA_BASE_URL');
    if (!baseUrl) {
      throw new Error(
        "JIRA reporter requires 'baseUrl' config or JIRA_BASE_URL environment variable"
      );
    }

    const username = resolveConfig(config, 'username', 'JIRA_USERNAME');
    const apiToken = resolveConfig(config, 'apiToken', 'JIRA_API_TOKEN');
    if (!username || !apiToken) {
      throw new Error(
        'JIRA reporter requires authentication: set JIRA_USERNAME and JIRA_API_TOKEN environment variables'
      );
    }
  },

  async validate(config: ReporterConfig): Promise<void> {
    // 1. 先校验配置完整性（与 validateConfig 相同的逻辑）
    const projectKey = config.projectKey as string;
    if (!projectKey) {
      throw new Error(
        "JIRA reporter requires 'projectKey' config (--reporter-opt jira.projectKey=PROJ)"
      );
    }
    const baseUrl = resolveConfig(config, 'baseUrl', 'JIRA_BASE_URL');
    if (!baseUrl) {
      throw new Error(
        "JIRA reporter requires 'baseUrl' config or JIRA_BASE_URL environment variable"
      );
    }
    const username = resolveConfig(config, 'username', 'JIRA_USERNAME');
    const apiToken = resolveConfig(config, 'apiToken', 'JIRA_API_TOKEN');
    if (!username || !apiToken) {
      throw new Error(
        'JIRA reporter requires authentication: set JIRA_USERNAME and JIRA_API_TOKEN environment variables'
      );
    }

    const auth = Buffer.from(`${username}:${apiToken}`).toString('base64');
    const baseHeaders = {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
    };

    // 2. 校验 token 有效性：调用 /rest/api/2/myself
    const myselfUrl = `${baseUrl.replace(/\/$/, '')}/rest/api/2/myself`;
    const myselfRes = await fetch(myselfUrl, { headers: baseHeaders });
    if (!myselfRes.ok) {
      const body = await myselfRes.text().catch(() => '');
      throw new Error(
        `JIRA authentication failed (HTTP ${myselfRes.status}): invalid username or API token${body ? ` — ${body}` : ''}`
      );
    }

    // 3. 校验 projectKey 存在：调用 /rest/api/2/project/{key}
    const projectUrl = `${baseUrl.replace(/\/$/, '')}/rest/api/2/project/${projectKey}`;
    const projectRes = await fetch(projectUrl, { headers: baseHeaders });
    if (!projectRes.ok) {
      if (projectRes.status === 404) {
        throw new Error(`JIRA project '${projectKey}' does not exist`);
      }
      const body = await projectRes.text().catch(() => '');
      throw new Error(
        `JIRA project '${projectKey}' lookup failed (HTTP ${projectRes.status})${body ? `: ${body}` : ''}`
      );
    }
  },

  async execute(
    report: ReviewReport,
    context: ReporterContext,
    config: ReporterConfig
  ): Promise<ReporterResult> {
    const projectKey = config.projectKey as string;
    const baseUrl = resolveConfig(config, 'baseUrl', 'JIRA_BASE_URL')!;
    const username = resolveConfig(config, 'username', 'JIRA_USERNAME')!;
    const apiToken = resolveConfig(config, 'apiToken', 'JIRA_API_TOKEN')!;
    const issueType = (config.issueType as string) ?? 'Bug';
    const minSeverity = (config.minSeverity as string) ?? 'warning';
    const dryRun = (config.dryRun as boolean) ?? false;
    const labels = (config.labels as string[]) ?? ['code-review', 'auto-generated'];

    // Filter issues by minimum severity
    const threshold = SEVERITY_ORDER[minSeverity] ?? 2;
    const issuesToReport = report.issues.filter(
      (i) => (SEVERITY_ORDER[i.severity] ?? 3) <= threshold
    );

    if (issuesToReport.length === 0) {
      return {
        reporter: 'jira',
        success: true,
        output: 'No issues meet the severity threshold for JIRA reporting',
        metadata: { created: 0, skipped: report.issues.length },
      };
    }

    const createdIssues: Array<{ key: string; summary: string; issueId: string }> = [];
    const issueUpdates: IssueUpdate[] = [];
    const errors: string[] = [];
    const assignedIssues: string[] = [];

    // Auto-assign: resolve JIRA user from authorEmail once
    let assignee: { id: string; displayName: string } | null = null;
    const cloud = isJiraCloud(baseUrl);
    if (context.authorEmail && !dryRun) {
      const jiraUser = await searchJiraUser(baseUrl, username, apiToken, context.authorEmail);
      if (jiraUser) {
        const id = cloud ? jiraUser.accountId : jiraUser.name;
        if (id) {
          assignee = { id, displayName: jiraUser.displayName };
        }
      }
    }

    for (const issue of issuesToReport) {
      // Skip issues that already have a JIRA reference
      if (issue.externalRefs?.jira) {
        continue;
      }

      const payload = mapToJiraPayload(issue, {
        projectKey,
        issueType,
        labels,
        sourceRef: context.sourceRef,
        targetRef: context.targetRef,
        repoPath: context.repoPath,
      });

      if (dryRun) {
        const summary = (payload.fields as Record<string, unknown>).summary as string;
        createdIssues.push({ key: 'DRY-RUN', summary, issueId: issue.id });
        issueUpdates.push({
          issueId: issue.id,
          externalRefs: {
            jira: {
              system: 'jira',
              externalId: 'DRY-RUN',
              url: `${baseUrl}/browse/DRY-RUN`,
              status: 'Open',
              createdAt: new Date().toISOString(),
            },
          },
        });
        continue;
      }

      try {
        const result = await createJiraIssue(baseUrl, username, apiToken, payload);
        const summary = (payload.fields as Record<string, unknown>).summary as string;
        createdIssues.push({ key: result.key, summary, issueId: issue.id });

        // Auto-assign issue to commit author
        if (assignee) {
          const assigned = await assignJiraIssue(
            baseUrl,
            username,
            apiToken,
            result.key,
            assignee.id,
            cloud
          );
          if (assigned) {
            assignedIssues.push(result.key);
          }
        }

        // Write back JIRA reference
        issueUpdates.push({
          issueId: issue.id,
          externalRefs: {
            jira: {
              system: 'jira',
              externalId: result.key,
              url: `${baseUrl.replace(/\/$/, '')}/browse/${result.key}`,
              status: 'Open',
              createdAt: new Date().toISOString(),
            },
          },
        });
      } catch (error) {
        errors.push(
          `Failed to create JIRA issue for "${issue.title}": ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const outputLines: string[] = [];
    if (createdIssues.length > 0) {
      outputLines.push(
        `Created ${createdIssues.length} JIRA issue(s)${dryRun ? ' (dry run)' : ''}:`
      );
      for (const ci of createdIssues) {
        outputLines.push(`  ${ci.key}: ${ci.summary}`);
      }
    }
    if (errors.length > 0) {
      outputLines.push(`Errors (${errors.length}):`);
      for (const err of errors) {
        outputLines.push(`  ⚠ ${err}`);
      }
    }
    if (assignedIssues.length > 0) {
      outputLines.push(
        `Assigned ${assignedIssues.length} issue(s) to ${assignee?.displayName ?? 'unknown'}`
      );
    }

    return {
      reporter: 'jira',
      success: errors.length === 0,
      output: outputLines.join('\n'),
      metadata: {
        created: createdIssues.length,
        skipped: report.issues.length - issuesToReport.length,
        errors: errors.length,
        assigned: assignedIssues.length,
        assignee: assignee?.displayName ?? null,
        issues: createdIssues.map((ci) => ({ key: ci.key, summary: ci.summary })),
        dryRun,
      },
      issueUpdates,
    };
  },

  async syncStatus(
    report: ReviewReport,
    prevReport: ReviewReport,
    _context: ReporterContext,
    config: ReporterConfig
  ): Promise<ReporterResult> {
    const baseUrl = resolveConfig(config, 'baseUrl', 'JIRA_BASE_URL')!;
    const username = resolveConfig(config, 'username', 'JIRA_USERNAME')!;
    const apiToken = resolveConfig(config, 'apiToken', 'JIRA_API_TOKEN')!;
    const dryRun = (config.dryRun as boolean) ?? false;

    const fixResults = report.fix_verification?.results ?? [];
    const synced: Array<{ key: string; action: string }> = [];
    const errors: string[] = [];

    for (const result of fixResults) {
      // Find the corresponding JIRA reference from the previous report
      const prevIssue = prevReport.issues.find((i) => i.id === result.original_issue_id);
      const jiraRef = prevIssue?.externalRefs?.jira;
      if (!jiraRef) continue;

      const issueKey = jiraRef.externalId;

      try {
        switch (result.status) {
          case 'fixed': {
            if (!dryRun) {
              await transitionJiraIssue(baseUrl, username, apiToken, issueKey, 'Done');
              await addJiraComment(
                baseUrl,
                username,
                apiToken,
                issueKey,
                `✅ Issue verified as fixed (confidence: ${Math.round(result.confidence * 100)}%). Verified by Code-Argus.`
              );
            }
            synced.push({ key: issueKey, action: 'fixed → Done' });
            break;
          }
          case 'missed': {
            if (!dryRun) {
              await addJiraComment(
                baseUrl,
                username,
                apiToken,
                issueKey,
                `⚠️ Issue is still not fixed. Please continue to address this issue.`
              );
            }
            synced.push({ key: issueKey, action: 'missed → comment added' });
            break;
          }
          case 'false_positive': {
            if (!dryRun) {
              await transitionJiraIssue(baseUrl, username, apiToken, issueKey, "Won't Fix");
              await addJiraComment(
                baseUrl,
                username,
                apiToken,
                issueKey,
                `ℹ️ Confirmed as false positive: ${result.false_positive_reason || 'No reason provided'}`
              );
            }
            synced.push({ key: issueKey, action: "false_positive → Won't Fix" });
            break;
          }
          default:
            break;
        }
      } catch (error) {
        errors.push(
          `Failed to sync ${issueKey}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const outputLines: string[] = [];
    if (synced.length > 0) {
      outputLines.push(`Synced ${synced.length} JIRA issue(s)${dryRun ? ' (dry run)' : ''}:`);
      for (const s of synced) {
        outputLines.push(`  ${s.key}: ${s.action}`);
      }
    }
    if (errors.length > 0) {
      outputLines.push(`Errors (${errors.length}):`);
      for (const err of errors) {
        outputLines.push(`  ⚠ ${err}`);
      }
    }

    return {
      reporter: 'jira',
      success: errors.length === 0,
      output: outputLines.join('\n') || 'No JIRA issues to sync',
      metadata: {
        synced: synced.length,
        errors: errors.length,
        details: synced,
        dryRun,
      },
    };
  },
};
