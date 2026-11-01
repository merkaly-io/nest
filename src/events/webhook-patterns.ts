export const WebhookPatterns = {
  asaas: {
    PAYMENT_CREATED: 'asaas.payment_created',
    PAYMENT_AUTHORIZED: 'asaas.payment_authorized',
    PAYMENT_UPDATED: 'asaas.payment_updated',
    PAYMENT_CONFIRMED: 'asaas.payment_confirmed',
    PAYMENT_RECEIVED: 'asaas.payment_received',
    PAYMENT_OVERDUE: 'asaas.payment_overdue',
    PAYMENT_DELETED: 'asaas.payment_deleted',
    PAYMENT_REFUNDED: 'asaas.payment_refunded',
    PAYMENT_PARTIALLY_REFUNDED: 'asaas.payment_partially_refunded',
    PAYMENT_CHARGEBACK_REQUESTED: 'asaas.payment_chargeback_requested',
    PAYMENT_CHARGEBACK_DISPUTE: 'asaas.payment_chargeback_dispute',
    ACCOUNT_APPROVED: 'asaas.account_status_general_approval_approved', // subconta KYC
    ACCOUNT_REJECTED: 'asaas.account_status_general_approval_rejected',
  },
  stripe: {
    SUBSCRIPTION_CREATED: 'stripe.customer.subscription.created',
    SUBSCRIPTION_UPDATED: 'stripe.customer.subscription.updated',
    SUBSCRIPTION_DELETED: 'stripe.customer.subscription.deleted',
    INVOICE_PAID: 'stripe.invoice.paid',
    INVOICE_PAYMENT_FAILED: 'stripe.invoice.payment_failed',
  },
  auth0: {
    SUCCESS_SIGNUP: 'auth0.success_signup', // log code ss
    SUCCESS_LOGIN: 'auth0.success_login', // s
    FAILED_LOGIN: 'auth0.failed_login', // f
    USER_DELETED: 'auth0.user_deleted', // du
    BLOCKED_ACCOUNT: 'auth0.blocked_account', // limit_wc
    USER_LOGIN: 'auth0.user_login', // post-login Action
  },
  aliexpress: {
    DS_ORDER_STATUS_UPDATE: 'aliexpress.dropshipper_order_status_update', // message_type 53
    WAYBILL_CHANGED: 'aliexpress.waybill_changed', // 18
    PRODUCT_DELETED: 'aliexpress.product_deleted', // 15
  },
} as const;

export const AliexpressOrderStatus = {
  CREATED: 'OrderCreated',
  PAYMENT_AUTHORIZED: 'PaymentAuthorized',
  PAYMENT_FAILED: 'paymentFailedEvent', // casing as sent by AliExpress
  SHIPPED: 'OrderShipped',
  CONFIRMED: 'OrderConfirmed',
  CLOSED: 'OrderClosed',
} as const;

type Values<T> = T[keyof T];

export type WebhookPattern = Values<{
  [S in keyof typeof WebhookPatterns]: Values<(typeof WebhookPatterns)[S]>;
}>;

export type AliexpressOrderStatus = Values<typeof AliexpressOrderStatus>;
