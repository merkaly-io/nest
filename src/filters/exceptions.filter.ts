import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  IntrinsicException,
} from '@nestjs/common';
import { exceptionReason, exceptionStatus, rememberError } from './abstract.filter';
import type { Request, Response } from 'express';

// Ready-made global filter with a JSON body ({ statusCode, message, path, timestamp }); requestLogger prints the reason
@Catch()
export class ExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') throw exception; // rpc/ws keep Nest defaults

    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const statusCode = exceptionStatus(exception);
    const isHttp = exception instanceof HttpException;
    const body = isHttp ? exception.getResponse() : 'Internal server error';
    const message = typeof body === 'string' ? body : (body as { message?: unknown }).message;
    const trace =
      statusCode >= 500 && !(exception instanceof IntrinsicException) ? exception : undefined;

    rememberError(response, exceptionReason(exception), trace);

    response.status(statusCode).json({
      statusCode,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
