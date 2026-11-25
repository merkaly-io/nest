import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
  RpcExceptionFilter,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { LoggerService } from '../logger';

// Wire shape of a failed invoke, the `err` of the Nest reply packet
export interface InvokeError {
  status: number; // HTTP status of the handler's exception, 500 for anything else
  message: string;
  code?: string | number; // from the exception response, when the handler set one
}

const GROUP = 'INVOKE';

export const isInvokeError = (error: unknown): error is InvokeError =>
  typeof (error as InvokeError)?.status === 'number' &&
  typeof (error as InvokeError)?.message === 'string';

const readMessage = (exception: HttpException): string => {
  const body = exception.getResponse();
  const message = typeof body === 'object' ? (body as { message?: unknown }).message : body;

  if (Array.isArray(message)) return message.join('; '); // ValidationPipe

  return typeof message === 'string' ? message : exception.message;
};

const readCode = (exception: HttpException): InvokeError['code'] => {
  const code = (exception.getResponse() as { code?: unknown })?.code;

  return typeof code === 'string' || typeof code === 'number' ? code : undefined;
};

export const toInvokeError = (exception: unknown): InvokeError => {
  if (!(exception instanceof HttpException)) {
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' }; // never leaks internals
  }

  const code = readCode(exception);

  return {
    status: exception.getStatus(),
    message: readMessage(exception),
    ...(code === undefined ? {} : { code }),
  };
};

// Set by @HandleInvoke: the reply carries the status and message instead of Nest's generic error
@Catch()
@Injectable()
export class InvokeExceptionFilter implements RpcExceptionFilter {
  private readonly logger: LoggerService;

  constructor(@Optional() logger?: LoggerService) {
    this.logger = logger ?? new LoggerService();
  }

  public catch(exception: unknown, _host: ArgumentsHost): Observable<never> {
    if (!(exception instanceof HttpException)) {
      this.logger.error({
        group: GROUP,
        message: (exception as Error)?.message ?? String(exception),
        trace: exception,
      });
    }

    return throwError(() => toInvokeError(exception));
  }
}
