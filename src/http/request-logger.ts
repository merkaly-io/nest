import { contextOf, LoggerService, requestContext, RequestNoteLevel } from '../logger';
import type { INestApplicationContext } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface RequestLogLocals {
  error?: string; // reason, set by the exception filters and bodyParsers
  trace?: unknown; // 5xx only, printed under the request line
}

export interface RequestLoggerOptions {
  scope?: (request: Request) => string | undefined; // SCOPE column; default: LoggerModule scope
  kind?: (request: Request) => string | undefined; // KIND column (e.g. webhook event); the method then opens the message
}

const LEVELS: RequestNoteLevel[] = ['log', 'warn', 'error'];

const higher = (a: RequestNoteLevel, b: RequestNoteLevel) =>
  LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b;

const MAX_REASON = 200; // validator messages may echo request values

const capped = (reason: string) =>
  reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON)}…` : reason;

// Global express middleware for app.use (covers Swagger and unknown routes); never logs body, headers, tokens or query
export function requestLogger(
  app: INestApplicationContext,
  options: RequestLoggerOptions = {},
): RequestHandler {
  const logger = app.get(LoggerService, { strict: false }); // throws at boot without LoggerModule

  return (request: Request, response: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();
    const context = contextOf(request);

    if (options.scope) context.scope = () => options.scope?.(request);

    response.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const path = request.originalUrl.split('?')[0];
      const { error, trace } = response.locals as RequestLogLocals;
      const kind = options.kind?.(request);
      const target = kind ? `${request.method} ${path}` : path;
      const notes = context.notes ?? [];
      const line = [
        `${target} ${response.statusCode} ${ms.toFixed(0)}ms`,
        error ? JSON.stringify(capped(error)) : '',
        ...notes.map((note) => note.text),
      ]
        .filter(Boolean)
        .join(' ');
      const status: RequestNoteLevel =
        response.statusCode >= 500 ? 'error' : response.statusCode >= 400 ? 'warn' : 'log';
      const tier = notes.reduce((level, note) => higher(level, note.level), status);

      // scope resolved now: guards may set the organization late in the request
      requestContext.run(context, () =>
        logger.request(tier, {
          method: kind || request.method,
          message: line,
          trace: tier === 'error' ? trace : undefined,
        }),
      );
    });

    requestContext.run(context, next);
  };
}
