import { EventPattern, RmqOptions, Transport } from '@nestjs/microservices';
import { connect } from 'amqplib';
import { MerkalyEventType } from '../events';
import { DEFAULT_RETRY_DELAY, MERKALY_EXCHANGE, RabbitConsumerOptions } from './rabbit.options';

const WEEK = 7 * 24 * 60 * 60 * 1000;

export const retryQueue = (queue: string) => `${queue}.retry`;

export const deadLetterQueue = (queue: string) => `${queue}.dlq`;

// The consumer owns its queue: declares it and binds it to every @OnMerkalyEvent type
export function rabbitConsumerOptions(options: RabbitConsumerOptions): RmqOptions {
  return {
    transport: Transport.RMQ,
    options: {
      urls: [options.url],
      queue: options.queue,
      exchange: options.exchange ?? MERKALY_EXCHANGE,
      exchangeType: 'topic',
      wildcards: true, // binds one routing key per handler
      noAck: false, // EventsConsumer acks
      prefetchCount: options.prefetchCount ?? 10,
      queueOptions: {
        durable: true,
        arguments: {
          'x-message-ttl': WEEK, // unconsumed for a week: to the .dlq
          'x-max-length': 10_000,
          'x-overflow': 'drop-head',
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': deadLetterQueue(options.queue),
        },
      },
    },
  };
}

// .dlq keeps what failed; .retry holds a message for retryDelay and hands it back to the queue
export async function assertConsumerTopology(options: RabbitConsumerOptions) {
  const connection = await connect(options.url);
  const channel = await connection.createChannel();

  await channel.assertQueue(deadLetterQueue(options.queue), { durable: true });
  await channel.assertQueue(retryQueue(options.queue), {
    durable: true,
    arguments: {
      'x-message-ttl': options.retryDelay ?? DEFAULT_RETRY_DELAY,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': options.queue,
    },
  });

  await channel.close();
  await connection.close();
}

// One handler can take several types (stacked @EventPattern would overwrite each other)
export const OnMerkalyEvent = (...types: MerkalyEventType[]) => EventPattern(types, Transport.RMQ);
