import { Inject, Injectable, LogLevel, Optional } from '@nestjs/common';
import Chalk from 'chalk';
import { LOGGER_OPTIONS, LoggerModuleOptions, LoggingOptions, RequestLine } from './logger.options';
import { requestContext } from './request-context';

const chalk = new Chalk.Instance({ level: 3 }); // own instance, global chalk untouched

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
  constructor(@Optional() @Inject(LOGGER_OPTIONS) private readonly options?: LoggerModuleOptions) {}

  public log(options: LoggingOptions) {
    this.print('log', options.group, options.message);
  }

  public error(options: LoggingOptions & { trace?: unknown }) {
    this.print('error', options.group, options.message);
    this.trace(options.trace);
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
    this.print(tier, method, message);
    this.trace(trace);
  }

  private trace(trace?: unknown) {
    if (trace) console.error(chalk.gray(trace instanceof Error ? trace.stack : trace));
  }

  private print(tier: LogLevel, kind: string, message: string) {
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

    return console.log(output.join(' '));
  }

  private currentTime() {
    const date = new Date();
    const pad = (n: number, count = 2) => n.toString().padStart(count, '0');

    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${pad(date.getMilliseconds(), 3)}`;
  }
}
