import { EventPattern, RmqContext, RmqOptions, Transport } from '@nestjs/microservices';
import { WebhookPattern } from '../events';

export interface RabbitConsumerOptions {
  url: string;
  queue: string; // queue this service consumes
  prefetchCount?: number; // default 10
}

export function rabbitConsumerOptions(options: RabbitConsumerOptions): RmqOptions {
  return {
    transport: Transport.RMQ,
    options: {
      urls: [options.url],
      queue: options.queue,
      queueOptions: { durable: true },
      noAck: false, // handlers ack explicitly via ackMessage()
      prefetchCount: options.prefetchCount ?? 10,
    },
  };
}

export const OnRabbitEvent = (pattern: WebhookPattern | (string & {})) =>
  EventPattern(pattern, Transport.RMQ);

export function ackMessage(context: RmqContext) {
  const channel = context.getChannelRef();

  channel.ack(context.getMessage());
}

export function nackMessage(context: RmqContext, requeue = false) {
  const channel = context.getChannelRef();

  channel.nack(context.getMessage(), false, requeue); // requeue=false drops (or dead-letters)
}
