export const LOGGER_OPTIONS = Symbol('LOGGER_OPTIONS');

export interface LoggerModuleOptions {
  host?: () => string | undefined; // e.g. tenant host from the request context
  timestamps?: boolean; // default: outside production
}

export interface LoggingOptions {
  group: string;
  message: string;
  type: string; // e.g. controller, event, filter, webhook
}
