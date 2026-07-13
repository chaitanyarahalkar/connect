import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CliConfig {
  apiUrl: string;
  token: string;
}

const dir = join(homedir(), '.config', 'connect');
const file = join(dir, 'config.json');

export function loadCliConfig(): CliConfig | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CliConfig;
  } catch {
    return null;
  }
}

export function saveCliConfig(config: CliConfig): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2));
  chmodSync(file, 0o600);
}

export function requireCliConfig(): CliConfig {
  const config = loadCliConfig();
  if (!config) {
    console.error('not logged in — run `connect login` first');
    process.exit(1);
  }
  return config;
}
