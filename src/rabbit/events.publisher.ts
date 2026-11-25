import { randomUUID } from 'crypto';
import {
  GatewayTimeoutException,
  HttpException,
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AmqpConnectionManager, ChannelWrapper, connect } from 'amqp-connection-manager';
import { MerkalyEvent, MerkalyEventMeta, MerkalyInvoke, createMerkalyEvent } from '../events';
import { LoggerService, noteRequest } from '../logger';
import { assertMessageType, exchangeName } from './rabbit.names';
import {
  BrokerStatus,
  DEFAULT_INVOKE_TIMEOUT,
  DEFAULT_PUBLISH_TIMEOUT,
  MerkalyInvokeOptions,
  RABBIT_OPTIONS,
  RabbitModuleOptions,
} from './rabbit.options';
import type { ConfirmChannel, ConsumeMessage, Options } from 'amqplib';

export const describeError = (error: any): string =>
  error?.message ??
  error?.err?.message ??
  (typeof error === 'string' ? error : JSON.stringify(error));

const GROUP = 'EventsPublisher';
const REPLY_TO = 'amq.rabbitmq.reply-to'; // direct reply-to, no reply queue
const PUBLISH_HEADER = 'x-merkaly-publish'; // matches a basic.return with its publish

// No queue is bound to the key on that exchange: the broker returned the message (mandatory)
export class UnroutableMessageException extends ServiceUnavailableException {}

interface PendingInvoke {
  resolve: (reply: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  type: string;
}

interface Packet {
  pattern: string; // Nest RMQ packet: pattern = routing key = type
  data: MerkalyEvent;
  id?: string; // only on invokes, Nest replies to packets with id
}

@Injectable()
export class EventsPublisher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger: LoggerService;
  private brokerStatus: BrokerStatus;
  private connection: AmqpConnectionManager | null = null;
  private channel: ChannelWrapper | null = null;
  private readonly exchanges = new Map<string, Promise<void>>(); // destination exchanges asserted once
  private readonly returned = new Set<string>(); // publish ids the broker could not route
  private readonly pending = new Map<string, PendingInvoke>(); // invokes by correlation id

  constructor(
    @Inject(RABBIT_OPTIONS) private readonly options: RabbitModuleOptions,
    @Optional() logger?: LoggerService,
  ) {
    this.logger = logger ?? new LoggerService();
    this.brokerStatus = options.url ? 'connecting' : 'disabled';
  }

  public get status() {
    return this.brokerStatus;
  }

  // Own exchange, where emit() publishes
  public get exchange() {
    return exchangeName(this.options.service);
  }

  public onApplicationBootstrap() {
    if (!this.options.url) {
      return this.logger.warn({
        group: GROUP,
        message: 'RabbitMQ url is not set: publishing disabled, every emit will fail',
      });
    }

    this.attach(connect([this.options.url]));
  }

  public async onApplicationShutdown() {
    this.pending.forEach((pending, id) =>
      this.settle(id, new ServiceUnavailableException(`${pending.type} aborted: shutting down`)),
    );

    await this.channel?.close();

    return this.connection?.close();
  }

  // Event: a fact of this service, on its own exchange merkaly.<service>
  public emit<T>(type: string, data: T, meta?: MerkalyEventMeta): Promise<MerkalyEvent<T>> {
    return this.send(this.options.service, type, data, meta);
  }

  // Command: an order for `service` (no reply), on its exchange merkaly.<service>
  public command<T>(
    service: string,
    type: string,
    data: T,
    meta?: MerkalyEventMeta,
  ): Promise<MerkalyEvent<T>> {
    return this.send(service, type, data, meta);
  }

  // Invoke: request-reply with `service`; resolves with the handler's return value
  public invoke<TReq, TRes>(
    service: string,
    type: string,
    data: TReq,
    { timeout: ms = DEFAULT_INVOKE_TIMEOUT, ...meta }: MerkalyInvokeOptions = {},
  ): Promise<TRes> {
    return Promise.resolve().then(() => {
      const exchange = exchangeName(service);
      const invoke: MerkalyInvoke<TReq> = {
        ...createMerkalyEvent(this.options.service, assertMessageType(type), data, meta),
        expiresAt: new Date(Date.now() + ms).toISOString(), // the consumer drops it after this
      };
      const correlationId = randomUUID();
      const started = Date.now();
      const line = `${type} (${invoke.id}) => ${exchange}`;

      const reply = new Promise<TRes>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            this.settle(
              correlationId,
              new GatewayTimeoutException(`${type} not answered in ${ms}ms`),
            ),
          ms,
        );

        this.pending.set(correlationId, { resolve, reject, timer, type });
      });

      this.publish(
        exchange,
        { pattern: type, data: invoke, id: correlationId },
        {
          replyTo: REPLY_TO,
          correlationId,
          messageId: invoke.id,
          expiration: String(ms), // the broker drops it too
          persistent: false, // worthless after the timeout
        },
        ms,
      ).catch((error: Error) => this.settle(correlationId, error));

      return reply
        .then((answer) => {
          const took = `${Date.now() - started}ms`;

          if (!noteRequest(`=> ${type} ${took}`))
            this.logger.log({ group: GROUP, message: `${line} ${took}` });

          return answer;
        })
        .catch((error: unknown) => {
          this.logger.error({ group: GROUP, message: `${line} failed: ${describeError(error)}` });

          if (error instanceof HttpException) throw error;

          throw new ServiceUnavailableException(`${type} failed: ${describeError(error)}`); // caller decides the fallback
        });
    });
  }

  protected attach(connection: AmqpConnectionManager) {
    this.connection = connection;

    connection.on('connect', () => {
      this.brokerStatus = 'connected';
    });

    connection.on('disconnect', ({ err }) => {
      if (this.brokerStatus !== 'disconnected') {
        this.logger.error({ group: GROUP, message: `Broker disconnected: ${describeError(err)}` });
      }

      this.brokerStatus = 'disconnected';
    });

    connection.on('connectFailed', ({ err }) => {
      if (this.brokerStatus !== 'disconnected') {
        this.logger.error({ group: GROUP, message: `Broker unreachable: ${describeError(err)}` });
      }

      this.brokerStatus = 'disconnected';
    });

    this.channel = connection.createChannel({
      json: false,
      confirm: true,
      setup: (channel: ConfirmChannel) => this.setup(channel),
    });

    this.channel.on('error', (error: unknown) =>
      this.logger.error({ group: GROUP, message: `Channel setup failed: ${describeError(error)}` }),
    );

    this.exchanges.set(this.exchange, Promise.resolve()); // asserted by setup
  }

  // Runs on every (re)connection
  private async setup(channel: ConfirmChannel) {
    channel.on('return', (message: ConsumeMessage) => this.onReturn(message));

    await channel.assertExchange(this.exchange, 'topic', { durable: true });
    await channel.consume(REPLY_TO, (message) => this.onReply(message), { noAck: true });
  }

  private send<T>(
    service: string,
    type: string,
    data: T,
    meta?: MerkalyEventMeta,
  ): Promise<MerkalyEvent<T>> {
    return Promise.resolve().then(() => {
      const exchange = exchangeName(service);
      const event = createMerkalyEvent(this.options.service, assertMessageType(type), data, meta);
      const ms = this.options.timeout ?? DEFAULT_PUBLISH_TIMEOUT;
      const line = `${type} (${event.id}) -> ${exchange}`;

      return this.publish(
        exchange,
        { pattern: type, data: event },
        { messageId: event.id, persistent: true },
        ms,
      )
        .then(() => {
          if (!noteRequest(`-> ${type}`)) this.logger.log({ group: GROUP, message: line }); // own line outside a request

          return event;
        })
        .catch((error: unknown) => {
          this.logger.error({ group: GROUP, message: `${line} failed: ${describeError(error)}` });

          if (error instanceof HttpException) throw error;

          throw new ServiceUnavailableException(`Could not publish ${type}`); // caller decides retry
        });
    });
  }

  // Confirmed and mandatory: resolves once the broker took it and routed it to at least one queue
  private publish(exchange: string, packet: Packet, options: Options.Publish, ms: number) {
    const { channel, connection } = this;

    if (!channel || !connection) {
      return Promise.reject(new ServiceUnavailableException('Event broker is not configured'));
    }

    if (!connection.isConnected()) {
      return Promise.reject(new ServiceUnavailableException('Event broker is not connected')); // fail fast, never buffer
    }

    const publishId = randomUUID();
    const content = Buffer.from(JSON.stringify(packet));

    return this.assertExchange(channel, exchange, ms)
      .then(() =>
        channel.publish(exchange, packet.pattern, content, {
          ...options,
          contentType: 'application/json',
          mandatory: true,
          headers: { ...options.headers, [PUBLISH_HEADER]: publishId },
          timeout: ms, // rejects and drops it from the wrapper buffer
        }),
      )
      .then(() => {
        if (this.returned.has(publishId)) {
          throw new UnroutableMessageException(
            `${packet.pattern} is not routed: no queue is bound to it on ${exchange}`,
          );
        }
      })
      .finally(() => this.returned.delete(publishId));
  }

  // Commands and invokes go to another service's exchange: assert it once (same topic and durable args)
  private assertExchange(channel: ChannelWrapper, exchange: string, ms: number): Promise<void> {
    const known = this.exchanges.get(exchange);

    if (known) return known;

    const asserted = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`asserting ${exchange} timed out`)), ms);

      channel
        .addSetup((raw: ConfirmChannel) => raw.assertExchange(exchange, 'topic', { durable: true }))
        .then(() => resolve())
        .catch(reject)
        .finally(() => clearTimeout(timer));
    }).catch((error: unknown) => {
      this.exchanges.delete(exchange); // next publish tries again

      throw error;
    });

    this.exchanges.set(exchange, asserted);

    return asserted;
  }

  // basic.return arrives before the confirm of the same publish
  private onReturn(message: ConsumeMessage) {
    const id = message.properties.headers?.[PUBLISH_HEADER] as string | undefined;

    if (id) this.returned.add(id);
  }

  private onReply(message: ConsumeMessage | null) {
    const id = message?.properties.correlationId as string | undefined;
    const pending = id ? this.pending.get(id) : undefined;

    if (!message || !id || !pending) return; // late reply after the timeout

    let packet: { err?: unknown; response?: unknown };

    try {
      packet = JSON.parse(message.content.toString()) as typeof packet;
    } catch {
      return this.settle(
        id,
        new ServiceUnavailableException(`${pending.type} failed: unreadable reply`),
      );
    }

    if (packet.err) {
      return this.settle(
        id,
        new ServiceUnavailableException(`${pending.type} failed: ${describeError(packet.err)}`),
      );
    }

    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(packet.response);
  }

  private settle(id: string, error: Error) {
    const pending = this.pending.get(id);

    if (!pending) return;

    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }
}
