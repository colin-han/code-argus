#!/usr/bin/env node
/**
 * @argus/core - Automated Code Review CLI Tool
 * Main Entry Point
 */

process.setMaxListeners(20);

// Global error handlers - must be set up first to catch any errors during startup
process.on('uncaughtException', (error, origin) => {
  console.error(`[Argus] Fatal: Uncaught exception from ${origin}:`, error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Argus] Fatal: Unhandled promise rejection:', reason);
  process.exit(1);
});

// Global AbortController for graceful shutdown
const globalAbortController = new AbortController();
// Soft abort: 仅让 orchestrator 跳过后续 agents 分析，继续生成报告
const softAbortController = new AbortController();

/**
 * 中断状态机：
 * - idle:       未中断
 * - prompting:  收到首次 SIGINT，正在等待用户决定是否汇总
 * - soft:       用户选择汇总 —— softAbortController 已 abort，继续走报告流程
 * - hard:       硬退出（用户拒绝 / 再次 SIGINT / SIGTERM）
 */
type InterruptState = 'idle' | 'prompting' | 'soft' | 'hard';
let interruptState: InterruptState = 'idle';

const hardExit = (code = 130): void => {
  interruptState = 'hard';
  globalAbortController.abort();
  softAbortController.abort();
  const forceExitTimer = setTimeout(() => {
    console.log('[Argus] Cleanup timeout, forcing exit');
    process.exit(1);
  }, 5000);
  forceExitTimer.unref();
  // 立即退出，不等待 cleanup（符合 Ctrl+C 用户预期）
  process.exit(code);
};

/**
 * 提示用户是否汇总已发现的问题。
 * 默认 yes（直接回车即汇总）；输入 n/no 退出；Ctrl+C 立即退出。
 */
const promptSoftAbort = async (): Promise<'summarize' | 'exit'> => {
  const { createInterface } = await import('node:readline');

  return new Promise((resolve) => {
    // 使用 stderr 写提示，避免污染 stdout（stdout 可能被用作 reporter 输出）
    process.stderr.write(
      '\n[Argus] 收到中断信号。是否汇总当前已发现的问题并生成报告？[Y/n] (再按 Ctrl+C 立即退出): '
    );

    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });

    // readline 在 terminal 模式下会拦截 SIGINT 并发出 'SIGINT' 事件
    // 我们监听它，实现"prompt 期间再按 Ctrl+C 立即退出"
    rl.on('SIGINT', () => {
      rl.close();
      process.stderr.write('\n[Argus] 强制退出。\n');
      hardExit(130);
    });

    rl.on('line', (answer) => {
      rl.close();
      // 默认 yes：空输入（直接回车）或 y/yes 都视为汇总
      // 只有明确输入 n/no 才退出
      const trimmed = answer.trim();
      const isNo = /^no?$/i.test(trimmed);
      resolve(isNo ? 'exit' : 'summarize');
    });

    // 用户直接关闭 stdin 也视为退出
    rl.on('close', () => {
      // 如果是通过 'line' 事件已 resolve，这里 resolve 无效（Promise 只能 resolve 一次）
      resolve('exit');
    });
  });
};

const handleSigint = async (): Promise<void> => {
  // 状态机驱动
  if (interruptState === 'prompting') {
    // prompt 期间的 SIGINT 已由 readline 的 'SIGINT' 事件处理
    // 这个分支理论上不会到达（rl 会优先消费 SIGINT）
    return;
  }

  if (interruptState === 'soft' || interruptState === 'hard') {
    // 已经处于 soft/hard 状态，再次 Ctrl+C → 硬退出
    process.stderr.write('\n[Argus] 强制退出。\n');
    hardExit(130);
    return;
  }

  // idle → prompting
  interruptState = 'prompting';
  const choice = await promptSoftAbort();

  if (choice === 'summarize') {
    interruptState = 'soft';
    console.log('[Argus] 已停止后续分析，正在汇总已发现的问题...');
    softAbortController.abort();
  } else {
    console.log('[Argus] 已取消。');
    hardExit(130);
  }
};

const handleSigterm = (): void => {
  // SIGTERM 不提示，直接硬退出
  console.log('\n[Argus] Received SIGTERM, shutting down...');
  hardExit(143);
};

process.on('SIGTERM', handleSigterm);
process.on('SIGINT', () => {
  handleSigint().catch((err) => {
    console.error('[Argus] Interrupt handler error:', err);
    hardExit(1);
  });
});

import 'dotenv/config';
import { initializeEnv } from './config/env.js';

// Initialize environment variables for Claude Agent SDK
initializeEnv();

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { reviewByRefs, loadPreviousReview, validatePreviousReviewData } from './review/index.js';
import { createDefaultRegistry } from './review/reporters/index.js';
import type { ReporterConfig, ReporterContext } from './review/reporters/types.js';
import type { ReviewReport } from './review/types.js';
import { detectRefType, getLastCommitAuthor } from './git/ref.js';
import {
  loadConfig,
  loadGlobalConfig,
  loadLocalConfig,
  saveConfig,
  saveLocalConfig,
  deleteConfigValue,
  deleteLocalConfigValue,
  getConfigLocation,
  getLocalConfigLocation,
  setLocalRepoPath,
} from './config/store.js';
import type { ArgusConfig, JiraConfig } from './config/store.js';
import type { PreviousReviewData } from './review/types.js';

/**
 * Get package version from package.json
 */
function getVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    // Try to find package.json (works for both src/ and dist/)
    const packageJsonPath = join(__dirname, '..', 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Get latest version from npm registry
 */
function getLatestVersion(): string | null {
  try {
    const result = execSync('npm view code-argus version', {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Compare two semver versions
 * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

/**
 * Run upgrade command
 */
function runUpgradeCommand(): void {
  const currentVersion = getVersion();
  console.log(`当前版本: v${currentVersion}`);
  console.log('正在检查最新版本...');

  const latestVersion = getLatestVersion();

  if (!latestVersion) {
    console.error('❌ 无法获取最新版本信息，请检查网络连接');
    process.exit(1);
  }

  console.log(`最新版本: v${latestVersion}`);

  if (currentVersion === 'unknown') {
    console.log('\n⚠️  无法确定当前版本，尝试升级...');
  } else if (compareVersions(latestVersion, currentVersion) <= 0) {
    console.log('\n✅ 已经是最新版本！');
    return;
  }

  console.log('\n正在升级...');

  // Use spawnSync for better output handling
  const result = spawnSync('npm', ['install', '-g', 'code-argus@latest'], {
    stdio: 'inherit',
    shell: true,
  });

  if (result.status === 0) {
    console.log(`\n✅ 升级成功！v${currentVersion} -> v${latestVersion}`);
  } else {
    console.error('\n❌ 升级失败，请尝试手动执行: npm install -g code-argus@latest');
    if (result.error) {
      console.error('错误信息:', result.error.message);
    }
    process.exit(1);
  }
}

/**
 * Print usage information
 */
function printUsage(): void {
  console.log(`
Usage: argus <command> [options]

Commands:
  review <repo> <source> <target>    Run AI code review with multiple agents
  config                             Manage configuration (API key, base URL, model)
  upgrade                            Upgrade to the latest version

Global Options:
  -v, --version                      Show version number
  -h, --help                         Show help

Arguments (for review):
  repo          Path to the git repository
  source        Source branch name or commit SHA
  target        Target branch name or commit SHA

  The tool auto-detects whether source/target are branches or commits:
  - Branch names: Uses three-dot diff (origin/target...origin/source)
  - Commit SHAs:  Uses two-dot diff (target..source) for incremental review

Options (review command):
  --json-logs              Output as JSON event stream (for service integration)
                           All progress and final report are output as JSON lines
  --language=<lang>        Output language: zh (default) | en
  --config-dir=<path>      Config directory (auto-loads rules/ and agents/)
  --rules-dir=<path>       Custom review rules directory
  --agents-dir=<path>      Custom agent definitions directory
  --skip-validation        Skip issue validation (faster but less accurate)
  --verbose                Enable verbose output
  --previous-review=<file> Previous review JSON file for fix verification
  --no-verify-fixes        Disable fix verification (when previous-review is set)
  --require-worktree       Require worktree creation, fail if unable to create

External Diff Options (for integration with PR systems):
  --diff-file=<path>       Read diff from file instead of computing from git
  --diff-stdin             Read diff from stdin instead of computing from git
  --commits=<sha1,sha2>    Only diff specific commits (comma-separated)
  --no-smart-merge-filter  Disable smart merge filtering for incremental mode

Config subcommands:
  argus config set <key> <value>     Set a configuration value
  argus config get <key>             Get a configuration value
  argus config list                  List all configuration
  argus config delete <key>          Delete a configuration value
  argus config path                  Show config file location

Config keys:
  api-key       Anthropic API key
  base-url      Custom API base URL (for proxies)
  model         Shared fallback model for all review stages
  agent-model   Model for reviewer agents / validator / fix verifier
  light-model   Model for agent selection and custom agent matching
  dedup-model   Model for realtime issue deduplication

Examples:
  # Branch-based review (initial PR review)
  argus review /path/to/repo feature-branch main

  # Commit-based review (incremental review)
  argus review /path/to/repo abc1234 def5678

  # With options
  argus review /path/to/repo feature-branch main --json-logs
  argus config set api-key sk-ant-xxx

  # Verify fixes from previous review
  argus review /path/to/repo feature-branch main --previous-review=./review-1.json

  # External diff from file (e.g., from Bitbucket API)
  argus review /path/to/repo --diff-file=./pr.diff

  # External diff from stdin
  curl -s "https://bitbucket.org/api/..." | argus review /path/to/repo --diff-stdin

  # Only review specific commits (skip merge commits)
  argus review /path/to/repo --commits=abc123,def456,ghi789
`);
}

/**
 * Print config command usage
 */
function printConfigUsage(): void {
  console.log(`
Usage: argus config <subcommand> [options]

Subcommands:
  set <key> <value>    Set a configuration value
  get <key>            Get a configuration value
  list                 List all configuration
  delete <key>         Delete a configuration value
  path                 Show config file location

Keys:
  api-key            Anthropic API key
  base-url           Custom API base URL (for proxies)
  model              Shared fallback model for all review stages
  agent-model        Model for reviewer agents / validator / fix verifier
  light-model        Model for agent selection and custom agent matching
  dedup-model        Model for realtime issue deduplication
  max-concurrency    Max concurrent agent API calls (default: 2)
  jira.base-url      JIRA server URL (e.g. https://org.atlassian.net)
  jira.username      JIRA username / email
  jira.api-token     JIRA API token
  jira.project-key   JIRA project key (e.g. PROJ)
  jira.issue-type    Issue type to create (default: Bug)
  jira.min-severity  Minimum severity to report (default: warning)
  jira.labels        Labels (comma-separated)
  jira.dry-run       Dry-run mode (true/false)

Options:
  --local              Save/read from repo-local config (<repoPath>/.argus/config.json)
  --repo=<path>        Specify the repo path for --local (defaults to current directory)

Examples:
  argus config set api-key sk-ant-api03-xxxxx
  argus config set base-url https://my-proxy.com/v1
  argus config set model claude-sonnet-4-5-20250929
  argus config set agent-model qwen3-coder-plus
  argus config set --local model qwen3-coder-plus           # Save to repo-local config (cwd)
  argus config set --local --repo=/path/to/repo model xxx   # Save to specific repo config
  argus config list                                         # Show merged config
  argus config list --local                                 # Show local config only
  argus config get api-key
  argus config delete base-url
  argus config delete --local model                         # Delete from local config
  argus config path

Note:
  Global config:  ~/.argus/config.json
  Local config:   <repoPath>/.argus/config.json
  Priority: environment variables > local config > global config
`);
}

/**
 * Parse --local and --repo=<path> flags from config command args.
 * Returns the remaining positional args plus the parsed flags.
 */
function parseConfigFlags(args: string[]): {
  positional: string[];
  isLocal: boolean;
  repoPath: string;
} {
  const positional: string[] = [];
  let isLocal = false;
  let repoPath = process.cwd();

  for (const arg of args) {
    if (arg === '--local') {
      isLocal = true;
    } else if (arg.startsWith('--repo=')) {
      repoPath = arg.slice('--repo='.length);
      isLocal = true; // --repo implies --local
    } else {
      positional.push(arg);
    }
  }

  return { positional, isLocal, repoPath };
}

/**
 * Print a config object in a human-friendly format.
 */
function printConfigEntries(config: ArgusConfig, label: string, location: string): void {
  console.log(`${label}:`);
  console.log('=================================');

  const hasJira = config.jira && Object.keys(config.jira).length > 0;
  const hasTopLevel =
    config.apiKey ||
    config.baseUrl ||
    config.model ||
    config.agentModel ||
    config.lightModel ||
    config.dedupModel ||
    config.maxConcurrency !== undefined;

  if (!hasTopLevel && !hasJira) {
    console.log('(no configuration set)');
  } else {
    if (config.apiKey) console.log(`api-key:           ${maskApiKey(config.apiKey)}`);
    if (config.baseUrl) console.log(`base-url:          ${config.baseUrl}`);
    if (config.model) console.log(`model:             ${config.model}`);
    if (config.agentModel) console.log(`agent-model:       ${config.agentModel}`);
    if (config.lightModel) console.log(`light-model:       ${config.lightModel}`);
    if (config.dedupModel) console.log(`dedup-model:       ${config.dedupModel}`);
    if (config.maxConcurrency !== undefined)
      console.log(`max-concurrency:   ${config.maxConcurrency}`);
    if (hasJira) {
      const j = config.jira!;
      if (j.baseUrl) console.log(`jira.base-url:     ${j.baseUrl}`);
      if (j.username) console.log(`jira.username:     ${j.username}`);
      if (j.apiToken) console.log(`jira.api-token:    ${maskApiKey(j.apiToken)}`);
      if (j.projectKey) console.log(`jira.project-key:  ${j.projectKey}`);
      if (j.issueType) console.log(`jira.issue-type:   ${j.issueType}`);
      if (j.minSeverity) console.log(`jira.min-severity: ${j.minSeverity}`);
      if (j.labels) console.log(`jira.labels:       ${j.labels}`);
      if (j.dryRun !== undefined) console.log(`jira.dry-run:      ${j.dryRun}`);
    }
  }

  console.log('=================================');
  console.log(`Config file: ${location}`);
}

// Map CLI key names to top-level config keys
const TOP_LEVEL_KEY_MAP: Record<string, keyof ArgusConfig> = {
  'api-key': 'apiKey',
  apikey: 'apiKey',
  'base-url': 'baseUrl',
  baseurl: 'baseUrl',
  model: 'model',
  'agent-model': 'agentModel',
  agentmodel: 'agentModel',
  'light-model': 'lightModel',
  lightmodel: 'lightModel',
  'dedup-model': 'dedupModel',
  dedupmodel: 'dedupModel',
  'max-concurrency': 'maxConcurrency',
  maxconcurrency: 'maxConcurrency',
};

// Map CLI key names to jira config keys
const JIRA_KEY_MAP: Record<string, keyof JiraConfig> = {
  'jira.base-url': 'baseUrl',
  'jira.baseurl': 'baseUrl',
  'jira.username': 'username',
  'jira.api-token': 'apiToken',
  'jira.apitoken': 'apiToken',
  'jira.project-key': 'projectKey',
  'jira.projectkey': 'projectKey',
  'jira.issue-type': 'issueType',
  'jira.issuetype': 'issueType',
  'jira.min-severity': 'minSeverity',
  'jira.minseverity': 'minSeverity',
  'jira.labels': 'labels',
  'jira.dry-run': 'dryRun',
  'jira.dryrun': 'dryRun',
};

const ALL_VALID_KEYS =
  'api-key, base-url, model, agent-model, light-model, dedup-model, max-concurrency, ' +
  'jira.base-url, jira.username, jira.api-token, jira.project-key, ' +
  'jira.issue-type, jira.min-severity, jira.labels, jira.dry-run';

/**
 * Resolve a CLI key to either a top-level or jira config mutation.
 * Returns { config } ready to pass to saveConfig/saveLocalConfig,
 * or undefined if the key is unknown.
 */
function resolveConfigKey(key: string): { topKey?: keyof ArgusConfig; jiraKey?: keyof JiraConfig } {
  const topKey = TOP_LEVEL_KEY_MAP[key];
  if (topKey) return { topKey };
  const jiraKey = JIRA_KEY_MAP[key];
  if (jiraKey) return { jiraKey };
  return {};
}

/**
 * Read a single config value by CLI key name.
 */
function readConfigValue(config: ArgusConfig, key: string): string | number | boolean | undefined {
  const { topKey, jiraKey } = resolveConfigKey(key);
  if (topKey) return config[topKey] as string | number | undefined;
  if (jiraKey) return config.jira?.[jiraKey] as string | boolean | undefined;
  return undefined;
}

/**
 * Build an ArgusConfig patch for a set operation.
 */
function buildConfigPatch(key: string, rawValue: string): ArgusConfig | undefined {
  const { topKey, jiraKey } = resolveConfigKey(key);
  if (topKey) {
    // Parse numeric values
    if (topKey === 'maxConcurrency') {
      const n = Number.parseInt(rawValue, 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`max-concurrency must be a positive integer, got: ${rawValue}`);
      }
      return { maxConcurrency: n };
    }
    return { [topKey]: rawValue } as ArgusConfig;
  }
  if (jiraKey) {
    // Parse boolean values for dryRun
    let parsed: string | boolean = rawValue;
    if (jiraKey === 'dryRun') {
      parsed = rawValue === 'true';
    }
    return { jira: { [jiraKey]: parsed } as JiraConfig };
  }
  return undefined;
}

/**
 * Handle config command
 */
function runConfigCommand(args: string[]): void {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    printConfigUsage();
    return;
  }

  // Parse flags from the remaining args (after subcommand)
  const { positional, isLocal, repoPath } = parseConfigFlags(args.slice(1));

  switch (subcommand) {
    case 'set': {
      const key = positional[0]?.toLowerCase();
      const value = positional[1];

      if (!key || !value) {
        console.error('Error: config set requires <key> and <value>\n');
        printConfigUsage();
        process.exit(1);
      }

      const patch = buildConfigPatch(key, value);
      if (!patch) {
        console.error(`Error: Unknown config key "${key}"`);
        console.error(`Valid keys: ${ALL_VALID_KEYS}`);
        process.exit(1);
      }

      if (isLocal) {
        saveLocalConfig(patch, repoPath);
      } else {
        saveConfig(patch);
      }

      // Mask sensitive values in output
      const isSensitive = key === 'api-key' || key === 'jira.api-token';
      const displayValue = isSensitive ? maskApiKey(value) : value;
      const scope = isLocal ? ' (local)' : '';
      console.log(`Set ${key} = ${displayValue}${scope}`);
      break;
    }

    case 'get': {
      const key = positional[0]?.toLowerCase();

      if (!key) {
        console.error('Error: config get requires <key>\n');
        printConfigUsage();
        process.exit(1);
      }

      const { topKey, jiraKey } = resolveConfigKey(key);
      if (!topKey && !jiraKey) {
        console.error(`Error: Unknown config key "${key}"`);
        console.error(`Valid keys: ${ALL_VALID_KEYS}`);
        process.exit(1);
      }

      let config: ArgusConfig;
      if (isLocal) {
        config = loadLocalConfig(repoPath);
      } else {
        setLocalRepoPath(repoPath);
        config = loadConfig();
      }
      const value = readConfigValue(config, key);

      if (value !== undefined && value !== '') {
        const isSensitive = key === 'api-key' || key === 'jira.api-token';
        const displayValue = isSensitive ? maskApiKey(String(value)) : String(value);
        console.log(displayValue);
      } else {
        console.log(`(not set)`);
      }
      break;
    }

    case 'list': {
      if (isLocal) {
        const localConfig = loadLocalConfig(repoPath);
        const localLoc = getLocalConfigLocation(repoPath) ?? `${repoPath}/.argus/config.json`;
        printConfigEntries(localConfig, 'Local configuration', localLoc);
      } else {
        // Ensure local repo path is set so loadConfig() merges both layers
        setLocalRepoPath(repoPath);
        const config = loadConfig();
        const globalLoc = getConfigLocation();
        const localLoc = getLocalConfigLocation(repoPath);

        // Build location display
        let locDisplay = globalLoc;
        if (localLoc) locDisplay += `\nLocal file:  ${localLoc}`;
        printConfigEntries(config, 'Current configuration (merged)', locDisplay);
      }
      break;
    }

    case 'delete': {
      const key = positional[0]?.toLowerCase();

      if (!key) {
        console.error('Error: config delete requires <key>\n');
        printConfigUsage();
        process.exit(1);
      }

      const { topKey, jiraKey } = resolveConfigKey(key);
      if (!topKey && !jiraKey) {
        console.error(`Error: Unknown config key "${key}"`);
        console.error(`Valid keys: ${ALL_VALID_KEYS}`);
        process.exit(1);
      }

      if (topKey) {
        if (isLocal) {
          deleteLocalConfigValue(topKey, repoPath);
        } else {
          deleteConfigValue(topKey);
        }
      } else if (jiraKey) {
        // Delete a single jira sub-key from the target config layer
        if (isLocal) {
          const lc = loadLocalConfig(repoPath);
          if (lc.jira) {
            delete lc.jira[jiraKey];
            saveLocalConfig({ jira: lc.jira }, repoPath);
          }
        } else {
          const gc = loadGlobalConfig();
          if (gc.jira) {
            delete gc.jira[jiraKey];
            saveConfig({ jira: gc.jira });
          }
        }
      }
      const scope = isLocal ? ' (local)' : '';
      console.log(`Deleted ${key}${scope}`);
      break;
    }

    case 'path': {
      console.log(`Global: ${getConfigLocation()}`);
      const localLocation = isLocal ? getLocalConfigLocation(repoPath) : getLocalConfigLocation();
      if (localLocation) {
        console.log(`Local:  ${localLocation}`);
      }
      break;
    }

    default:
      console.error(`Error: Unknown config subcommand "${subcommand}"\n`);
      printConfigUsage();
      process.exit(1);
  }
}

/**
 * Mask API key for display
 */
function maskApiKey(key: string): string {
  if (key.length <= 12) {
    return '***';
  }
  return key.slice(0, 8) + '...' + key.slice(-4);
}

/**
 * External diff options parsed from CLI
 */
interface ExternalDiffOptions {
  diffFile?: string;
  diffStdin?: boolean;
  commits?: string[];
  disableSmartMergeFilter?: boolean;
}

/**
 * Parse CLI options from arguments
 */
function parseOptions(args: string[]): {
  language: 'en' | 'zh';
  configDirs: string[];
  rulesDirs: string[];
  customAgentsDirs: string[];
  skipValidation: boolean;
  jsonLogs: boolean;
  verbose: boolean;
  previousReview?: string;
  verifyFixes?: boolean;
  requireWorktree?: boolean;
  externalDiff: ExternalDiffOptions;
  reporters: string[];
  reporterOpts: Record<string, ReporterConfig>;
  reporterDirs: string[];
} {
  const options: {
    language: 'en' | 'zh';
    configDirs: string[];
    rulesDirs: string[];
    customAgentsDirs: string[];
    skipValidation: boolean;
    jsonLogs: boolean;
    verbose: boolean;
    previousReview?: string;
    verifyFixes?: boolean;
    requireWorktree?: boolean;
    externalDiff: ExternalDiffOptions;
    reporters: string[];
    reporterOpts: Record<string, ReporterConfig>;
    reporterDirs: string[];
  } = {
    language: 'zh',
    configDirs: [],
    rulesDirs: [],
    customAgentsDirs: [],
    skipValidation: false,
    jsonLogs: false,
    verbose: false,
    previousReview: undefined,
    verifyFixes: undefined,
    requireWorktree: undefined,
    externalDiff: {},
    reporters: [],
    reporterOpts: {},
    reporterDirs: [],
  };

  /**
   * 读取 `--flag=value` 或 `--flag value` 形式的值。
   * 对于空格形式，消费下一个参数（索引自增）。
   * 返回 undefined 表示没有有效值（下一个是另一个 flag 或到末尾）。
   */
  const readValue = (name: string, index: number): { value: string | undefined; next: number } => {
    const arg = args[index]!;
    const prefix = `${name}=`;
    if (arg.startsWith(prefix)) {
      const v = arg.substring(prefix.length);
      return { value: v.length > 0 ? v : undefined, next: index };
    }
    if (arg === name) {
      const nextArg = args[index + 1];
      // 下一个参数存在且不像 flag（不以 -- 开头）则当作值
      if (nextArg !== undefined && !nextArg.startsWith('--')) {
        return { value: nextArg, next: index + 1 };
      }
      return { value: undefined, next: index };
    }
    return { value: undefined, next: index };
  };

  const matchesFlag = (name: string, arg: string): boolean =>
    arg === name || arg.startsWith(`${name}=`);

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (matchesFlag('--language', arg)) {
      const { value, next } = readValue('--language', i);
      if (value === 'en' || value === 'zh') {
        options.language = value;
      }
      i = next + 1;
    } else if (matchesFlag('--config-dir', arg)) {
      const { value, next } = readValue('--config-dir', i);
      if (value) options.configDirs.push(value);
      i = next + 1;
    } else if (matchesFlag('--rules-dir', arg)) {
      const { value, next } = readValue('--rules-dir', i);
      if (value) options.rulesDirs.push(value);
      i = next + 1;
    } else if (matchesFlag('--agents-dir', arg)) {
      const { value, next } = readValue('--agents-dir', i);
      if (value) options.customAgentsDirs.push(value);
      i = next + 1;
    } else if (arg === '--skip-validation') {
      options.skipValidation = true;
      i++;
    } else if (arg === '--json-logs') {
      options.jsonLogs = true;
      i++;
    } else if (arg === '--verbose') {
      options.verbose = true;
      i++;
    } else if (matchesFlag('--previous-review', arg)) {
      const { value, next } = readValue('--previous-review', i);
      if (value) {
        options.previousReview = value;
        if (options.verifyFixes === undefined) {
          options.verifyFixes = true;
        }
      }
      i = next + 1;
    } else if (arg === '--no-verify-fixes') {
      options.verifyFixes = false;
      i++;
    } else if (arg === '--verify-fixes') {
      options.verifyFixes = true;
      i++;
    } else if (matchesFlag('--diff-file', arg)) {
      const { value, next } = readValue('--diff-file', i);
      if (value) options.externalDiff.diffFile = value;
      i = next + 1;
    } else if (arg === '--diff-stdin') {
      options.externalDiff.diffStdin = true;
      i++;
    } else if (matchesFlag('--commits', arg)) {
      const { value, next } = readValue('--commits', i);
      if (value) options.externalDiff.commits = value.split(',').map((c) => c.trim());
      i = next + 1;
    } else if (arg === '--no-smart-merge-filter') {
      options.externalDiff.disableSmartMergeFilter = true;
      i++;
    } else if (arg === '--require-worktree') {
      options.requireWorktree = true;
      i++;
    } else if (matchesFlag('--reporters', arg)) {
      const { value, next } = readValue('--reporters', i);
      if (value) options.reporters = value.split(',').map((r) => r.trim());
      i = next + 1;
    } else if (matchesFlag('--format', arg)) {
      // Backward compatibility: --format=X maps to --reporters=X
      const { value, next } = readValue('--format', i);
      if (value && options.reporters.length === 0) {
        options.reporters = [value.trim()];
      }
      i = next + 1;
    } else if (matchesFlag('--reporter-opt', arg)) {
      // Format: --reporter-opt=pluginName.key=value or --reporter-opt pluginName.key=value
      const { value: val, next } = readValue('--reporter-opt', i);
      if (val) {
        const dotIndex = val.indexOf('.');
        if (dotIndex > 0) {
          const pluginName = val.substring(0, dotIndex);
          const rest = val.substring(dotIndex + 1);
          const eqIndex = rest.indexOf('=');
          if (eqIndex > 0) {
            const key = rest.substring(0, eqIndex);
            const value = rest.substring(eqIndex + 1);
            if (!options.reporterOpts[pluginName]) {
              options.reporterOpts[pluginName] = {};
            }
            if (value === 'true') {
              options.reporterOpts[pluginName]![key] = true;
            } else if (value === 'false') {
              options.reporterOpts[pluginName]![key] = false;
            } else if (/^\d+$/.test(value)) {
              options.reporterOpts[pluginName]![key] = Number(value);
            } else {
              options.reporterOpts[pluginName]![key] = value;
            }
          }
        }
      }
      i = next + 1;
    } else if (matchesFlag('--reporter-dir', arg)) {
      const { value, next } = readValue('--reporter-dir', i);
      if (value) options.reporterDirs.push(value);
      i = next + 1;
    } else {
      // 未知参数，跳过
      i++;
    }
  }

  // Expand config-dir into rules-dir and agents-dir
  for (const configDir of options.configDirs) {
    options.rulesDirs.push(`${configDir}/rules`);
    options.customAgentsDirs.push(`${configDir}/agents`);
  }

  return options;
}

/**
 * Load custom reporter plugins from a directory.
 * Scans for *-reporter.ts / *-reporter.js files, dynamically imports them,
 * and registers them in the given registry.
 */
async function loadReporterPlugins(
  registry: ReturnType<typeof createDefaultRegistry>,
  dirPath: string
): Promise<void> {
  const { readdirSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { pathToFileURL } = await import('node:url');

  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return; // Directory doesn't exist or can't be read
  }

  const reporterFiles = entries.filter(
    (f) => (f.endsWith('-reporter.ts') || f.endsWith('-reporter.js')) && !f.startsWith('.')
  );

  for (const file of reporterFiles) {
    const fullPath = resolve(dirPath, file);
    try {
      const mod = await import(pathToFileURL(fullPath).href);
      const plugin = mod.default || mod.plugin;
      if (plugin && plugin.name && plugin.execute && typeof plugin.execute === 'function') {
        registry.register(plugin);
      } else {
        console.error(`Warning: ${file} does not export a valid ReporterPlugin`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Warning: Failed to load reporter plugin ${file}: ${msg}`);
    }
  }
}

/**
 * Run the review command
 */
async function runReviewCommand(
  repoPath: string,
  sourceRef: string | undefined,
  targetRef: string | undefined,
  options: ReturnType<typeof parseOptions>
): Promise<void> {
  // Set local repo path so loadConfig() merges repo-local config
  setLocalRepoPath(repoPath);

  // Determine review mode based on inputs
  const hasExternalDiff =
    options.externalDiff.diffFile || options.externalDiff.diffStdin || options.externalDiff.commits;

  // If using external diff, refs are optional
  let modeLabel: string;
  let sourceType: string | undefined;
  let targetType: string | undefined;

  if (hasExternalDiff) {
    modeLabel = '外部 Diff (External)';
    if (options.externalDiff.diffFile) {
      modeLabel += ` - 文件: ${options.externalDiff.diffFile}`;
    } else if (options.externalDiff.diffStdin) {
      modeLabel += ' - stdin';
    } else if (options.externalDiff.commits) {
      modeLabel += ` - ${options.externalDiff.commits.length} commits`;
    }
  } else if (sourceRef && targetRef) {
    sourceType = detectRefType(sourceRef);
    targetType = detectRefType(targetRef);
    const isIncremental = sourceType === 'commit' && targetType === 'commit';
    modeLabel = isIncremental ? '增量审查 (Incremental)' : '分支审查 (Branch)';
  } else {
    console.error('Error: Either refs (source/target) or external diff options are required\n');
    printUsage();
    process.exit(1);
  }

  // Load previous review if specified
  let previousReviewData: PreviousReviewData | undefined;
  if (options.previousReview) {
    try {
      previousReviewData = loadPreviousReview(options.previousReview);
      validatePreviousReviewData(previousReviewData);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: Failed to load previous review: ${message}`);
      process.exit(1);
    }
  }

  // In JSON logs mode, skip the banner - all output is JSON events
  if (!options.jsonLogs) {
    const configInfo =
      options.configDirs.length > 0 ? `Config:        ${options.configDirs.join(', ')}` : '';
    const rulesInfo =
      options.rulesDirs.length > 0 ? `Rules:         ${options.rulesDirs.join(', ')}` : '';
    const agentsInfo =
      options.customAgentsDirs.length > 0
        ? `Custom Agents: ${options.customAgentsDirs.join(', ')}`
        : '';
    const prevReviewInfo = previousReviewData
      ? `Prev Review:   ${options.previousReview} (${previousReviewData.issues.length} issues)`
      : '';

    if (hasExternalDiff) {
      console.log(`
@argus/core - AI Code Review
=================================
Repository:    ${resolve(repoPath)}
Review Mode:   ${modeLabel}${configInfo ? '\n' + configInfo : ''}${rulesInfo ? '\n' + rulesInfo : ''}${agentsInfo ? '\n' + agentsInfo : ''}${prevReviewInfo ? '\n' + prevReviewInfo : ''}
=================================
`);
    } else {
      const sourceLabel = sourceType === 'commit' ? 'Source Commit' : 'Source Branch';
      const targetLabel = targetType === 'commit' ? 'Target Commit' : 'Target Branch';

      console.log(`
@argus/core - AI Code Review
=================================
Repository:    ${resolve(repoPath)}
${sourceLabel}: ${sourceRef}
${targetLabel}: ${targetRef}
Review Mode:   ${modeLabel}${configInfo ? '\n' + configInfo : ''}${rulesInfo ? '\n' + rulesInfo : ''}${agentsInfo ? '\n' + agentsInfo : ''}${prevReviewInfo ? '\n' + prevReviewInfo : ''}
=================================
`);
    }
  }

  // Build external diff input if provided
  const externalDiffInput = hasExternalDiff
    ? {
        diffFile: options.externalDiff.diffFile,
        diffStdin: options.externalDiff.diffStdin,
        commits: options.externalDiff.commits,
        disableSmartMergeFilter: options.externalDiff.disableSmartMergeFilter,
      }
    : undefined;

  // Load merged config (global + local) for review settings
  const fileConfig = loadConfig();

  // ── Pre-validate exporter reporters BEFORE starting the review ──
  // This ensures we fail fast (e.g., invalid JIRA token, missing project)
  // rather than wasting time on a full review that can't be exported.
  const reporterNames = options.reporters.length > 0 ? [...options.reporters] : ['markdown'];

  // Auto-enable JIRA reporter when JIRA config exists in config files
  if (
    fileConfig.jira &&
    Object.keys(fileConfig.jira).length > 0 &&
    !reporterNames.includes('jira')
  ) {
    reporterNames.push('jira');
  }

  const registry = createDefaultRegistry();

  // Load custom reporter plugins from directories
  for (const dir of options.reporterDirs) {
    try {
      await loadReporterPlugins(registry, dir);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Warning: Failed to load reporter plugins from ${dir}: ${msg}`);
    }
  }

  // Merge JIRA config from config file into reporterOpts (CLI opts take precedence)
  const mergedReporterOpts = { ...options.reporterOpts };
  if (fileConfig.jira && Object.keys(fileConfig.jira).length > 0) {
    const jiraFromFile: Record<string, string | boolean> = {};
    for (const [k, v] of Object.entries(fileConfig.jira)) {
      if (v !== undefined) jiraFromFile[k] = v;
    }
    mergedReporterOpts['jira'] = { ...jiraFromFile, ...mergedReporterOpts['jira'] };
  }

  // Validate exporter reporters (e.g., JIRA token & project)
  const exporterNames = reporterNames.filter((n) => registry.get(n)?.type === 'exporter');
  if (exporterNames.length > 0) {
    try {
      await registry.validateAll(exporterNames, mergedReporterOpts);
    } catch (validationError) {
      const msg =
        validationError instanceof Error ? validationError.message : String(validationError);
      console.error(`Reporter validation failed: ${msg}`);
      process.exit(1);
    }
  }

  // Use the new reviewByRefs API which auto-detects ref types
  const report = await reviewByRefs({
    repoPath,
    sourceRef,
    targetRef,
    externalDiff: externalDiffInput,
    options: {
      verbose: options.verbose,
      skipValidation: options.skipValidation,
      rulesDirs: options.rulesDirs,
      customAgentsDirs: options.customAgentsDirs,
      // Use JSON logs mode if specified, otherwise auto-detect
      progressMode: options.jsonLogs ? 'json' : 'auto',
      // Fix verification options
      previousReviewData,
      verifyFixes: options.verifyFixes,
      // Worktree requirement
      requireWorktree: options.requireWorktree,
      // orchestrator 使用 softAbortController：
      // - 用户软中断时，正在运行的 agents 流会被中止，已上报的 issues 得以保留
      // - orchestrator 内部检测到 abort 后跳过剩余 agents，继续生成报告
      abortController: softAbortController,
      // Max concurrent agent API calls (from config, defaults applied downstream)
      maxConcurrency: fileConfig.maxConcurrency,
    },
  });

  if (options.jsonLogs) {
    // In JSON logs mode, output the report as a JSON event to stderr
    const reportEvent = {
      type: 'report',
      data: {
        report,
        timestamp: new Date().toISOString(),
      },
    };
    // 安全写入 stderr，避免 ERR_STREAM_WRITE_AFTER_END 错误
    if (process.stderr.writable) {
      try {
        process.stderr.write(JSON.stringify(reportEvent) + '\n');
      } catch {
        // 忽略写入错误
      }
    }
  } else {
    // Use reporter plugin system (registry & config already set up above)
    const authorEmail = sourceRef ? getLastCommitAuthor(repoPath, sourceRef) : undefined;
    const reporterContext: ReporterContext = {
      repoPath,
      sourceRef: sourceRef ?? undefined,
      targetRef: targetRef ?? undefined,
      language: options.language,
      verbose: options.verbose,
      authorEmail,
    };

    const { results, updatedReport } = await registry.executeAll(
      reporterNames,
      report,
      reporterContext,
      mergedReporterOpts
    );

    // Output formatter results to stdout
    for (const result of results) {
      if (result.output && result.success) {
        const plugin = registry.get(result.reporter);
        if (plugin?.type === 'formatter') {
          console.log(result.output);
        } else {
          // Exporter output goes to stderr
          if (process.stderr.writable) {
            try {
              process.stderr.write(result.output + '\n');
            } catch {
              // Ignore write errors
            }
          }
        }
      }
      if (!result.success && result.error) {
        console.error(`Reporter '${result.reporter}' failed: ${result.error}`);
      }
    }

    // Sync external systems if fix verification was performed
    if (options.verifyFixes && previousReviewData && updatedReport.fix_verification) {
      const prevReport: ReviewReport = {
        summary: '',
        risk_level: 'low',
        issues: previousReviewData.issues.map((i) => ({
          ...i,
          validation_status: 'confirmed' as const,
          grounding_evidence: {
            checked_files: [],
            checked_symbols: [],
            related_context: '',
            reasoning: '',
          },
          final_confidence: i.confidence ?? 0.8,
        })),
        checklist: [],
        metrics: {
          total_scanned: 0,
          confirmed: 0,
          rejected: 0,
          uncertain: 0,
          by_severity: { critical: 0, error: 0, warning: 0, suggestion: 0 },
          by_category: {
            security: 0,
            logic: 0,
            performance: 0,
            style: 0,
            maintainability: 0,
          },
          files_reviewed: 0,
        },
        metadata: { review_time_ms: 0, tokens_used: 0, agents_used: [] },
      };

      const syncResults = await registry.syncAll(
        reporterNames,
        updatedReport,
        prevReport,
        reporterContext,
        mergedReporterOpts
      );

      for (const result of syncResults) {
        if (result.output) {
          if (process.stderr.writable) {
            try {
              process.stderr.write(result.output + '\n');
            } catch {
              // Ignore write errors
            }
          }
        }
        if (!result.success && result.error) {
          console.error(`Reporter sync '${result.reporter}' failed: ${result.error}`);
        }
      }
    }
  }
}

/**
 * Main CLI function
 */
export async function main(): Promise<void> {
  // Parse command line arguments
  // process.argv[0] = node executable
  // process.argv[1] = script path
  // process.argv[2+] = user arguments
  const args = process.argv.slice(2);

  // Handle no arguments or help
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage();
    return;
  }

  // Handle version
  if (args[0] === '--version' || args[0] === '-v') {
    console.log(`code-argus v${getVersion()}`);
    return;
  }

  // Check if first arg is a command
  const firstArg = args[0];

  // Handle config command
  if (firstArg === 'config') {
    runConfigCommand(args.slice(1));
    return;
  }

  // Handle upgrade command
  if (firstArg === 'upgrade') {
    runUpgradeCommand();
    return;
  }

  // Handle review command
  if (firstArg === 'review') {
    // Parse all arguments to check for external diff options
    const allArgs = args.slice(1);
    const optionArgs = allArgs.filter((a) => a.startsWith('--'));
    const positionalArgs = allArgs.filter((a) => !a.startsWith('--'));
    const options = parseOptions(optionArgs);

    // Check if using external diff mode
    const hasExternalDiff =
      options.externalDiff.diffFile ||
      options.externalDiff.diffStdin ||
      options.externalDiff.commits;

    let repoPath: string;
    let sourceRef: string | undefined;
    let targetRef: string | undefined;

    if (hasExternalDiff) {
      // External diff mode: only repo path is required
      if (positionalArgs.length < 1) {
        console.error('Error: review command with external diff requires <repo>\n');
        printUsage();
        process.exit(1);
      }
      repoPath = positionalArgs[0] ?? '';
      sourceRef = positionalArgs[1]; // Optional
      targetRef = positionalArgs[2]; // Optional
    } else {
      // Normal mode: repo, source, target are required
      if (positionalArgs.length < 3) {
        console.error('Error: review command requires <repo> <source> <target>\n');
        printUsage();
        process.exit(1);
      }
      repoPath = positionalArgs[0] ?? '';
      sourceRef = positionalArgs[1] ?? '';
      targetRef = positionalArgs[2] ?? '';

      // Validate arguments are not empty
      if (!repoPath || !sourceRef || !targetRef) {
        console.error('Error: All arguments must be non-empty\n');
        printUsage();
        process.exit(1);
      }
    }

    try {
      await runReviewCommand(repoPath, sourceRef, targetRef, options);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      // Output JSON error event if in json-logs mode
      if (options.jsonLogs) {
        const errorEvent = {
          type: 'review:error',
          data: {
            error: errorMsg,
            stack: errorStack,
            timestamp: new Date().toISOString(),
          },
        };
        // 安全写入 stderr，避免 ERR_STREAM_WRITE_AFTER_END 错误
        if (process.stderr.writable) {
          try {
            process.stderr.write(JSON.stringify(errorEvent) + '\n');
          } catch {
            // 忽略写入错误
          }
        }
      }

      // Also output human-readable error
      if (error instanceof Error) {
        console.error(`\n❌ Review failed: ${error.message}`);
        // 显示堆栈信息以便调试
        if (options.verbose || process.env.DEBUG) {
          console.error('\nStack trace:');
          console.error(error.stack);
        } else if (!options.jsonLogs) {
          console.error('(Run with --verbose or DEBUG=1 to see stack trace)');
        }
      } else {
        console.error('\n❌ Unexpected error:', error);
      }
      process.exit(1);
    }
    return;
  }

  // Unknown command
  console.error(`Error: Unknown command "${firstArg}"\n`);
  printUsage();
  process.exit(1);
}

// Run CLI
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
