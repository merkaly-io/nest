import { DynamicModule, Global, Module, Provider } from '@nestjs/common';
import { ClientProxyFactory, Transport } from '@nestjs/microservices';
import { EventsConsumer } from './events.consumer';
import { EventsPublisher } from './events.publisher';
import {
  CONSUMER_OPTIONS,
  EventsConsumerAsyncOptions,
  EventsConsumerOptions,
  MERKALY_EXCHANGE,
  RABBIT_CLIENT,
  RABBIT_OPTIONS,
  RabbitClient,
  RabbitModuleAsyncOptions,
  RabbitModuleOptions,
} from './rabbit.options';

// Publishes to the exchange only: the producer never names a queue
export function createRabbitClient(options: RabbitModuleOptions): RabbitClient | null {
  if (!options.url) {
    if (options.required) throw new Error('RabbitMQ url is required'); // fail boot loudly

    return null;
  }

  return ClientProxyFactory.create({
    transport: Transport.RMQ,
    options: {
      urls: [options.url],
      exchange: options.exchange ?? MERKALY_EXCHANGE,
      exchangeType: 'topic',
      wildcards: true, // publish(exchange, pattern) instead of sendToQueue
      persistent: true,
    },
  });
}

const clientProvider: Provider = {
  provide: RABBIT_CLIENT,
  useFactory: createRabbitClient,
  inject: [RABBIT_OPTIONS],
};

@Global()
@Module({})
export class RabbitModule {
  static forRoot(options: RabbitModuleOptions): DynamicModule {
    return {
      module: RabbitModule,
      providers: [{ provide: RABBIT_OPTIONS, useValue: options }, clientProvider, EventsPublisher],
      exports: [EventsPublisher],
    };
  }

  static forRootAsync(options: RabbitModuleAsyncOptions): DynamicModule {
    return {
      module: RabbitModule,
      imports: options.imports ?? [],
      providers: [
        { provide: RABBIT_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] },
        clientProvider,
        EventsPublisher,
      ],
      exports: [EventsPublisher],
    };
  }

  static forConsumer(options: EventsConsumerOptions): DynamicModule {
    return {
      module: RabbitModule,
      providers: [{ provide: CONSUMER_OPTIONS, useValue: options }, EventsConsumer],
      exports: [EventsConsumer],
    };
  }

  static forConsumerAsync(options: EventsConsumerAsyncOptions): DynamicModule {
    return {
      module: RabbitModule,
      imports: options.imports ?? [],
      providers: [
        { provide: CONSUMER_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] },
        EventsConsumer,
      ],
      exports: [EventsConsumer],
    };
  }
}
