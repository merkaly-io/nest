import { Inject, Injectable, LogLevel, Optional } from '@nestjs/common';
import Chalk from 'chalk';
import { LOGGER_OPTIONS, LoggerModuleOptions, LoggingOptions } from './logger.options';

const chalk = new Chalk.Instance({ level: 3 }); // own instance, global chalk untouched

const levelColors: Partial<Record<LogLevel, Chalk.Chalk>> = {
  log: chalk.blueBright,
  error: chalk.redBright,
  warn: chalk.yellowBright,
  debug: chalk.magentaBright,
  verbose: chalk.cyanBright,
};

@Injectable()
export class LoggerService {
  constructor(@Optional() @Inject(LOGGER_OPTIONS) private readonly options?: LoggerModuleOptions) {}

  public log(options: LoggingOptions) {
    this.print('log', options);
  }

  public error(options: LoggingOptions & { trace?: unknown }) {
    this.print('error', options);
    this.trace(options.trace);
  }

  public warn(options: LoggingOptions) {
    this.print('warn', options);
  }

  public debug(options: LoggingOptions) {
    this.print('debug', options);
  }

  public verbose(options: LoggingOptions) {
    this.print('verbose', options);
  }

  // One line per request: `[origin] METHOD /path STATUS 12ms "reason"`, no label column
  public request(tier: LogLevel, origin: string, message: string, trace?: unknown) {
    this.print(tier, { group: origin, message }, null);
    this.trace(trace);
  }

  private trace(trace?: unknown) {
    if (trace) console.error(chalk.gray(trace instanceof Error ? trace.stack : trace));
  }

  private print(
    tier: LogLevel,
    { group, message }: LoggingOptions,
    label: string | null = this.label,
  ) {
    const color = levelColors[tier] ?? ((txt: string) => txt);
    const timestamps = this.options?.timestamps ?? process.env.NODE_ENV !== 'production';
    const output: string[] = [];

    if (timestamps) output.push(this.currentTime());

    output.push(
      color(tier.toUpperCase().padEnd(7)),
      label ? chalk.hex('#00FF77')(label) : '',
      chalk.hex('#FFA500')(group ? `[${group}]` : ''),
      message,
    );

    return console.log(output.filter(Boolean).join(' '));
  }

  private get label(): string | null {
    return this.options?.context?.() ?? this.options?.service ?? null; // request context, else the service
  }

  private currentTime() {
    const date = new Date();
    const pad = (n: number, count = 2) => n.toString().padStart(count, '0');

    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${pad(date.getMilliseconds(), 3)}`;
  }
}
