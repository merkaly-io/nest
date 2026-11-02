import type { InjectionToken, ModuleMetadata, OptionalFactoryDependency } from '@nestjs/common';

export const LOGGER_OPTIONS = Symbol('LOGGER_OPTIONS');

export interface LoggerModuleOptions {
  service: string; // ORIGIN outside a request, e.g. api.merkaly.io
  scope?: () => string | undefined; // SCOPE column, e.g. organization id from CLS
  timestamps?: boolean; // default: outside production
}

export interface LoggerModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory: (...args: any[]) => LoggerModuleOptions | Promise<LoggerModuleOptions>;
}

export interface LoggingOptions {
  group: string; // KIND column: the component that logs
  message: string;
  type?: string; // not printed, kept for callers (controller, event, filter...)
}

export interface RequestLine {
  method: string; // KIND column
  message: string; // `/path STATUS Nms "reason"`
  trace?: unknown; // printed under the line
}
