import { contextOf, LoggerService, requestContext } from '../logger';
import type { INestApplicationContext } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface RequestLogLocals {
  error?: string; // reason, set by the exception filters and bodyParsers
  trace?: unknown; // 5xx only, printed under the request line
}

export interface RequestLoggerOptions {
  scope?: (request: Request) => string | undefined; // SCOPE column; default: LoggerModule scope
}

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
      const line = `${path} ${response.statusCode} ${ms.toFixed(0)}ms`;
      const message = error ? `${line} ${JSON.stringify(capped(error))}` : line;
      const tier =
        response.statusCode >= 500 ? 'error' : response.statusCode >= 400 ? 'warn' : 'log';

      // scope resolved now: guards may set the organization late in the request
      requestContext.run(context, () =>
        logger.request(tier, {
          method: request.method,
          message,
          trace: tier === 'error' ? trace : undefined,
        }),
      );
    });

    requestContext.run(context, next);
  };
}
