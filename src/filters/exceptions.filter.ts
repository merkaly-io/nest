import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Optional,
} from '@nestjs/common';
import { LoggerService } from '../logger';

interface HttpRequest {
  method: string;
  url: string;
}

interface HttpResponse {
  status(code: number): { json(body: unknown): unknown };
}

@Catch()
export class ExceptionsFilter implements ExceptionFilter {
  private readonly logger: LoggerService;

  constructor(@Optional() logger?: LoggerService) {
    this.logger = logger ?? new LoggerService();
  }

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') throw exception; // rpc/ws keep Nest defaults

    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<HttpResponse>();

    const isHttp = exception instanceof HttpException;
    const statusCode = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = isHttp ? exception.getResponse() : 'Internal server error';
    const message = typeof body === 'string' ? body : (body as { message?: unknown }).message;

    const log = { group: ExceptionsFilter.name, type: 'filter' };
    const summary = `${request.method} ${request.url} -> ${statusCode}`;

    if (statusCode >= 500) this.logger.error({ ...log, message: summary, trace: exception });
    else this.logger.warn({ ...log, message: `${summary} ${JSON.stringify(message)}` });

    response.status(statusCode).json({
      statusCode,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
