import {
  CustomStrategy,
  MessagePattern,
  RmqContext,
  RmqOptions,
  ServerRMQ,
} from '@nestjs/microservices';
import { MerkalyRequest } from '../events';
import { LoggerService, requestContext } from '../logger';
import {
  MERKALY_REQUESTS,
  MERKALY_REQUESTS_EXCHANGE,
  REQUESTS_QUEUE_TTL,
  RabbitRequestsOptions,
} from './rabbit.options';

const GROUP = 'REQUEST';

export const requestsQueue = (queue: string) => `${queue}.requests`;

const parse = (content: Buffer): MerkalyRequest | undefined => {
  const packet = JSON.parse(content.toString()) as { data?: MerkalyRequest }; // { pattern, data, id }

  return packet?.data;
};

const readRequest = (content: Buffer) =>
  Promise.resolve(content)
    .then(parse)
    .catch(() => undefined);

// Own transport id: sees only @OnMerkalyRequest handlers, the events server never binds them
export class MerkalyRequestsServer extends ServerRMQ {
  private readonly started = new WeakMap<object, { at: number; line: string }>();

  constructor(
    options: Required<RmqOptions>['options'],
    private readonly requestLogger: LoggerService = new LoggerService(),
  ) {
    super(options);
    this.setTransportId(MERKALY_REQUESTS);
  }

  public override async handleMessage(message: Record<string, any>, channel: any) {
    if (!message) return super.handleMessage(message, channel);

    const request = await readRequest(message.content as Buffer);
    const line = `${request?.type} (${request?.id})`;
    const expiresAt = Date.parse(request?.expiresAt ?? '');

    if (expiresAt <= Date.now()) {
      return this.requestLogger.warn({ group: GROUP, message: `${line} expired, dropped` }); // the caller gave up
    }

    this.started.set(message, { at: Date.now(), line });

    const scope = {
      origin: request?.producer ?? 'unknown', // who asked, like the HTTP origin
      scope: () => request?.organization,
    };

    return requestContext.run(scope, () => super.handleMessage(message, channel));
  }

  public override sendMessage<T = any>(
    message: T,
    replyTo: any,
    correlationId: string,
    context: RmqContext,
  ) {
    const started = this.started.get(context.getMessage());
    const failed = (message as { err?: unknown })?.err;

    if (started) {
      const ms = Date.now() - started.at;
      const text = `${started.line} ${failed ? 'failed' : 'ok'} ${ms}ms`;

      if (failed) this.requestLogger.error({ group: GROUP, message: text });
      else this.requestLogger.log({ group: GROUP, message: text });
    }

    return super.sendMessage(message, replyTo, correlationId, context);
  }
}

// Second microservice next to rabbitConsumerOptions: no retry, no .dlq, short TTL
export function rabbitRequestsOptions(options: RabbitRequestsOptions): CustomStrategy {
  const server = new MerkalyRequestsServer(
    {
      urls: [options.url],
      queue: requestsQueue(options.queue),
      exchange: options.exchange ?? MERKALY_REQUESTS_EXCHANGE,
      exchangeType: 'topic',
      wildcards: true, // binds one routing key per @OnMerkalyRequest
      noAck: true, // a lost request times out at the caller, never retried
      queueOptions: {
        durable: true, // RabbitMQ 4 refuses transient non-exclusive queues; messages still expire in 30 s
        arguments: {
          'x-message-ttl': REQUESTS_QUEUE_TTL,
          'x-max-length': 1000,
          'x-overflow': 'drop-head',
        },
      },
    },
    options.logger,
  );

  return { strategy: server };
}

// One type per handler: its return value is the reply
export const OnMerkalyRequest = (type: string) => MessagePattern(type, MERKALY_REQUESTS);
