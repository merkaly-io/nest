import { ModuleMetadata } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { MerkalyEvent, MerkalyProducer } from '../events';

export const RABBIT_OPTIONS = Symbol('RABBIT_OPTIONS');
export const RABBIT_CLIENT = Symbol('RABBIT_CLIENT');
export const CONSUMER_OPTIONS = Symbol('CONSUMER_OPTIONS');

export const MERKALY_EXCHANGE = 'merkaly.events'; // topic, routing key = event type
export const DEFAULT_PUBLISH_TIMEOUT = 5000;
export const DEFAULT_RETRIES = 5;
export const DEFAULT_RETRY_DELAY = 30_000;

export interface RabbitModuleOptions {
  url?: string; // broker url, unset = publishing disabled
  producer: MerkalyProducer; // this service, stamped on every event
  exchange?: string; // default merkaly.events
  timeout?: number; // ms to wait for the broker, default 5000
  required?: boolean; // fail boot when url is missing
}

export interface RabbitModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (...args: any[]) => RabbitModuleOptions | Promise<RabbitModuleOptions>;
  inject?: any[];
}

export interface RabbitConsumerOptions {
  url: string;
  queue: string; // owned by the consumer, named after its repo (api.merkaly.io)
  exchange?: string; // default merkaly.events
  prefetchCount?: number; // default 10
  retries?: number; // transient failures before the .dlq, default 5
  retryDelay?: number; // ms in the .retry queue, default 30s
}

export interface EventsConsumerOptions extends Pick<RabbitConsumerOptions, 'queue' | 'retries'> {
  around?: (event: MerkalyEvent, next: () => Promise<unknown>) => Promise<unknown>; // e.g. CLS per message
}

export interface EventsConsumerAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (...args: any[]) => EventsConsumerOptions | Promise<EventsConsumerOptions>;
  inject?: any[];
}

export type RabbitClient = ClientProxy;

export type BrokerStatus = 'disabled' | 'connecting' | 'connected' | 'disconnected';
