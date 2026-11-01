import { ModuleMetadata } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

export const RABBIT_OPTIONS = Symbol('RABBIT_OPTIONS');
export const RABBIT_CLIENT_FACTORY = Symbol('RABBIT_CLIENT_FACTORY');

export interface RabbitModuleOptions {
  url?: string; // broker url, unset = publishing disabled
  queue: string; // default target queue
  routes?: Record<string, string>; // pattern -> queue overrides
  timeout?: number; // ms to wait for the broker ack, default 5000
  required?: boolean; // fail boot when url is missing
}

export interface RabbitModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (...args: any[]) => RabbitModuleOptions | Promise<RabbitModuleOptions>;
  inject?: any[];
}

export type RabbitClientFactory = (queue: string) => ClientProxy;

export type BrokerStatus = 'disabled' | 'connecting' | 'connected' | 'disconnected';

export const DEFAULT_PUBLISH_TIMEOUT = 5000;
