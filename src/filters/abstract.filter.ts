import { HttpException, HttpStatus, IntrinsicException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { RequestLogLocals } from '../http';
import type { ArgumentsHost, HttpServer } from '@nestjs/common';
import type { Response } from 'express';

type HttpError = Error & { statusCode: number }; // http-errors (body parser, etc.)

const isHttpError = (error: unknown): error is HttpError =>
  !!(error as HttpError)?.statusCode && !!(error as HttpError)?.message;

export const exceptionStatus = (exception: unknown): number => {
  if (exception instanceof HttpException) return exception.getStatus();
  if (isHttpError(exception)) return exception.statusCode;

  return HttpStatus.INTERNAL_SERVER_ERROR;
};

export const exceptionReason = (exception: unknown): string => {
  const body = exception instanceof HttpException ? exception.getResponse() : undefined;
  const message = typeof body === 'object' ? (body as { message?: unknown })?.message : body;
  const text = Array.isArray(message)
    ? message.join('; ')
    : typeof message === 'string'
      ? message
      : '';
  const reason = text || (exception as Error)?.message || 'Unknown error';

  return reason.replace(/\?\S*/g, ''); // "Cannot GET /x?token=" never leaks the query
};

// Keeps an earlier reason (bodyParserReason); the stack only for real 5xx
export function rememberError(response: Response, error: string, trace?: unknown) {
  const locals = response.locals as RequestLogLocals;

  Object.assign(locals, { error: locals.error ?? error, trace } satisfies RequestLogLocals);
}

// Hands the error reason (and the 5xx stack) to requestLogger instead of logging it here
export abstract class AbstractExceptionFilter<T = unknown> extends BaseExceptionFilter<T> {
  protected remember(response: Response, error: string, trace?: unknown) {
    rememberError(response, error, trace);
  }

  public catch(exception: T, host: ArgumentsHost) {
    if (host.getType() === 'http') {
      const status = exceptionStatus(exception);
      const trace =
        status >= 500 && !(exception instanceof IntrinsicException) ? exception : undefined;

      this.remember(host.switchToHttp().getResponse<Response>(), exceptionReason(exception), trace);
    }

    return super.catch(exception, host);
  }

  // Same reply as BaseExceptionFilter, minus its own log line (requestLogger prints the stack)
  public handleUnknownError(exception: T, host: ArgumentsHost, applicationRef: HttpServer) {
    const body = isHttpError(exception)
      ? { statusCode: exception.statusCode, message: exception.message }
      : { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' };

    const response = host.getArgByIndex(1);

    if (applicationRef.isHeadersSent(response)) return applicationRef.end(response);

    return applicationRef.reply(response, body, body.statusCode);
  }
}
