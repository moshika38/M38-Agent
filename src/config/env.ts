import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dotenv from 'dotenv';

dotenv.config();

const GLOBAL_CONFIG_PATH = path.join(os.homedir(), '.m38rc');
export const DEFAULT_BASE_URL = 'https://api.freellm.in/v1';

export interface M38Config {
  BASE_URL: string;
  FREELLM_API_KEY: string;
}

export function readConfigFile(): Partial<M38Config> {
  if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
    try {
      const content = fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8');
      return JSON.parse(content);
    } catch {}
  }
  return {};
}

export function getStoredKey(): string {
  if (process.env.FREELLM_API_KEY && process.env.FREELLM_API_KEY.trim() !== '') {
    return process.env.FREELLM_API_KEY.trim();
  }
  const config = readConfigFile();
  if (config.FREELLM_API_KEY && typeof config.FREELLM_API_KEY === 'string' && config.FREELLM_API_KEY.trim() !== '') {
    return config.FREELLM_API_KEY.trim();
  }
  return '';
}

export function getBaseURL(): string {
  if (process.env.FREELLM_BASE_URL && process.env.FREELLM_BASE_URL.trim() !== '') {
    return process.env.FREELLM_BASE_URL.trim();
  }
  if (process.env.BASE_URL && process.env.BASE_URL.trim() !== '') {
    return process.env.BASE_URL.trim();
  }
  const config = readConfigFile();
  if (config.BASE_URL && typeof config.BASE_URL === 'string' && config.BASE_URL.trim() !== '') {
    return config.BASE_URL.trim();
  }
  return DEFAULT_BASE_URL;
}

export function getStoredConfig(): { BASE_URL: string; API_KEY: string } {
  return {
    BASE_URL: getBaseURL(),
    API_KEY: getStoredKey(),
  };
}

export function saveGlobalConfig(
  opts: { BASE_URL?: string; FREELLM_API_KEY?: string } | string,
  keyParam?: string
): void {
  let url = DEFAULT_BASE_URL;
  let key = '';

  if (typeof opts === 'object') {
    url = opts.BASE_URL || getBaseURL();
    key = opts.FREELLM_API_KEY || '';
  } else {
    url = opts || getBaseURL();
    key = keyParam || '';
  }

  const updated: M38Config = {
    BASE_URL: url.trim() || DEFAULT_BASE_URL,
    FREELLM_API_KEY: key.trim(),
  };

  fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(updated, null, 2), 'utf-8');
  process.env.BASE_URL = updated.BASE_URL;
  process.env.FREELLM_BASE_URL = updated.BASE_URL;
  process.env.FREELLM_API_KEY = updated.FREELLM_API_KEY;
}

export function saveGlobalKey(key: string): void {
  const currentBase = getBaseURL();
  saveGlobalConfig(currentBase, key);
}

export function reloadConfig(): { BASE_URL: string; API_KEY: string } {
  return getStoredConfig();
}

export function hasValidConfig(): boolean {
  return getStoredKey().length > 0;
}

export const API_KEY = getStoredKey();
export const BASE_URL = getBaseURL();
