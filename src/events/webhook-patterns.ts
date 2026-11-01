export const WebhookPatterns = {
  asaas: {
    PAYMENT_CREATED: 'asaas.payment_created',
    PAYMENT_UPDATED: 'asaas.payment_updated',
    PAYMENT_CONFIRMED: 'asaas.payment_confirmed',
    PAYMENT_RECEIVED: 'asaas.payment_received',
    PAYMENT_OVERDUE: 'asaas.payment_overdue',
    PAYMENT_DELETED: 'asaas.payment_deleted',
    PAYMENT_REFUNDED: 'asaas.payment_refunded',
    PAYMENT_CHARGEBACK_REQUESTED: 'asaas.payment_chargeback_requested',
  },
  stripe: {
    SUBSCRIPTION_CREATED: 'stripe.customer.subscription.created',
    SUBSCRIPTION_UPDATED: 'stripe.customer.subscription.updated',
    SUBSCRIPTION_DELETED: 'stripe.customer.subscription.deleted',
    INVOICE_PAID: 'stripe.invoice.paid',
    INVOICE_PAYMENT_FAILED: 'stripe.invoice.payment_failed',
  },
  auth0: {
    USER_CREATED: 'auth0.user.created',
    USER_UPDATED: 'auth0.user.updated',
    USER_DELETED: 'auth0.user.deleted',
  },
  aliexpress: {
    ORDER_STATUS_CHANGED: 'aliexpress.order_status_changed', // provisional: map from the DS push type
  },
} as const;

type Values<T> = T[keyof T];

export type WebhookPattern = Values<{
  [S in keyof typeof WebhookPatterns]: Values<(typeof WebhookPatterns)[S]>;
}>;
