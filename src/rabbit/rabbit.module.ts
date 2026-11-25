import { DynamicModule, Global, Module } from '@nestjs/common';
import { EventsConsumer } from './events.consumer';
import { EventsPublisher } from './events.publisher';
import {
  CONSUMER_OPTIONS,
  EventsConsumerAsyncOptions,
  EventsConsumerOptions,
  RABBIT_OPTIONS,
  RabbitModuleAsyncOptions,
  RabbitModuleOptions,
  checkRabbitOptions,
} from './rabbit.options';

@Global()
@Module({})
export class RabbitModule {
  // Publisher of this service: emit() to merkaly.<service>, command()/invoke() to merkaly.<target>
  static forRoot(options: RabbitModuleOptions): DynamicModule {
    return {
      module: RabbitModule,
      providers: [
        { provide: RABBIT_OPTIONS, useFactory: () => checkRabbitOptions(options) },
        EventsPublisher,
      ],
      exports: [EventsPublisher],
    };
  }

  static forRootAsync(options: RabbitModuleAsyncOptions): DynamicModule {
    return {
      module: RabbitModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: RABBIT_OPTIONS,
          useFactory: async (...args: unknown[]) =>
            checkRabbitOptions(await options.useFactory(...args)),
          inject: options.inject ?? [],
        },
        EventsPublisher,
      ],
      exports: [EventsPublisher],
    };
  }

  // EventsConsumer.handle for the handlers of every rabbitQueue() server of the app
  static forConsumer(options: EventsConsumerOptions = {}): DynamicModule {
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
