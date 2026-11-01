import { DynamicModule, Global, Module, Provider } from '@nestjs/common';
import { ClientProxyFactory, Transport } from '@nestjs/microservices';
import { EventsPublisher } from './events.publisher';
import {
  RABBIT_CLIENT_FACTORY,
  RABBIT_OPTIONS,
  RabbitClientFactory,
  RabbitModuleAsyncOptions,
  RabbitModuleOptions,
} from './rabbit.options';

export function createRabbitClientFactory(
  options: RabbitModuleOptions,
): RabbitClientFactory | null {
  const { url } = options;

  if (!url) {
    if (options.required) throw new Error('RabbitMQ url is required'); // fail boot loudly

    return null;
  }

  return (queue) =>
    ClientProxyFactory.create({
      transport: Transport.RMQ,
      options: { urls: [url], queue, queueOptions: { durable: true }, persistent: true },
    });
}

const clientFactoryProvider: Provider = {
  provide: RABBIT_CLIENT_FACTORY,
  useFactory: createRabbitClientFactory,
  inject: [RABBIT_OPTIONS],
};

@Global()
@Module({})
export class RabbitModule {
  static forRoot(options: RabbitModuleOptions): DynamicModule {
    return {
      module: RabbitModule,
      providers: [
        { provide: RABBIT_OPTIONS, useValue: options },
        clientFactoryProvider,
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
        { provide: RABBIT_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] },
        clientFactoryProvider,
        EventsPublisher,
      ],
      exports: [EventsPublisher],
    };
  }
}
