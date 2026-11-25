// Queue of origin of each delivery, set by the queue server that consumed it (internal, not exported)

export interface QueueDelivery {
  queue: string; // merkaly.<service>-<work>
  retries: number; // max transient failures before the .dlq
}

const deliveries = new WeakMap<object, QueueDelivery>();

export const rememberDelivery = (message: object, delivery: QueueDelivery) =>
  deliveries.set(message, delivery);

export const deliveryOf = (message: object): QueueDelivery | undefined => deliveries.get(message);
