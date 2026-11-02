import { AsyncLocalStorage } from 'async_hooks';
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export type RequestNoteLevel = 'log' | 'warn' | 'error';

export interface RequestNote {
  text: string;
  level: RequestNoteLevel; // raises the request line level, never lowers it
}

export interface RequestContext {
  origin: string; // ORIGIN column of every line logged during the request
  scope?: () => string | undefined; // from requestLogger({ scope })
  notes?: RequestNote[]; // appended to the request line instead of separate lines
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

// Adds an outcome to the request line (`-> payment.received`); false outside a request
export function noteRequest(text: string, level: RequestNoteLevel = 'log') {
  const context = requestContext.getStore();

  if (!context) return false;

  (context.notes ??= []).push({ level, text });

  return true;
}

const CONTEXT = Symbol('merkaly.request.context');

type ContextRequest = Request & { [CONTEXT]?: RequestContext };

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

// Same context object for the whole request, created by whoever runs first
export function contextOf(request: Request): RequestContext {
  const req = request as ContextRequest;

  return (req[CONTEXT] ??= { origin: requestOrigin(request) });
}

// Registered by LoggerModule after the body parsers (they can drop async context), like nestjs-cls
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: Request, _: Response, next: NextFunction) {
    requestContext.run(contextOf(request), next);
  }
}
