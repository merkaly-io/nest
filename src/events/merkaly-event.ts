import { randomUUID } from 'crypto';

// Business event names, `<domain>.<entity>.<fact>`: the value is the routing key
export enum MerkalyEventType {
  PAYMENT_CONFIRMED = 'payment.confirmed',
  PAYMENT_RECEIVED = 'payment.received',
  PAYMENT_FAILED = 'payment.failed',
  PAYMENT_OVERDUE = 'payment.overdue',
  PAYMENT_CANCELLED = 'payment.cancelled',
  PAYMENT_REFUNDED = 'payment.refunded',
  PAYMENT_CHARGEBACK_OPENED = 'payment.chargeback.opened',
  PAYMENT_CHARGEBACK_UPDATED = 'payment.chargeback.updated',
  PAYMENT_ACCOUNT_APPROVED = 'payment.account.approved',
  PAYMENT_ACCOUNT_REJECTED = 'payment.account.rejected',
  PAYMENT_ACCOUNT_STATUS_CHANGED = 'payment.account.status_changed',
  IDENTITY_SIGNUP_REQUESTED = 'identity.signup.requested',
}

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

export interface EventDataMap {
  [MerkalyEventType.PAYMENT_CONFIRMED]: PaymentRef & { confirmedAt: string };
  [MerkalyEventType.PAYMENT_RECEIVED]: PaymentRef & { receivedAt: string };
  [MerkalyEventType.PAYMENT_FAILED]: PaymentRef & { reason: 'card_refused' | 'risk_rejected' };
  [MerkalyEventType.PAYMENT_OVERDUE]: PaymentRef & { dueDate: string };
  [MerkalyEventType.PAYMENT_CANCELLED]: PaymentRef;
  [MerkalyEventType.PAYMENT_REFUNDED]: PaymentRef & { refundedAmount: number; partial: boolean };
  [MerkalyEventType.PAYMENT_CHARGEBACK_OPENED]: PaymentRef & { reason: string | null };
  [MerkalyEventType.PAYMENT_CHARGEBACK_UPDATED]: PaymentRef & {
    stage: 'disputed' | 'awaiting_reversal';
  };
  [MerkalyEventType.PAYMENT_ACCOUNT_APPROVED]: PaymentAccountRef;
  [MerkalyEventType.PAYMENT_ACCOUNT_REJECTED]: PaymentAccountRef;
  [MerkalyEventType.PAYMENT_ACCOUNT_STATUS_CHANGED]: PaymentAccountRef & {
    section: PaymentAccountSection;
    status: PaymentAccountStatus;
  };
  [MerkalyEventType.IDENTITY_SIGNUP_REQUESTED]: IdentitySignupRequested; // when: occurredAt
}

export interface MerkalyRawEvent {
  type: string; // provider event type, untouched
  payload?: unknown; // audit only, consumers never read it
  truncated?: boolean; // payload dropped for size
}

export interface MerkalyEvent<K extends MerkalyEventType = MerkalyEventType> {
  id: string; // idempotency key, `<source>:<provider id>` or a UUID
  type: K;
  version: number; // contract version of `data` for this type
  producer: MerkalyProducer;
  source?: MerkalyEventSource;
  organization?: string; // Auth0 org id
  occurredAt: string; // ISO, when it happened at the provider
  publishedAt: string; // ISO
  correlationId?: string;
  data: EventDataMap[K];
  raw?: MerkalyRawEvent;
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

export function createMerkalyEvent<K extends MerkalyEventType>(
  producer: MerkalyProducer,
  type: K,
  data: EventDataMap[K],
  meta: MerkalyEventMeta = {},
): MerkalyEvent<K> {
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
