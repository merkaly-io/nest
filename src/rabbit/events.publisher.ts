import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom, timeout } from 'rxjs';
import { WebhookEvent, WebhookPattern } from '../events';
import { LoggerService } from '../logger';
import {
  BrokerStatus,
  DEFAULT_PUBLISH_TIMEOUT,
  RABBIT_CLIENT_FACTORY,
  RABBIT_OPTIONS,
  RabbitClientFactory,
  RabbitModuleOptions,
} from './rabbit.options';

const describe = (error: any): string =>
  error?.message ??
  error?.err?.message ??
  (typeof error === 'string' ? error : JSON.stringify(error));

@Injectable()
export class EventsPublisher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly clients = new Map<string, ClientProxy>();
  private readonly logger: LoggerService;
  private brokerStatus: BrokerStatus;

  constructor(
    @Inject(RABBIT_OPTIONS) private readonly options: RabbitModuleOptions,
    @Inject(RABBIT_CLIENT_FACTORY) private readonly factory: RabbitClientFactory | null,
    @Optional() logger?: LoggerService,
  ) {
    this.logger = logger ?? new LoggerService();
    this.brokerStatus = factory ? 'connecting' : 'disabled';
  }

  public get status() {
    return this.brokerStatus;
  }

  public onApplicationBootstrap() {
    if (!this.factory) {
      return this.logger.warn({
        group: EventsPublisher.name,
        message: 'RabbitMQ url is not set: publishing disabled, every publish will fail',
        type: 'event',
      });
    }

    const client = this.client(this.options.queue);

    client.status?.subscribe((status) => {
      this.brokerStatus = status === 'connected' ? 'connected' : 'disconnected';
    });

    return client.connect().catch((error) => {
      this.brokerStatus = 'disconnected';
      this.logger.error({
        group: EventsPublisher.name,
        message: `Broker unreachable: ${describe(error)}`,
        type: 'event',
      });
    });
  }

  public onApplicationShutdown() {
    return Promise.all([...this.clients.values()].map((client) => client.close()));
  }

  public publish<T>(
    pattern: WebhookPattern | (string & {}),
    event: WebhookEvent<T>,
  ): Promise<void> {
    if (!this.factory) {
      return Promise.reject(new ServiceUnavailableException('Event broker is not configured'));
    }

    const queue = this.options.routes?.[pattern] ?? this.options.queue;
    const ms = this.options.timeout ?? DEFAULT_PUBLISH_TIMEOUT;
    const emitted$ = this.client(queue).emit(pattern, event).pipe(timeout(ms));
    const log = { group: EventsPublisher.name, type: 'event' };

    return lastValueFrom(emitted$, { defaultValue: undefined })
      .then(() => this.logger.log({ ...log, message: `${pattern} (${event.id}) -> ${queue}` }))
      .catch((error) => {
        this.logger.error({
          ...log,
          message: `${pattern} (${event.id}) -> ${queue} failed: ${describe(error)}`,
        });

        throw new ServiceUnavailableException(`Could not publish ${pattern}`); // caller decides retry
      });
  }

  private client(queue: string): ClientProxy {
    if (!this.clients.has(queue)) this.clients.set(queue, this.factory!(queue));

    return this.clients.get(queue)!;
  }
}
