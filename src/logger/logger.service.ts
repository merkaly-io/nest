import { Inject, Injectable, LogLevel, Optional } from '@nestjs/common';
import Chalk from 'chalk';
import { env } from '../config';
import { LOGGER_OPTIONS, LoggerModuleOptions, LoggingOptions, RequestLine } from './logger.options';
import { requestContext } from './request-context';

const chalk = new Chalk.Instance(); // own instance; color only on a TTY or with FORCE_COLOR

const LEVELS: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal']; // Nest order, least severe first

const STREAMS: Partial<Record<LogLevel, (line: string) => void>> = {
  error: console.error, // stderr
  fatal: console.error,
  warn: console.warn,
};

// LOG_LEVEL prints that level and above; default `log` in production, `debug` outside
const minimumLevel = () => {
  const fallback: LogLevel = env.isProduction ? 'log' : 'debug';
  const value = env.string('LOG_LEVEL')?.trim().toLowerCase();

  if (value === undefined || LEVELS.includes(value as LogLevel))
    return { level: (value ?? fallback) as LogLevel };

  return { level: fallback, invalid: value }; // never fails boot over the log level
};

const levelColors: Partial<Record<LogLevel, Chalk.Chalk>> = {
  log: chalk.blueBright,
  error: chalk.redBright,
  warn: chalk.yellowBright,
  debug: chalk.magentaBright,
  verbose: chalk.cyanBright,
};

const WIDTH = { level: 7, origin: 24, scope: 22 }; // the description always starts at the same column

const fit = (value: string | undefined, width: number) => {
  const text = value || '-';

  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
};

// `LEVEL ORIGIN SCOPE KIND:: MESSAGE`, fixed widths, `-` when missing; KIND opens the description, never cut
@Injectable()
export class LoggerService {
  private readonly minimum: number;

  constructor(@Optional() @Inject(LOGGER_OPTIONS) private readonly options?: LoggerModuleOptions) {
    const { level, invalid } = minimumLevel();

    this.minimum = LEVELS.indexOf(level);

    if (invalid)
      this.warn({
        group: 'LoggerService',
        message: `LOG_LEVEL "${invalid}" is not a level, using ${level}`,
      });
  }

  public isLevelEnabled(level: LogLevel) {
    return LEVELS.indexOf(level) >= this.minimum;
  }

  public log(options: LoggingOptions) {
    this.print('log', options.group, options.message);
  }

  public error(options: LoggingOptions & { trace?: unknown }) {
    if (this.print('error', options.group, options.message)) this.trace(options.trace);
  }

  public warn(options: LoggingOptions) {
    this.print('warn', options.group, options.message);
  }

  public debug(options: LoggingOptions) {
    this.print('debug', options.group, options.message);
  }

  public verbose(options: LoggingOptions) {
    this.print('verbose', options.group, options.message);
  }

  // Request line from requestLogger: KIND = method, MESSAGE = `/path STATUS Nms "reason"`
  public request(tier: LogLevel, { method, message, trace }: RequestLine) {
    if (this.print(tier, method, message)) this.trace(trace); // no stack under a filtered line
  }

  private trace(trace?: unknown) {
    if (trace) console.error(chalk.gray(trace instanceof Error ? trace.stack : trace));
  }

  private print(tier: LogLevel, kind: string, message: string) {
    if (!this.isLevelEnabled(tier)) return false;

    const color = levelColors[tier] ?? ((txt: string) => txt);
    const timestamps = this.options?.timestamps ?? process.env.NODE_ENV !== 'production';
    const context = requestContext.getStore();
    const origin = context?.origin ?? this.options?.service; // service when there is no request
    const scope = context?.scope?.() ?? this.options?.scope?.();
    const output: string[] = [];

    if (timestamps) output.push(this.currentTime());

    output.push(
      color(fit(tier.toUpperCase(), WIDTH.level)),
      chalk.hex('#00FF77')(fit(origin, WIDTH.origin)),
      chalk.cyan(fit(scope, WIDTH.scope)),
      kind ? `${chalk.hex('#FFA500')(`${kind}::`)} ${message}` : message,
    );

    (STREAMS[tier] ?? console.log)(output.join(' '));

    return true;
  }

  private currentTime() {
    const date = new Date();
    const pad = (n: number, count = 2) => n.toString().padStart(count, '0');

    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${pad(date.getMilliseconds(), 3)}`;
  }
}
