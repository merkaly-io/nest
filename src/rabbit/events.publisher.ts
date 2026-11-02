import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { lastValueFrom, timeout } from 'rxjs';
import {
  EventDataMap,
  MerkalyEvent,
  MerkalyEventMeta,
  MerkalyEventType,
  createMerkalyEvent,
} from '../events';
import { LoggerService } from '../logger';
import {
  BrokerStatus,
  DEFAULT_PUBLISH_TIMEOUT,
  MERKALY_EXCHANGE,
  RABBIT_CLIENT,
  RABBIT_OPTIONS,
  RabbitClient,
  RabbitModuleOptions,
} from './rabbit.options';

export const describeError = (error: any): string =>
  error?.message ??
  error?.err?.message ??
  (typeof error === 'string' ? error : JSON.stringify(error));

const GROUP = 'EventsPublisher';

@Injectable()
export class EventsPublisher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger: LoggerService;
  private brokerStatus: BrokerStatus;

  constructor(
    @Inject(RABBIT_OPTIONS) private readonly options: RabbitModuleOptions,
    @Inject(RABBIT_CLIENT) private readonly client: RabbitClient | null,
    @Optional() logger?: LoggerService,
  ) {
    this.logger = logger ?? new LoggerService();
    this.brokerStatus = client ? 'connecting' : 'disabled';
  }

  public get status() {
    return this.brokerStatus;
  }

  private get exchange() {
    return this.options.exchange ?? MERKALY_EXCHANGE;
  }

  public onApplicationBootstrap() {
    if (!this.client) {
      return this.logger.warn({
        group: GROUP,
        message: 'RabbitMQ url is not set: publishing disabled, every emit will fail',
      });
    }

    this.client.status?.subscribe((status) => {
      this.brokerStatus = status === 'connected' ? 'connected' : 'disconnected';
    });

    return this.client.connect().catch((error) => {
      this.brokerStatus = 'disconnected';
      this.logger.error({ group: GROUP, message: `Broker unreachable: ${describeError(error)}` });
    });
  }

  public onApplicationShutdown() {
    return this.client?.close();
  }

  // Resolves with the event once the broker took it; ServiceUnavailableException otherwise
  public emit<K extends MerkalyEventType>(
    type: K,
    data: EventDataMap[K],
    meta?: MerkalyEventMeta,
  ): Promise<MerkalyEvent<K>> {
    if (!this.client) {
      return Promise.reject(new ServiceUnavailableException('Event broker is not configured'));
    }

    const event = createMerkalyEvent(this.options.producer, type, data, meta);
    const ms = this.options.timeout ?? DEFAULT_PUBLISH_TIMEOUT;
    const line = `${type} (${event.id}) -> ${this.exchange}`;

    return lastValueFrom(this.client.emit(type, event).pipe(timeout(ms)), {
      defaultValue: undefined,
    })
      .then(() => {
        this.logger.log({ group: GROUP, message: line });

        return event;
      })
      .catch((error) => {
        this.logger.error({ group: GROUP, message: `${line} failed: ${describeError(error)}` });

        throw new ServiceUnavailableException(`Could not publish ${type}`); // caller decides retry
      });
  }
}
