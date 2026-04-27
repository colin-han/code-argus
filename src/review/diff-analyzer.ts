/**
 * Diff Analyzer
 *
 * Analyzes differences between current and existing issues.
 * Uses simple position-based matching to identify:
 * - New issues (not in existing)
 * - Matched existing issues (need fix verify)
 * - Unmatched existing issues (may need fix verify)
 */

import type { ValidatedIssue } from './types.js';
import type { DiffAnalysisResult } from './issue-management/types.js';

/**
 * Analyze differences between current and existing issues.
 *
 * This is a simplified implementation that uses position-based matching.
 * Complex matching and verification is delegated to the Fix Verify Agent.
 *
 * @param currentIssues - Issues from current review
 * @param existingIssues - Issues from previous review (all statuses)
 * @returns Diff analysis result
 */
export function analyzeDiff(
  currentIssues: ValidatedIssue[],
  existingIssues: ValidatedIssue[]
): DiffAnalysisResult {
  const newIssues: ValidatedIssue[] = [];
  const matchedExisting: ValidatedIssue[] = [];
  const unmatchedExisting: ValidatedIssue[] = [];

  // Create a map of existing issues by position key (file:start:end)
  const existingByPosition = new Map<string, ValidatedIssue>();
  for (const issue of existingIssues) {
    const key = getPositionKey(issue);
    existingByPosition.set(key, issue);
  }

  // Match current issues against existing by position
  for (const current of currentIssues) {
    const key = getPositionKey(current);
    const existing = existingByPosition.get(key);

    if (existing) {
      // Found a match - add to matchedExisting for fix verify
      matchedExisting.push(existing);
      // Remove from map so we don't add it to unmatchedExisting
      existingByPosition.delete(key);
    } else {
      // No match - this is a new issue
      newIssues.push(current);
    }
  }

  // Remaining existing issues are unmatched
  for (const issue of existingByPosition.values()) {
    unmatchedExisting.push(issue);
  }

  return {
    newIssues,
    matchedExisting,
    unmatchedExisting,
  };
}

/**
 * Generate a unique position key for an issue.
 *
 * The key combines file path and line range to identify the issue location.
 * This simple approach works for most cases; complex code movements are
 * handled by the Fix Verify Agent which can analyze the actual code.
 */
function getPositionKey(issue: ValidatedIssue): string {
  return `${issue.file}:${issue.line_start}:${issue.line_end}`;
}

/**
 * Map validation status to issue status.
 *
 * This is used during the initial migration/validation when issues
 * are created without an explicit status.
 *
 * @param validationStatus - The validation status from the old system
 * @returns The corresponding issue status
 */
export function mapValidationStatusToIssueStatus(
  validationStatus: 'pending' | 'confirmed' | 'rejected' | 'uncertain'
): 'open' | 'resolved' | 'ignored' {
  switch (validationStatus) {
    case 'pending':
    case 'confirmed':
    case 'uncertain':
      return 'open';
    case 'rejected':
      return 'ignored';
  }
}
