import {
  CustomStrategy,
  MessageHandler,
  ReadPacket,
  RmqContext,
  ServerRMQ,
} from '@nestjs/microservices';
import { MerkalyInvoke } from '../events';
import { LoggerService, requestContext } from '../logger';
import { DEAD_LETTER_GROUP } from './events.consumer';
import { describeError } from './events.publisher';
import { isInvokeError } from './invoke.filter';
import {
  INVOKES_TRANSPORT,
  MERKALY_EXTRAS,
  MerkalyHandlerExtras,
  queueTransport,
} from './rabbit.decorators';
import { rememberDelivery } from './rabbit.delivery';
import {
  deadLetterQueue,
  exchangeName,
  invokesQueueName,
  queueName,
  retryQueue,
} from './rabbit.names';
import {
  DEFAULT_PREFETCH,
  DEFAULT_RETRIES,
  DEFAULT_RETRY_DELAY,
  INVOKES_QUEUE_TTL,
  RabbitInvokesOptions,
  RabbitQueueOptions,
} from './rabbit.options';
import type { Channel, ConsumeMessage, Options } from 'amqplib';

const WEEK = 7 * 24 * 60 * 60 * 1000;

interface ServerSpec {
  url: string;
  service: string;
  queue: string; // full name, merkaly.<service>-<work>
  transport: symbol;
  noAck: boolean;
  prefetchCount: number;
  arguments: Record<string, unknown>;
  logger?: LoggerService;
}

interface Binding {
  exchange: string;
  key: string;
}

// Declares its queue, asserts every source exchange and binds one exact key per handler
abstract class MerkalyServer extends ServerRMQ {
  protected readonly log: LoggerService;
  protected readonly service: string;
  private readonly prefetch: number;

  protected constructor(spec: ServerSpec) {
    super({
      urls: [spec.url],
      queue: spec.queue,
      noAck: spec.noAck,
      queueOptions: { durable: true, arguments: spec.arguments },
    });
    this.setTransportId(spec.transport);
    this.log = spec.logger ?? new LoggerService();
    this.service = spec.service;
    this.prefetch = spec.prefetchCount;
  }

  // Nest chains two event handlers of the same key: both would ack the message, so boot fails instead
  public override addHandler(
    pattern: any,
    callback: MessageHandler,
    isEventHandler?: boolean,
    extras: Record<string, any> = {},
  ) {
    const bindings = (extras[MERKALY_EXTRAS] as MerkalyHandlerExtras | undefined)?.bindings;

    if (typeof pattern !== 'string' || !bindings || !(pattern in bindings)) {
      throw new Error(
        `Queue ${this.queue}: ${JSON.stringify(pattern)} is not a @HandleEvent, @HandleCommand or @HandleInvoke key`,
      );
    }

    if (this.messageHandlers.has(pattern)) {
      throw new Error(
        `Queue ${this.queue}: "${pattern}" has two handlers, bind each key once per queue`,
      );
    }

    super.addHandler(pattern, callback, isEventHandler, extras);
  }

  public bindings(): Binding[] {
    return Array.from(this.messageHandlers.entries()).map(([key, handler]) => {
      const from = (handler.extras?.[MERKALY_EXTRAS] as MerkalyHandlerExtras).bindings[key];

      return { exchange: exchangeName(from ?? this.service), key };
    });
  }

  // Replaces Nest's setup: several source exchanges and exact keys only (no wildcards option)
  public override async setupChannel(channel: Channel, callback: () => void) {
    const bindings = this.bindings();
    const exchanges = [...new Set(bindings.map(({ exchange }) => exchange))];

    await this.assertSideQueues(channel);
    await channel.assertQueue(this.queue, this.queueOptions as Options.AssertQueue);

    for (const exchange of exchanges)
      await channel.assertExchange(exchange, 'topic', { durable: true });
    for (const { exchange, key } of bindings) await channel.bindQueue(this.queue, exchange, key);

    if (!bindings.length) {
      this.log.warn({
        group: 'RABBIT',
        message: `${this.queue} has no handlers: check the queue name in the decorators`,
      });
    }

    await channel.prefetch(this.prefetch, false);
    await channel.consume(
      this.queue,
      (message) => {
        this.handleMessage(message as ConsumeMessage, channel).catch((error: unknown) =>
          this.handleError(describeError(error)),
        );
      },
      { noAck: this.noAck },
    );

    this.log.log({
      group: 'RABBIT',
      message: `${this.queue} <- ${bindings.map(({ exchange, key }) => `${exchange}/${key}`).join(', ')}`,
    });
    callback();
  }

  protected assertSideQueues(_channel: Channel): Promise<unknown> {
    return Promise.resolve();
  }

  // Keys are exact and equal to the pattern; .retry hands messages back through the default exchange ('')
  protected override isPatternOfRoutingKey(
    pattern: string,
    fields: Record<string, any> | undefined,
  ) {
    const matches = !fields?.exchange || fields.routingKey === pattern;

    if (!matches) {
      this.unhandled(`${pattern} arrived with routing key "${fields?.routingKey}"`); // Nest nacks it right after
    }

    return matches;
  }

  // No handler for the key (old binding, renamed type): never acked in silence (ENG-115)
  public override handleEvent(pattern: string, packet: ReadPacket, context: RmqContext) {
    if (this.getHandlerByPattern(pattern)) return super.handleEvent(pattern, packet, context);

    if (!this.noAck) this.channel?.nack(context.getMessage() as ConsumeMessage, false, false);
    this.unhandled(
      `${pattern} (${(packet.data as { id?: string } | undefined)?.id}) has no handler`,
    );

    return Promise.resolve();
  }

  protected unhandled(reason: string) {
    this.log.warn({ group: 'RABBIT', message: `${this.queue}: ${reason}, dropped` });
  }
}

// Events and commands: manual ack by EventsConsumer, .retry and .dlq per queue
export class MerkalyQueueServer extends MerkalyServer {
  private readonly retries: number;
  private readonly retryDelay: number;

  constructor(options: RabbitQueueOptions) {
    const queue = queueName(options.service, options.queue);

    super({
      url: options.url,
      service: options.service,
      queue,
      transport: queueTransport(options.queue),
      noAck: false, // EventsConsumer acks
      prefetchCount: options.prefetchCount ?? DEFAULT_PREFETCH,
      arguments: {
        // Frozen: changing them makes the broker refuse the redeclare (PRECONDITION_FAILED).
        // Production overrides overflow and limits with the merkaly-work operator policy (docs/events.md)
        'x-message-ttl': WEEK, // unconsumed for a week: to the .dlq
        'x-max-length': 10_000,
        'x-overflow': 'drop-head', // reject-publish-dlx under the policy
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': deadLetterQueue(queue),
      },
      logger: options.logger,
    });
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.retryDelay = options.retryDelay ?? DEFAULT_RETRY_DELAY;
  }

  // .dlq keeps what failed; .retry holds a message for retryDelay and hands it back to the queue
  protected override async assertSideQueues(channel: Channel) {
    await channel.assertQueue(deadLetterQueue(this.queue), { durable: true });
    await channel.assertQueue(retryQueue(this.queue), {
      durable: true,
      arguments: {
        'x-message-ttl': this.retryDelay,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': this.queue,
      },
    });
  }

  // Nacked without requeue: the queue dead-letters it to its .dlq
  protected override unhandled(reason: string) {
    this.log.error({
      group: DEAD_LETTER_GROUP,
      message: `${reason} -> ${deadLetterQueue(this.queue)}`,
    });
  }

  // The queue of origin comes from this server, never from the payload
  public override handleMessage(message: Record<string, any>, channel: any) {
    if (message) rememberDelivery(message, { queue: this.queue, retries: this.retries });

    return super.handleMessage(message, channel);
  }
}

const GROUP = 'INVOKE';

const readInvoke = (content: Buffer): MerkalyInvoke | undefined => {
  try {
    return (JSON.parse(content.toString()) as { data?: MerkalyInvoke })?.data; // { pattern, data, id }
  } catch {
    return undefined; // Nest answers the malformed packet itself
  }
};

// Request-reply: noAck, no .retry nor .dlq, short TTL; a lost invoke times out at the caller
export class MerkalyInvokesServer extends MerkalyServer {
  private readonly started = new WeakMap<object, { at: number; line: string }>();

  constructor(options: RabbitInvokesOptions) {
    super({
      url: options.url,
      service: options.service,
      queue: invokesQueueName(options.service),
      transport: INVOKES_TRANSPORT,
      noAck: true,
      prefetchCount: 0, // ignored with noAck
      arguments: {
        'x-message-ttl': INVOKES_QUEUE_TTL,
        'x-max-length': 1000,
        'x-overflow': 'drop-head',
      },
      logger: options.logger,
    });
  }

  public override handleMessage(message: Record<string, any>, channel: any) {
    if (!message) return super.handleMessage(message, channel);

    const invoke = readInvoke(message.content as Buffer);
    const line = `${invoke?.type} (${invoke?.id})`;

    if (Date.parse(invoke?.expiresAt ?? '') <= Date.now()) {
      this.log.warn({ group: GROUP, message: `${line} expired, dropped` }); // the caller gave up

      return Promise.resolve();
    }

    this.started.set(message, { at: Date.now(), line });

    const scope = {
      origin: invoke?.producer ?? 'unknown', // who asked, like the HTTP origin
      scope: () => invoke?.organization,
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
    const outcome = isInvokeError(failed)
      ? `failed ${failed.status} "${failed.message}"`
      : 'failed';

    if (started) {
      const text = `${started.line} ${failed ? outcome : 'ok'} ${Date.now() - started.at}ms`;

      if (failed) this.log.error({ group: GROUP, message: text });
      else this.log.log({ group: GROUP, message: text });
    }

    return super.sendMessage(message, replyTo, correlationId, context);
  }
}

// app.connectMicroservice(rabbitQueue({ url, service: 'api', queue: 'payments' }))
export const rabbitQueue = (options: RabbitQueueOptions): CustomStrategy => ({
  strategy: new MerkalyQueueServer(options),
});

// app.connectMicroservice(rabbitInvokes({ url, service: 'api' }))
export const rabbitInvokes = (options: RabbitInvokesOptions): CustomStrategy => ({
  strategy: new MerkalyInvokesServer(options),
});
