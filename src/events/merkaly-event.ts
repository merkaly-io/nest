import { randomUUID } from 'crypto';

// Business event names are plain strings, `<domain>.<entity>.<fact>` (payment.received): the value is the routing key

export enum MerkalyProducer {
  WEBHOOKS = 'webhooks.merkaly.io',
  API = 'api.merkaly.io',
  PAYMENTS = 'payments.merkaly.io',
}

export type MerkalyEventSource = 'asaas' | 'stripe' | 'auth0' | 'aliexpress';

export type PaymentProvider = 'asaas';

export type PaymentMethod = 'PIX' | 'CARD' | 'BOLETO';

export interface PaymentRef {
  provider: PaymentProvider;
  paymentId: string; // provider id, pay_... in Asaas
  saleId: string | null; // from the <orgId>:<saleId> reference
  method: PaymentMethod;
  amount: number; // cents
  netAmount: number | null; // cents, after the provider fee
  providerEvent?: string; // provider event name, PAYMENT_RECEIVED
  providerStatus?: string; // provider payment status, RECEIVED
  walletId?: string | null; // merchant subconta wallet, from the split
  externalReference?: string | null; // untouched, <orgId>:<saleId>
}

export type PaymentAccountSection =
  'general' | 'commercialInfo' | 'documentation' | 'bankAccountInfo';

export type PaymentAccountStatus =
  'PENDING' | 'AWAITING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'EXPIRING_SOON' | 'EXPIRED';

export interface PaymentAccountRef {
  provider: PaymentProvider;
  accountId: string; // merchant subconta
}

export interface SignupCompany {
  name: string;
  email?: string; // company contact, may differ from the user's
}

export interface IdentitySignupRequested {
  user: string; // Auth0 user id, auth0|...
  email: string; // the user's email
  company: SignupCompany;
}

export type SupplierProvider = 'aliexpress';

export interface SupplierProductUpdated {
  provider: SupplierProvider;
  externalProductId: string; // AliExpress item_id, string: ids exceed 2^53
  country?: string; // country_code, e.g. US
  event?: string; // update_event as sent, OUT_OF_STOCK (others undocumented)
  occurredAt?: string; // ISO, from event_time_stamps
}

export type SupplierOrderStatus =
  'AWAITING_PAYMENT' | 'PAID' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';

export interface SupplierOrderStatusChanged {
  provider: SupplierProvider;
  sellerId: string; // AliExpress seller_id of the merchant account, the api resolves the organization
  externalOrderId: string; // DS order id, string: ids exceed 2^53
  reference: string | null; // our out_order_id, only if AliExpress sends it
  providerStatus: string; // orderStatus as sent, AliexpressOrderStatus
  status?: SupplierOrderStatus; // coarse hint, omitted when ambiguous (OrderClosed)
}

export interface MerkalyRawEvent {
  type: string; // provider event type, untouched
  payload?: unknown; // audit only, consumers never read it
  truncated?: boolean; // payload dropped for size
}

export interface MerkalyEvent<T = unknown> {
  id: string; // idempotency key, `<source>:<provider id>` or a UUID
  type: string; // payment.received, supplier.order.status_changed...
  version: number; // contract version of `data` for this type
  producer: MerkalyProducer;
  source?: MerkalyEventSource;
  organization?: string; // Auth0 org id
  occurredAt: string; // ISO, when it happened at the provider
  publishedAt: string; // ISO
  correlationId?: string;
  data: T; // shape agreed per type, see docs/events.md
  raw?: MerkalyRawEvent;
}

// Request-reply over merkaly.requests: same envelope plus the moment the caller stops waiting
export interface MerkalyRequest<T = unknown> extends MerkalyEvent<T> {
  expiresAt: string; // ISO, after it the consumer drops the request unanswered
}

export interface MerkalyEventMeta {
  id?: string; // default: random UUID
  version?: number; // default 1
  source?: MerkalyEventSource;
  organization?: string;
  occurredAt?: string; // default: publishedAt
  correlationId?: string;
  raw?: MerkalyRawEvent;
}

export const RAW_PAYLOAD_LIMIT = 16 * 1024; // bytes of serialized payload

// Sanitizing raw.payload is the producer's job; this only enforces the size cap
function capRaw(raw?: MerkalyRawEvent): MerkalyRawEvent | undefined {
  if (!raw?.payload) return raw;

  const size = Buffer.byteLength(JSON.stringify(raw.payload) ?? '');

  return size > RAW_PAYLOAD_LIMIT ? { type: raw.type, truncated: true } : raw;
}

export function createMerkalyEvent<T>(
  producer: MerkalyProducer,
  type: string,
  data: T,
  meta: MerkalyEventMeta = {},
): MerkalyEvent<T> {
  const publishedAt = new Date().toISOString();

  return {
    id: meta.id ?? randomUUID(),
    type,
    version: meta.version ?? 1,
    producer,
    source: meta.source,
    organization: meta.organization || undefined, // never an empty string
    occurredAt: meta.occurredAt ?? publishedAt,
    publishedAt,
    correlationId: meta.correlationId,
    data,
    raw: capRaw(meta.raw),
  };
}
