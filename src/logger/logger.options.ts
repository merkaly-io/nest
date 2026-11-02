import type { InjectionToken, ModuleMetadata, OptionalFactoryDependency } from '@nestjs/common';

export const LOGGER_OPTIONS = Symbol('LOGGER_OPTIONS');

export interface LoggerModuleOptions {
  service: string; // label of internal logs outside a request, e.g. api.merkaly.io
  context?: () => string | undefined; // label inside a request, e.g. CLS tenant host
  timestamps?: boolean; // default: outside production
}

export interface LoggerModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory: (...args: any[]) => LoggerModuleOptions | Promise<LoggerModuleOptions>;
}

export interface LoggingOptions {
  group: string;
  message: string;
  type?: string; // not printed, kept for callers (controller, event, filter...)
}
