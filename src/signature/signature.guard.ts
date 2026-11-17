import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';

export interface WebhookRequest {
  rawBody: Buffer; // needs NestFactory.create(..., { rawBody: true })
  headers: Record<string, string | string[] | undefined>;
}

export abstract class SignatureGuard implements CanActivate {
  protected abstract verify(request: WebhookRequest): boolean | Promise<boolean>;

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Partial<WebhookRequest>>();

    if (!Buffer.isBuffer(request.rawBody)) {
      throw new BadRequestException('Raw body unavailable (unsupported content type?)');
    }

    return Promise.resolve(this.verify(request as WebhookRequest)).then((valid) => {
      if (!valid) throw new UnauthorizedException('Invalid webhook signature');

      return true;
    });
  }

  protected header(request: Pick<WebhookRequest, 'headers'>, name: string) {
    const value = request.headers[name.toLowerCase()];

    return Array.isArray(value) ? value[0] : value; // first value wins
  }
}
