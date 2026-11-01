export type WebhookSource = 'asaas' | 'stripe' | 'auth0' | 'aliexpress';

export interface WebhookEvent<T = unknown> {
  id: string; // provider event id, consumers dedupe on it
  source: WebhookSource;
  type: string; // provider event type, untouched
  receivedAt: string; // ISO date
  organization?: string; // resolved org, when known
  data: T;
}

export function toPattern(source: WebhookSource, event: string) {
  return `${source}.${event.toLowerCase()}`; // e.g. asaas.payment_confirmed
}

export function createWebhookEvent<T>(event: Omit<WebhookEvent<T>, 'receivedAt'>): WebhookEvent<T> {
  return { ...event, receivedAt: new Date().toISOString() };
}
