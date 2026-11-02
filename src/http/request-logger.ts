import { LoggerService } from '../logger';
import type { INestApplicationContext } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface RequestLogLocals {
  error?: string; // reason, set by the exception filters and bodyParsers
  trace?: unknown; // 5xx only, printed under the request line
}

export interface RequestLoggerOptions {
  label?: (request: Request) => string | undefined; // default: requestOrigin
}

const MAX_REASON = 200; // validator messages may echo request values

const capped = (reason: string) =>
  reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON)}…` : reason;

const hostOf = (origin?: string) => origin?.split('/').pop() || undefined;

// Who made the request: our frontends send x-merkaly-host, browsers send Origin, the rest is an IP
export function requestOrigin(request: Request) {
  return (
    request.header('x-merkaly-host') ||
    hostOf(request.header('origin')) ||
    request.header('cf-connecting-ip') ||
    request.header('x-forwarded-for')?.split(',')[0].trim() ||
    request.socket?.remoteAddress?.replace(/^::ffff:/, '') ||
    'unknown'
  );
}

// Global express middleware for app.use (covers Swagger and unknown routes); never logs body, headers, tokens or query
export function requestLogger(
  app: INestApplicationContext,
  { label = requestOrigin }: RequestLoggerOptions = {},
): RequestHandler {
  const logger = app.get(LoggerService, { strict: false }); // throws at boot without LoggerModule

  return (request: Request, response: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();

    response.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const path = request.originalUrl.split('?')[0];
      const { error, trace } = response.locals as RequestLogLocals;
      const line = `${request.method} ${path} ${response.statusCode} ${ms.toFixed(0)}ms`;
      const message = error ? `${line} ${JSON.stringify(capped(error))}` : line;
      const origin = label(request) ?? requestOrigin(request);

      if (response.statusCode >= 500) return logger.request('error', origin, message, trace);
      if (response.statusCode >= 400) return logger.request('warn', origin, message);

      return logger.request('log', origin, message);
    });

    next();
  };
}
