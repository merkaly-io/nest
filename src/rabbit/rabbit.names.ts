// Names are built from plain strings by convention and checked at boot: no enums, no catalog in the package

const SERVICE = /^[a-z][a-z0-9-]*$/; // api, webhooks, signals
const WORK = /^[a-z][a-z0-9-]*$/; // payments, identity, emails
const MESSAGE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/; // payment.confirmed, email.send

export const INVOKES_WORK = 'invokes'; // reserved: merkaly.<service>-invokes

export class RabbitNameError extends Error {}

export function assertServiceName(service: string): string {
  if (typeof service === 'string' && SERVICE.test(service)) return service;

  throw new RabbitNameError(
    `Invalid RabbitMQ service "${service}": lowercase letters, digits and dashes, starting with a letter (${SERVICE.source}), e.g. "api"`,
  );
}

export function assertWorkName(work: string): string {
  if (work === INVOKES_WORK) {
    throw new RabbitNameError(`Invalid RabbitMQ queue "${work}": reserved for @HandleInvoke`);
  }

  if (typeof work === 'string' && WORK.test(work)) return work;

  throw new RabbitNameError(
    `Invalid RabbitMQ queue "${work}": lowercase letters, digits and dashes, starting with a letter (${WORK.source}), e.g. "payments"`,
  );
}

export function assertMessageType(type: string): string {
  if (typeof type === 'string' && MESSAGE.test(type)) return type;

  throw new RabbitNameError(
    `Invalid message type "${type}": dotted lowercase segments, no wildcards (${MESSAGE.source}), e.g. "payment.confirmed"`,
  );
}

export const exchangeName = (service: string) => `merkaly.${assertServiceName(service)}`; // topic, durable

export const queueName = (service: string, work: string) =>
  `merkaly.${assertServiceName(service)}-${assertWorkName(work)}`;

export const invokesQueueName = (service: string) =>
  `merkaly.${assertServiceName(service)}-${INVOKES_WORK}`;

export const retryQueue = (queue: string) => `${queue}.retry`;

export const deadLetterQueue = (queue: string) => `${queue}.dlq`;
