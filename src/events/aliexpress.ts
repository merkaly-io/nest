// DS order status as AliExpress pushes it (message 53), for the supplier.order.* mappers
export const AliexpressOrderStatus = {
  CREATED: 'OrderCreated',
  PAYMENT_AUTHORIZED: 'PaymentAuthorized',
  PAYMENT_FAILED: 'paymentFailedEvent', // casing as sent by AliExpress
  SHIPPED: 'OrderShipped',
  CONFIRMED: 'OrderConfirmed',
  CLOSED: 'OrderClosed',
} as const;

export type AliexpressOrderStatus =
  (typeof AliexpressOrderStatus)[keyof typeof AliexpressOrderStatus];
