import { json, raw, urlencoded } from 'express';
import type { RequestLogLocals } from './request-logger';
import type { INestApplication } from '@nestjs/common';
import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import type { IncomingMessage } from 'http';

export interface BodyParsersOptions {
  raw?: string[]; // paths that keep the body as a Buffer, e.g. /webhook/stripe
  rawBody?: boolean; // also set req.rawBody on json/urlencoded, like NestFactory { rawBody: true }
}

type BodyParserError = Error & { type?: string; statusCode?: number }; // http-errors from body-parser

const keepRawBody = (
  request: IncomingMessage & { rawBody?: Buffer },
  _: unknown,
  buffer: Buffer,
) => {
  if (Buffer.isBuffer(buffer)) request.rawBody = buffer;
};

// Registered right after the body parsers: their parse error message quotes the body, so log a fixed reason
export function bodyParserReason(): ErrorRequestHandler {
  return (error: BodyParserError, _: Request, response: Response, next: NextFunction) => {
    if (error?.type && error.statusCode) {
      const reason = error.type === 'entity.parse.failed' ? 'Invalid JSON body' : error.message;

      Object.assign(response.locals, { error: reason } satisfies RequestLogLocals);
    }

    next(error); // Nest still builds the response
  };
}

// json + urlencoded (+ raw paths) with a safe log reason; Nest then skips its own parsers
export function bodyParsers(app: INestApplication, options: BodyParsersOptions = {}) {
  const verify = options.rawBody ? keepRawBody : undefined;

  for (const path of options.raw ?? []) app.use(path, raw({ type: 'application/json' })); // e.g. signed webhooks

  app.use(json({ verify }), urlencoded({ extended: true, verify }), bodyParserReason());

  return app;
}
