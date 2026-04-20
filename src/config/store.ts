/**
 * Configuration Store
 *
 * Manages persistent configuration with two layers:
 * - Global config: ~/.argus/config.json
 * - Local config:  <repoPath>/.argus/config.json
 *
 * Priority: local config > global config (for the same key)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Configuration structure
 */
export interface ArgusConfig {
  /** Anthropic API key */
  apiKey?: string;
  /** Custom base URL (for proxies) */
  baseUrl?: string;
  /** Shared fallback model for all review stages */
  model?: string;
  /** Review agent model */
  agentModel?: string;
  /** Lightweight classification model */
  lightModel?: string;
  /** Realtime deduplication model */
  dedupModel?: string;
}

// ---------------------------------------------------------------------------
// Local repo path context
// ---------------------------------------------------------------------------

let _localRepoPath: string | undefined;

/**
 * Set the local repo path for local config resolution.
 * When set, loadConfig() will merge <repoPath>/.argus/config.json on top of
 * the global config.
 */
export function setLocalRepoPath(repoPath: string | undefined): void {
  _localRepoPath = repoPath ? resolve(repoPath) : undefined;
}

/**
 * Get the currently configured local repo path.
 */
export function getLocalRepoPath(): string | undefined {
  return _localRepoPath;
}

// ---------------------------------------------------------------------------
// Global config helpers
// ---------------------------------------------------------------------------

/**
 * Get global config directory path (~/.argus)
 */
function getGlobalConfigDir(): string {
  return join(homedir(), '.argus');
}

/**
 * Get global config file path
 */
function getGlobalConfigPath(): string {
  return join(getGlobalConfigDir(), 'config.json');
}

/**
 * Ensure global config directory exists
 */
function ensureGlobalConfigDir(): void {
  const dir = getGlobalConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Local config helpers
// ---------------------------------------------------------------------------

/**
 * Get local config directory path (<repoPath>/.argus)
 */
function getLocalConfigDir(repoPath: string): string {
  return join(repoPath, '.argus');
}

/**
 * Get local config file path
 */
function getLocalConfigPath(repoPath: string): string {
  return join(getLocalConfigDir(repoPath), 'config.json');
}

/**
 * Ensure local config directory exists
 */
function ensureLocalConfigDir(repoPath: string): void {
  const dir = getLocalConfigDir(repoPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Load a single config file and return its contents (or {}).
 */
function loadConfigFile(configPath: string): ArgusConfig {
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as ArgusConfig;
  } catch {
    console.error(`Warning: Failed to parse config file at ${configPath}`);
    return {};
  }
}

/**
 * Load global configuration from ~/.argus/config.json
 */
export function loadGlobalConfig(): ArgusConfig {
  return loadConfigFile(getGlobalConfigPath());
}

/**
 * Load local configuration from <repoPath>/.argus/config.json
 */
export function loadLocalConfig(repoPath?: string): ArgusConfig {
  const rp = repoPath ?? _localRepoPath;
  if (!rp) return {};
  return loadConfigFile(getLocalConfigPath(rp));
}

/**
 * Load merged configuration (global + local overlay).
 * Local values override global values for the same key.
 */
export function loadConfig(): ArgusConfig {
  const global = loadGlobalConfig();
  const local = loadLocalConfig();
  return { ...global, ...local };
}

/**
 * Save configuration to the global config file
 */
export function saveConfig(config: ArgusConfig): void {
  ensureGlobalConfigDir();
  const configPath = getGlobalConfigPath();

  // Merge with existing global config
  const existing = loadGlobalConfig();
  const merged = { ...existing, ...config };

  // Remove undefined values
  const cleaned = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));

  writeFileSync(configPath, JSON.stringify(cleaned, null, 2) + '\n', 'utf-8');
}

/**
 * Save configuration to the local (repo-level) config file
 */
export function saveLocalConfig(config: ArgusConfig, repoPath?: string): void {
  const rp = repoPath ?? _localRepoPath;
  if (!rp) {
    throw new Error(
      'Cannot save local config: no repo path specified. Use --repo=<path> or run from a repo directory.'
    );
  }
  ensureLocalConfigDir(rp);
  const configPath = getLocalConfigPath(rp);

  // Merge with existing local config
  const existing = loadLocalConfig(rp);
  const merged = { ...existing, ...config };

  // Remove undefined values
  const cleaned = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));

  writeFileSync(configPath, JSON.stringify(cleaned, null, 2) + '\n', 'utf-8');
}

/**
 * Get a specific config value
 */
export function getConfigValue<K extends keyof ArgusConfig>(key: K): ArgusConfig[K] {
  const config = loadConfig();
  return config[key];
}

/**
 * Set a specific config value
 */
export function setConfigValue<K extends keyof ArgusConfig>(key: K, value: ArgusConfig[K]): void {
  saveConfig({ [key]: value } as ArgusConfig);
}

/**
 * Delete a specific config value from the global config
 */
export function deleteConfigValue(key: keyof ArgusConfig): void {
  const config = loadGlobalConfig();
  delete config[key];

  ensureGlobalConfigDir();
  const configPath = getGlobalConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Delete a specific config value from the local config
 */
export function deleteLocalConfigValue(key: keyof ArgusConfig, repoPath?: string): void {
  const rp = repoPath ?? _localRepoPath;
  if (!rp) {
    throw new Error('Cannot delete local config: no repo path specified.');
  }
  const config = loadLocalConfig(rp);
  delete config[key];

  ensureLocalConfigDir(rp);
  const configPath = getLocalConfigPath(rp);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Clear all configuration
 */
export function clearConfig(): void {
  ensureGlobalConfigDir();
  const configPath = getGlobalConfigPath();
  writeFileSync(configPath, '{}\n', 'utf-8');
}

/**
 * Get global config file location (for display purposes)
 */
export function getConfigLocation(): string {
  return getGlobalConfigPath();
}

/**
 * Get local config file location (for display purposes)
 */
export function getLocalConfigLocation(repoPath?: string): string | undefined {
  const rp = repoPath ?? _localRepoPath;
  if (!rp) return undefined;
  return getLocalConfigPath(rp);
}
