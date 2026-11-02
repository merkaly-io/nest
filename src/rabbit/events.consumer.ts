import { Inject, Injectable, Optional } from '@nestjs/common';
import { RmqContext } from '@nestjs/microservices';
import { MerkalyEvent, MerkalyEventType } from '../events';
import { LoggerService, requestContext } from '../logger';
import { describeError } from './events.publisher';
import { deadLetterQueue, retryQueue } from './rabbit.consumer';
import { CONSUMER_OPTIONS, DEFAULT_RETRIES, EventsConsumerOptions } from './rabbit.options';

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

  // Runs the handler and settles the message: ack, .retry or .dlq
  public handle<K extends MerkalyEventType>(
    event: MerkalyEvent<K>,
    context: RmqContext,
    handler: (event: MerkalyEvent<K>) => Promise<unknown>,
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

  private ack(context: RmqContext) {
    context.getChannelRef().ack(context.getMessage());
  }

  // Main queue dead-letters to the .dlq on nack without requeue
  private deadLetter(context: RmqContext, message: string, trace?: unknown) {
    context.getChannelRef().nack(context.getMessage(), false, false);
    this.logger.error({
      group: GROUP,
      message: `${message} -> ${deadLetterQueue(this.options.queue)}`,
      trace,
    });
  }

  private retry(context: RmqContext, message: string, trace: unknown) {
    const msg = context.getMessage();
    const attempt = Number(msg.properties.headers?.[RETRIES_HEADER] ?? 0) + 1;
    const max = this.options.retries ?? DEFAULT_RETRIES;

    if (attempt > max) return this.deadLetter(context, `${message}, ${max} retries`, trace);

    const channel = context.getChannelRef();

    channel.sendToQueue(retryQueue(this.options.queue), msg.content, {
      ...msg.properties,
      headers: { ...msg.properties.headers, [RETRIES_HEADER]: attempt },
      persistent: true,
    });
    channel.ack(msg);
    this.logger.error({ group: GROUP, message: `${message}, retry ${attempt}/${max}`, trace });
  }
}
