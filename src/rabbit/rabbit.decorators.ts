import { EventPattern, MessagePattern } from '@nestjs/microservices';
import {
  PATTERN_EXTRAS_METADATA,
  PATTERN_METADATA,
  TRANSPORT_METADATA,
} from '@nestjs/microservices/constants';
import { assertMessageType, assertServiceName, assertWorkName } from './rabbit.names';

export const MERKALY_EXTRAS = 'merkaly'; // key of the handler extras read by the queue servers

export interface MerkalyHandlerExtras {
  bindings: Record<string, string | null>; // message type -> source service, null = own service
}

// One transport id per queue: a server only sees the handlers of its own queue
export const queueTransport = (work: string) => Symbol.for(`merkaly.queue:${work}`);

export const INVOKES_TRANSPORT = Symbol.for('merkaly.invokes');

export interface HandleEventOptions {
  queue: string; // work name of the own queue (payments -> merkaly.<service>-payments)
  from?: string; // another owner's exchange (payments -> merkaly.payments); omitted = own exchange
}

export interface HandleCommandOptions {
  queue: string; // work name of the own queue, bound to the own exchange
}

type Types = string | readonly string[];

const readBindings = (fn: object): Record<string, string | null> =>
  (Reflect.getMetadata(PATTERN_EXTRAS_METADATA, fn) as Record<string, any> | undefined)?.[
    MERKALY_EXTRAS
  ]?.bindings ?? {};

// Stackable: every decorator adds its keys and source exchange to the same handler
function bindQueue(decorator: string, types: Types, queue: string, from: string | null) {
  const list = ([] as string[]).concat(types).map(assertMessageType);
  const transport = queueTransport(assertWorkName(queue));

  if (from !== null) assertServiceName(from);
  if (!list.length) throw new Error(`@${decorator} needs at least one message type`);

  return (target: object, key: string | symbol, descriptor: PropertyDescriptor) => {
    const fn = descriptor.value as object;
    const where = `@${decorator} on ${target.constructor.name}.${String(key)}`;
    const previous = (Reflect.getMetadata(PATTERN_METADATA, fn) as string[] | undefined) ?? [];
    const bindings = { ...readBindings(fn) };

    if (previous.length && Reflect.getMetadata(TRANSPORT_METADATA, fn) !== transport) {
      throw new Error(
        `${where}: one handler serves one queue, "${queue}" differs from the other decorator`,
      );
    }

    list.forEach((type) => {
      if (type in bindings) throw new Error(`${where}: "${type}" is bound twice`);

      bindings[type] = from;
    });

    const extras = { [MERKALY_EXTRAS]: { bindings } satisfies MerkalyHandlerExtras };

    return EventPattern([...previous, ...list], transport, extras)(target, key, descriptor);
  };
}

// Reacts to a fact on merkaly.<from> (own exchange without from), emitted or delivered; exact keys only
export const HandleEvent = (types: Types, { queue, from }: HandleEventOptions) =>
  bindQueue('HandleEvent', types, queue, from ?? null);

// Runs an order sent to this service with publisher.command(): bound to the own exchange
export const HandleCommand = (types: Types, { queue }: HandleCommandOptions) =>
  bindQueue('HandleCommand', types, queue, null);

// Answers publisher.invoke() on merkaly.<service>-invokes: the return value is the reply
export const HandleInvoke = (type: string) => {
  const extras = { [MERKALY_EXTRAS]: { bindings: { [assertMessageType(type)]: null } } };

  return (target: object, key: string | symbol, descriptor: PropertyDescriptor) => {
    if (Reflect.getMetadata(PATTERN_METADATA, descriptor.value as object)) {
      throw new Error(
        `@HandleInvoke on ${target.constructor.name}.${String(key)}: one type per handler`,
      );
    }

    return MessagePattern(type, INVOKES_TRANSPORT, extras)(target, key, descriptor);
  };
};
