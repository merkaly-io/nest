import { Logger } from '@nestjs/common';
import { config, DotenvConfigOptions } from 'dotenv';

let loaded = false;

export function loadEnv(options: DotenvConfigOptions = {}) {
  if (loaded) return;

  config({ quiet: true, ...options });
  loaded = true;
}

const isProduction = () => process.env.NODE_ENV === 'production';

function raw(name: string) {
  loadEnv();

  const value = process.env[name];

  return value === undefined || value.trim() === '' ? undefined : value; // blank counts as missing
}

function invalid(name: string, reason: string) {
  const message = `Env ${name}: ${reason}`;

  if (isProduction()) throw new Error(message); // fail boot in production

  Logger.warn(message, 'Env'); // loud in dev, keeps booting
}

export const env = {
  get isProduction() {
    return isProduction();
  },

  string: ((name: string, fallback?: string) => raw(name) ?? fallback) as {
    (name: string, fallback: string): string;
    (name: string, fallback?: string): string | undefined;
  },

  required(name: string): string | undefined {
    const value = raw(name);

    if (value === undefined) invalid(name, 'is required');

    return value;
  },

  number: ((name: string, fallback?: number) => {
    const value = raw(name);

    if (value === undefined) return fallback;
    if (Number.isFinite(Number(value))) return Number(value);

    invalid(name, `"${value}" is not a number`);

    return fallback;
  }) as {
    (name: string, fallback: number): number;
    (name: string, fallback?: number): number | undefined;
  },

  boolean(name: string, fallback = false): boolean {
    const value = raw(name)?.toLowerCase();

    if (value === undefined) return fallback;
    if (['true', '1', 'yes'].includes(value)) return true;
    if (['false', '0', 'no'].includes(value)) return false;

    invalid(name, `"${value}" is not a boolean`);

    return fallback;
  },

  list(name: string, fallback: string[] = []): string[] {
    const value = raw(name);

    return value === undefined
      ? fallback
      : value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
  },
};
