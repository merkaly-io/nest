import {
  GatewayTimeoutException,
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RmqRecord } from '@nestjs/microservices';
import { TimeoutError, lastValueFrom, timeout } from 'rxjs';
import { MerkalyEvent, MerkalyEventMeta, MerkalyRequest, createMerkalyEvent } from '../events';
import { LoggerService, noteRequest } from '../logger';
import {
  BrokerStatus,
  DEFAULT_PUBLISH_TIMEOUT,
  DEFAULT_REQUEST_TIMEOUT,
  MERKALY_EXCHANGE,
  MERKALY_REQUESTS_EXCHANGE,
  MerkalyRequestOptions,
  RABBIT_CLIENT,
  RABBIT_OPTIONS,
  RABBIT_REQUEST_CLIENT,
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
    @Optional() @Inject(RABBIT_REQUEST_CLIENT) private readonly requests?: RabbitClient | null,
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

    this.requests?.connect().catch(() => undefined); // warm, the first request() reports its own failure

    return this.client.connect().catch((error) => {
      this.brokerStatus = 'disconnected';
      this.logger.error({ group: GROUP, message: `Broker unreachable: ${describeError(error)}` });
    });
  }

  public async onApplicationShutdown() {
    await this.requests?.close();

    return this.client?.close();
  }

  // Resolves with the event once the broker took it; ServiceUnavailableException otherwise
  public emit<T>(type: string, data: T, meta?: MerkalyEventMeta): Promise<MerkalyEvent<T>> {
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
        if (!noteRequest(`-> ${type}`)) this.logger.log({ group: GROUP, message: line }); // own line outside a request

        return event;
      })
      .catch((error) => {
        this.logger.error({ group: GROUP, message: `${line} failed: ${describeError(error)}` });

        throw new ServiceUnavailableException(`Could not publish ${type}`); // caller decides retry
      });
  }

  // Request-reply on merkaly.requests: resolves with the handler's reply, rejects on timeout or error
  public request<TReq, TRes>(
    type: string,
    data: TReq,
    { timeout: ms = DEFAULT_REQUEST_TIMEOUT, ...meta }: MerkalyRequestOptions = {},
  ): Promise<TRes> {
    if (!this.requests) {
      return Promise.reject(new ServiceUnavailableException('Event broker is not configured'));
    }

    const request: MerkalyRequest<TReq> = {
      ...createMerkalyEvent(this.options.producer, type, data, meta),
      expiresAt: new Date(Date.now() + ms).toISOString(), // the consumer drops it after this
    };
    const record = new RmqRecord(request, { expiration: String(ms), persistent: false }); // broker drops it too
    const started = Date.now();
    const line = `${type} (${request.id}) -> ${MERKALY_REQUESTS_EXCHANGE}`;

    return lastValueFrom(this.requests.send<TRes>(type, record).pipe(timeout(ms)), {
      defaultValue: undefined as TRes,
    })
      .then((reply) => {
        const took = `${Date.now() - started}ms`;

        if (!noteRequest(`=> ${type} ${took}`))
          this.logger.log({ group: GROUP, message: `${line} ${took}` });

        return reply;
      })
      .catch((error: unknown) => {
        const expired = error instanceof TimeoutError;
        const reason = expired ? `no reply in ${ms}ms` : describeError(error);

        this.logger.error({ group: GROUP, message: `${line} failed: ${reason}` });

        if (expired) throw new GatewayTimeoutException(`${type} not answered in ${ms}ms`);

        throw new ServiceUnavailableException(`${type} failed: ${reason}`); // caller decides the fallback
      });
  }
}
