import { ModuleMetadata } from '@nestjs/common';
import { MerkalyEvent, MerkalyEventMeta } from '../events';
import { LoggerService } from '../logger';
import { assertServiceName } from './rabbit.names';

export const RABBIT_OPTIONS = Symbol('RABBIT_OPTIONS');
export const CONSUMER_OPTIONS = Symbol('CONSUMER_OPTIONS');

export const DEFAULT_PUBLISH_TIMEOUT = 5000;
export const DEFAULT_INVOKE_TIMEOUT = 5000;
export const DEFAULT_RETRIES = 5;
export const DEFAULT_RETRY_DELAY = 30_000;
export const DEFAULT_PREFETCH = 10;
export const INVOKES_QUEUE_TTL = 30_000; // cap for any invoke left in the queue

export interface RabbitModuleOptions {
  url?: string; // broker url, unset = publishing disabled
  service: string; // short name (api): own exchange merkaly.<service> and producer of every message
  timeout?: number; // ms to wait for the broker confirm, default 5000
  required?: boolean; // fail boot when url is missing
}

export interface RabbitModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (...args: any[]) => RabbitModuleOptions | Promise<RabbitModuleOptions>;
  inject?: any[];
}

export interface RabbitQueueOptions {
  url: string;
  service: string; // owner, the queue is merkaly.<service>-<queue>
  queue: string; // work name (payments), same as in @HandleEvent / @HandleCommand
  prefetchCount?: number; // default 10
  retries?: number; // transient failures before the .dlq, default 5
  retryDelay?: number; // ms in the .retry queue, default 30s
  logger?: LoggerService;
}

export interface RabbitInvokesOptions {
  url: string;
  service: string; // owner, the queue is merkaly.<service>-invokes
  logger?: LoggerService;
}

export interface InboxEntry {
  queue: string; // merkaly.<service>-<work> that consumed it
  eventId: string; // MerkalyEvent.id
  type: string;
}

// Optional dedupe (ENG-112): the app stores what each queue already processed, the package stays storage free
export interface EventsInbox {
  has(entry: InboxEntry): Promise<boolean>; // true: ack and skip the handler
  add(entry: InboxEntry): Promise<unknown>; // after the handler succeeded, before the ack
}

export interface DeadLetter {
  queue?: string; // queue of origin, the message is now in <queue>.dlq
  type?: string;
  id?: string;
  reason: string;
}

export interface EventsConsumerOptions {
  around?: (event: MerkalyEvent, next: () => Promise<unknown>) => Promise<unknown>; // e.g. CLS per message
  inbox?: EventsInbox;
  onDeadLetter?: (letter: DeadLetter) => unknown; // alert hook, runs after the error log; its errors are logged
}

export interface EventsConsumerAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (...args: any[]) => EventsConsumerOptions | Promise<EventsConsumerOptions>;
  inject?: any[];
}

export interface MerkalyInvokeOptions extends MerkalyEventMeta {
  timeout?: number; // ms to wait for the reply, default 5000
}

export type BrokerStatus = 'disabled' | 'connecting' | 'connected' | 'disconnected';

// Fails boot with a clear error instead of publishing to a wrong exchange
export function checkRabbitOptions(options: RabbitModuleOptions): RabbitModuleOptions {
  assertServiceName(options?.service);

  if (!options.url && options.required) throw new Error('RabbitMQ url is required');

  return options;
}
