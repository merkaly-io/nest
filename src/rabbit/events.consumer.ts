import { Inject, Injectable, Optional } from '@nestjs/common';
import { RmqContext } from '@nestjs/microservices';
import { MerkalyEvent } from '../events';
import { LoggerService, requestContext } from '../logger';
import { describeError } from './events.publisher';
import { deliveryOf } from './rabbit.delivery';
import { deadLetterQueue, retryQueue } from './rabbit.names';
import { CONSUMER_OPTIONS, EventsConsumerOptions } from './rabbit.options';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';

const GROUP = 'EVENT';
const RETRIES_HEADER = 'x-merkaly-retries';

// Business refusal (unknown sale, amount mismatch...): ack and log, retrying will not fix it
export class EventRejectedException extends Error {}

export interface HandleOptions {
  version?: number; // highest data version the handler knows, default 1
}

@Injectable()
export class EventsConsumer {
  private readonly logger: LoggerService;

  constructor(
    @Inject(CONSUMER_OPTIONS) private readonly options: EventsConsumerOptions,
    @Optional() logger?: LoggerService,
  ) {
    this.logger = logger ?? new LoggerService();
  }

  // Runs the handler and settles the message: ack, .retry or .dlq of the queue it came from
  public handle<T>(
    event: MerkalyEvent<T>,
    context: RmqContext,
    handler: (event: MerkalyEvent<T>) => Promise<unknown>,
    { version = 1 }: HandleOptions = {},
  ): Promise<void> {
    const started = Date.now();
    const scope = {
      origin: event?.producer ?? 'unknown', // who published it (the broker is only transport), like the HTTP origin
      scope: () => event?.organization,
    };
    const line = (text: string) =>
      `${event?.type} (${event?.id}) ${text} ${Date.now() - started}ms`;

    return requestContext.run(scope, async () => {
      if (!event?.id || !event?.type) return this.deadLetter(context, line('malformed'));

      if (event.version > version)
        return this.deadLetter(context, line(`unknown version ${event.version}`));

      const next = () => handler(event);
      const run = this.options.around ? () => this.options.around!(event, next) : next;

      return Promise.resolve()
        .then(run)
        .then(() => {
          this.ack(context);
          this.logger.log({ group: GROUP, message: line('ok') });
        })
        .catch((error: unknown) => {
          if (error instanceof EventRejectedException) {
            this.ack(context);

            return this.logger.warn({ group: GROUP, message: line(`rejected "${error.message}"`) });
          }

          return this.retry(context, line(`failed "${describeError(error)}"`), error);
        });
    });
  }

  private channel(context: RmqContext) {
    return context.getChannelRef() as ConfirmChannel; // amqp-connection-manager opens confirm channels
  }

  private ack(context: RmqContext) {
    this.channel(context).ack(context.getMessage() as ConsumeMessage);
  }

  // The queue dead-letters to its .dlq on nack without requeue
  private deadLetter(context: RmqContext, message: string, trace?: unknown) {
    const queue = deliveryOf(context.getMessage())?.queue;

    this.channel(context).nack(context.getMessage() as ConsumeMessage, false, false);
    this.logger.error({
      group: GROUP,
      message: `${message} -> ${queue ? deadLetterQueue(queue) : 'dead letter'}`,
      trace,
    });
  }

  // Acks the original only once the broker confirmed the copy in .retry (ENG-91); otherwise requeues it
  private retry(context: RmqContext, message: string, trace: unknown): Promise<void> {
    const msg = context.getMessage() as ConsumeMessage;
    const delivery = deliveryOf(msg);

    if (!delivery) {
      this.deadLetter(context, `${message}, not consumed by a rabbitQueue() server`, trace);

      return Promise.resolve();
    }

    const attempt = Number(msg.properties.headers?.[RETRIES_HEADER] ?? 0) + 1;
    const max = delivery.retries;

    if (attempt > max) {
      this.deadLetter(context, `${message}, ${max} retries`, trace);

      return Promise.resolve();
    }

    const channel = this.channel(context);
    const target = retryQueue(delivery.queue);
    const copy = new Promise<void>((resolve, reject) => {
      channel.sendToQueue(
        target,
        msg.content,
        {
          ...msg.properties,
          headers: { ...msg.properties.headers, [RETRIES_HEADER]: attempt },
          persistent: true,
        },
        (error: unknown) => (error ? reject(new Error(describeError(error))) : resolve()),
      );
    });

    return copy
      .then(() => {
        channel.ack(msg);
        this.logger.error({ group: GROUP, message: `${message}, retry ${attempt}/${max}`, trace });
      })
      .catch((error: unknown) => {
        this.logger.error({
          group: GROUP,
          message: `${message}, ${target} not confirmed "${describeError(error)}": requeued`,
          trace,
        });

        return Promise.resolve()
          .then(() => channel.nack(msg, false, true))
          .catch(() => undefined); // channel gone: the broker redelivers it anyway
      });
  }
}
