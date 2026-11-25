// DS order status as AliExpress pushes it (message 53), for the supplier.order.* mappers
export type AliexpressOrderStatus =
  | 'OrderCreated'
  | 'PaymentAuthorized'
  | 'paymentFailedEvent' // casing as sent by AliExpress
  | 'OrderShipped'
  | 'OrderConfirmed'
  | 'OrderClosed';
