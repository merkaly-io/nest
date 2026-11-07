# Contrato de eventos entre servicios

Estado: **aprobado por el Founder; tipos de pagos y subconta implementados en `@merkaly/nest` 0.2.0 (campos de diagnóstico de `PaymentRef` en 0.2.9)** (exchange decidido el 2026-11-02). El resto del catálogo entra por proveedor.

Antes, `webhooks.merkaly.io` publicaba en `api.merkaly.io-queue` el evento crudo de cada proveedor
(`asaas.payment_received`, `stripe.invoice.paid`...) con el sobre `WebhookEvent`, que en 0.2.0 se
quitó. Ahora publica eventos normalizados en el exchange `merkaly.events`.

Principios:

- **Eventos de negocio normalizados**; el evento original del proveedor viaja adentro solo para
  auditoría.
- Los tipos son **strings** (`payment.received`); el catálogo de este documento es la referencia. Desde 0.3.0 no hay enum ni mapa de tipos en el paquete.
- El sobre dice **qué app lo produjo**.
- `data` es un **contrato acordado** por tipo de evento (interfaces opcionales como `PaymentRef`).

## 1. Por qué el contrato vive en `@merkaly/nest`

`@merkaly/nest` ya es la dependencia común de los backends (api, webhooks, payments) y ya exporta
`RabbitModule`, `EventsPublisher` y `EventsConsumer`. El paquete define el sobre (`MerkalyEvent<T>`)
y algunas interfaces de `data` reutilizables (`PaymentRef`, `SupplierOrderStatusChanged`...); el
`type` es un string libre.

Hasta 0.2.x había un enum `MerkalyEventType` y un `EventDataMap` que tipaban `data` por tipo. Se
quitaron en 0.3.0 (decisión del Founder, 2026-11-07): obligaban a publicar el paquete por cada
evento nuevo y no evitaban errores reales. Un evento nuevo ya no toca el paquete: el productor
emite el string y el consumidor lo escucha, documentándolo en el catálogo.

| Alternativa | Por qué no |
| --- | --- |
| Copiar los tipos en cada servicio | Se desalinean. Ya pasó: los patrones están duplicados en `webhooks` (`asaas.events.ts`, `aliexpress.topics.ts`, `auth0.types.ts`) y en `nest` (`webhook-patterns.ts`). |
| Registro de JSON Schema (o AsyncAPI) | Demasiado para 2 o 3 servicios TypeScript del mismo equipo. Se puede generar después desde los tipos si entra un consumidor en otro lenguaje. |
| `@merkaly/api` | Son los contratos HTTP que el api genera para admin y store. Frontera equivocada: los frontends no deben ver eventos internos y el api sería dueño de un contrato que produce otro servicio. |

## 2. Nombres

| Regla | Detalle |
| --- | --- |
| Forma | `<dominio>.<entidad>.<hecho>` o `<dominio>.<hecho>` cuando la entidad es el propio dominio. Segmentos separados por punto, en minúsculas, en inglés. |
| Hecho | En pasado; si necesita dos palabras, snake_case (`status_changed`, `signed_up`). |
| Patrón | El string del tipo es el patrón de Nest RMQ y la routing key. |

## 3. Sobre (envelope) y tipado

`type` es un string y `data` un genérico: el consumidor declara qué forma espera.

```ts
export interface MerkalyEvent<T = unknown> {
  id: string;
  type: string; // payment.confirmed
  version: number;
  producer: MerkalyProducer;
  source?: MerkalyEventSource;
  organization?: string;
  occurredAt: string;
  publishedAt: string;
  correlationId?: string;
  data: T;
  raw?: MerkalyRawEvent;
}

export interface MerkalyRawEvent {
  type: string; // tipo original del proveedor, sin tocar (PAYMENT_RECEIVED, invoice.paid, ss, 53)
  payload?: unknown; // unknown a propósito: solo auditoría y diagnóstico
  truncated?: boolean;
}

export enum MerkalyProducer {
  WEBHOOKS = 'webhooks.merkaly.io',
  API = 'api.merkaly.io',
  PAYMENTS = 'payments.merkaly.io',
}

export type MerkalyEventSource = 'asaas' | 'stripe' | 'auth0' | 'aliexpress';

// productor
publisher.emit('payment.confirmed', { ...ref, confirmedAt }, { organization, source: 'asaas', raw });

// consumidor
@OnMerkalyEvent('payment.confirmed')
handle(event: MerkalyEvent<PaymentRef & { confirmedAt: string }>) {
  event.data.paymentId; // string, por la forma que declara el handler
}
```

| Campo | Obligatorio | Regla |
| --- | --- | --- |
| `id` | sí | Clave de idempotencia; el consumidor deduplica por ella. Evento de proveedor: `<source>:<id del proveedor>` (`asaas:evt_...`, `stripe:evt_...`, `auth0:<log_id>`). AliExpress no manda id: `aliexpress:<sha256 del mensaje, 32 hex>`. Evento interno: UUID v4. Un evento de proveedor produce como máximo un evento normalizado; si algún día produce varios, se sufija `#<type>`. |
| `type` | sí | String del catálogo (`payment.confirmed`). |
| `version` | sí | Versión del contrato de `data` para ese `type`, entero desde 1. No es la versión del paquete. |
| `producer` | sí | Repo que publicó (`MerkalyProducer`). |
| `source` | no | Proveedor externo de origen. Ausente en eventos internos. |
| `organization` | según tipo | Id de organización de Auth0 (`org_...`). Ver columna "Org" del catálogo. Si el productor no la conoce, la omite (nunca string vacío). |
| `occurredAt` | sí | ISO 8601 UTC del hecho según el proveedor (Asaas `dateCreated`, Stripe `created`, Auth0 `date`, AliExpress `timestamp`). Si falta, igual a `publishedAt`. |
| `publishedAt` | sí | ISO 8601 UTC del momento de publicar. Reemplaza `receivedAt`. |
| `correlationId` | no | Id del request HTTP que originó el evento (el del logger); un evento derivado hereda el del padre. Sirve para seguir un flujo en los logs de varios servicios. |
| `data` | sí | Contrato acordado por tipo (catálogo). Montos en **centavos enteros**, fechas ISO, ids del proveedor como string (los de AliExpress superan 2^53). |
| `raw` | no | Opcional en **todos** los eventos. Solo auditoría y diagnóstico: **ningún consumidor lo lee**; si un dato hace falta, va a `data` (patch). Máximo **16 KB** serializado; si se pasa, `payload` se omite y `truncated: true`. Saneado antes de publicar. |

Saneado de `raw` (lista cerrada por proveedor, en el productor):

| Proveedor | Se quita |
| --- | --- |
| Asaas | datos del cliente, `creditCard` salvo marca y últimos 4, `pixQrCode`, urls de factura |
| Stripe | `customer_email`, `customer_name`, `customer_address`, `customer_phone`, métodos de pago |
| Auth0 | `ip`, `user_agent`, `details`, `location_info`, `hostname` |
| AliExpress | dirección, nombre, teléfono y CPF del destinatario si vinieran |

## 4. Catálogo

Productor de todos: `webhooks.merkaly.io`, al exchange `merkaly.events`. Consumidor hoy: cola `api.merkaly.io`. "Org":
**sí** = obligatoria (sin ella se responde 200 al proveedor, se loguea error y no se publica),
**no** = el productor no la conoce.

```ts
type PaymentMethod = 'PIX' | 'CARD' | 'BOLETO';

interface PaymentRef {
  provider: 'asaas';
  paymentId: string; // pay_... de Asaas
  saleId: string | null; // del externalReference <orgId>:<saleId>
  method: PaymentMethod;
  amount: number; // centavos (Asaas manda reais decimales)
  netAmount: number | null; // centavos, después de la tarifa
  providerEvent?: string; // evento de Asaas tal cual (PAYMENT_RECEIVED), desde 0.2.9
  providerStatus?: string; // payment.status de Asaas (RECEIVED, CONFIRMED...), desde 0.2.9
  walletId?: string | null; // wallet de la subconta, del split; null sin split, desde 0.2.9
  externalReference?: string | null; // externalReference sin tocar, desde 0.2.9
}
```

Los cuatro campos de 0.2.9 son opcionales (patch): sirven para logs, diagnóstico y para no leer
`raw`. El api no decide con ellos: relee el pago en Asaas (el evento es un disparador).

### Pagos del store (Asaas, `/asaas`)

Un solo webhook en la cuenta principal (split 100%): la organización sale del `externalReference` (`<orgId>:<saleId>`). Con `paymentId` el api lee el pago en Asaas y aplica
`OrderSalePaymentService.apply()` (el mismo del polling), que confirma vía
`OrderSaleService.confirmPayment` solo si el monto es exacto y la venta sigue `OPEN`. El evento es
un **disparador**, no la fuente de verdad.

| Tipo | Org | `data` | Eventos Asaas | Qué haría el api |
| --- | --- | --- | --- | --- |
| `payment.confirmed` | sí | `PaymentRef & { confirmedAt: string }` | `PAYMENT_CONFIRMED` | Releer y `apply()`: venta pagada. |
| `payment.received` | sí | `PaymentRef & { receivedAt: string }` | `PAYMENT_RECEIVED` | Igual que `confirmed` (Pix llega directo acá, sin `CONFIRMED`); en tarjeta es el dinero liberado, idempotente. Evento separado para ver cuándo se libera el dinero. |
| `payment.failed` | sí | `PaymentRef & { reason: 'card_refused' \| 'risk_rejected' }` | `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED`, `PAYMENT_REPROVED_BY_RISK_ANALYSIS` | Marcar el intento REJECTED; el comprador reintenta. |
| `payment.overdue` | sí | `PaymentRef & { dueDate: string }` | `PAYMENT_OVERDUE` | Informativo: el api ya vence el Pix a los 30 min con su propia ventana. |
| `payment.cancelled` | sí | `PaymentRef` | `PAYMENT_DELETED` | Ignorar si no es el intento actual (el api borra los Pix que reemplaza). |
| `payment.refunded` | sí | `PaymentRef & { refundedAmount: number; partial: boolean }` | `PAYMENT_REFUNDED`, `PAYMENT_PARTIALLY_REFUNDED` | Gateway REFUNDED y **alerta** al comerciante. No cambia el estado del pago a mano: el pago se deriva del pedido. |
| `payment.chargeback.opened` | sí | `PaymentRef & { reason: string \| null }` | `PAYMENT_CHARGEBACK_REQUESTED` | Alerta en el pedido (cae en la subconta del comerciante). |
| `payment.chargeback.updated` | sí | `PaymentRef & { stage: 'disputed' \| 'awaiting_reversal' }` | `PAYMENT_CHARGEBACK_DISPUTE`, `PAYMENT_AWAITING_CHARGEBACK_REVERSAL` | Actualizar la alerta. |

### Subconta del comerciante (Asaas, KYC)

| Tipo | Org | `data` | Eventos Asaas | Qué haría el api |
| --- | --- | --- | --- | --- |
| `payment.account.approved` | sí | `{ provider: 'asaas'; accountId: string }` | `ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED` | Guardar `approval.general = APPROVED` (habilita `canSell`) y avisar. Hoy se relee en cada `GET /account`. |
| `payment.account.rejected` | sí | `{ provider: 'asaas'; accountId: string }` | `ACCOUNT_STATUS_GENERAL_APPROVAL_REJECTED` | Guardar y avisar; el admin muestra `rejectReasons`. |
| `payment.account.status_changed` | sí | `{ provider: 'asaas'; accountId: string; section: 'general' \| 'commercialInfo' \| 'documentation' \| 'bankAccountInfo'; status: 'PENDING' \| 'AWAITING_APPROVAL' \| 'APPROVED' \| 'REJECTED' \| 'EXPIRING_SOON' \| 'EXPIRED' }` | resto de `ACCOUNT_STATUS_*` | Actualizar `approval.<section>`. |

### Pedido y producto del proveedor (AliExpress, `/aliexpress`)

El push trae el estado del pedido sin estado logístico ni motivo de cierre, que el api sí usa
(`SupplierAliexpressOrderService.normalize`). Por eso el evento lleva un estado grueso y el api,
dueño de `purchase.supplierOrder`, **resincroniza** con `OrderSupplierOrderService.sync()` (lee
`ds.order.get`) en vez de confiar en el push.

| Tipo | Org | `data` | Mensaje AliExpress | Qué haría el api |
| --- | --- | --- | --- | --- |
| `supplier.order.status_changed` | no (la resuelve el api por `sellerId`) | `{ provider: 'aliexpress'; sellerId: string; externalOrderId: string; reference: string \| null; providerStatus: string; status?: 'AWAITING_PAYMENT' \| 'PAID' \| 'SHIPPED' \| 'DELIVERED' \| 'CANCELLED' }` | 53 (`dropshipper_order_status_update`) | Resolver la organización, buscar la compra por `supplierOrder.externalOrderIds` y `sync()`. Contrato desde 0.2.11 (falta que webhooks lo publique). |
| `supplier.order.tracking_updated` | no (la resuelve el api por `sellerId`) | `{ provider: 'aliexpress'; sellerId: string; externalOrderId: string; trackingNumbers: string[] }` | 18 (`waybill_changed`) | Resolver la organización y `sync()` (trae carrier y url; el comprador nunca ve el proveedor). |
| `supplier.product.removed` | no (global) | `{ provider: 'aliexpress'; externalProductId: string }` | 15 (`product_deleted`) | **Recorrer las tiendas**, encontrar las que importaron ese producto, inactivar sus variantes y alertar. A futuro: índice inverso `externalProductId -> organizaciones`. |
| `supplier.product.updated` | no (global) | `{ provider: 'aliexpress'; externalProductId: string; country?: string; event?: string; occurredAt?: string }` | 61 (`product_updated`, DropShip Product Update) | Pendiente hasta ver pushes reales: recorrer las tiendas que importaron el producto y releerlo en AliExpress (`OUT_OF_STOCK`: inactivar variantes y alertar). Implementado en 0.2.10 (solo el contrato; webhooks lo publica, el api aún no lo consume). |

Mensaje 61: el cuerpo documentado es `{ item_id, country_code, update_event, event_time_stamps }`, pero no está
confirmado si viene dentro de `data` o en la raíz del sobre; webhooks lee `data` y cae a la raíz.
`externalProductId` = `item_id` como string, `country` = `country_code`, `event` = `update_event` sin
tocar (solo `OUT_OF_STOCK` está documentado), `occurredAt` = `event_time_stamps` (milisegundos) en ISO.
`id` = `aliexpress:61:<item_id>:<event_time_stamps>` (estable entre reintentos del mismo push); sin
`event_time_stamps`, el hash del mensaje. Sin `item_id`: 200, log de aviso, no se publica.

Estado grueso desde `orderStatus` del push (constante `AliexpressOrderStatus` del paquete):

| `providerStatus` | `status` |
| --- | --- |
| `OrderCreated`, `paymentFailedEvent` | `AWAITING_PAYMENT` (los pedidos DS se crean sin pagar) |
| `PaymentAuthorized` | `PAID` |
| `OrderShipped` | `SHIPPED` |
| `OrderConfirmed` | `DELIVERED` |
| `OrderClosed` u otro | omitido (puede ser entregado o cancelado: decide `sync()`) |

Resolución `seller_id -> organización` (en el api; webhooks no tiene base):

| Pieza | Detalle |
| --- | --- |
| Fuente de verdad | Metadata de la organización en Auth0: `aliexpressSellerId`. La escribe el api cuando la tienda conecta AliExpress y la borra al desconectar. |
| Por qué un índice | Auth0 no permite buscar organizaciones por metadata. |
| Índice en memoria | `Map<sellerId, organization>` armado al arrancar listando las organizaciones, actualizado en connect y disconnect, y refrescado periódicamente. |
| `sellerId` desconocido | Refrescar el índice una vez; si sigue sin aparecer, ack con warning en el log (reintentar no lo arregla). Igual con un pedido que no está en la tienda. |
| A futuro (escala) | Colección global en Mongo `sellerId -> organization` con índice único. |

### Suscripción de Merkaly (Stripe, `/stripe`)

La organización sale de `metadata.AUTH0_ORG_ID` (la escribe el api en customer y suscripción). Sin
`AUTH0_ORG_ID`: 200 al proveedor, log de error, no se publica.

| Tipo | Org | `data` | Eventos Stripe | Qué haría el api |
| --- | --- | --- | --- | --- |
| `subscription.invoice.paid` | sí | `{ provider: 'stripe'; invoiceId: string; subscriptionId: string; customerId: string; productId: string \| null; priceId: string \| null; amount: number; currency: string }` | `invoice.paid` | Lo que hoy hace `webhook/stripe.controller.ts`: guardar `productId` en `STRIPE_SUBSCRIPTION_PRODUCT` de la organización en Auth0. |
| `subscription.invoice.payment_failed` | sí | `{ provider: 'stripe'; invoiceId: string; subscriptionId: string; customerId: string; amount: number; currency: string; attempt: number }` | `invoice.payment_failed` | Avisar al comerciante (hoy no se maneja). |
| `subscription.updated` | sí | `{ provider: 'stripe'; subscriptionId: string; customerId: string; status: string; productId: string \| null; priceId: string \| null; currentPeriodEnd: string \| null; cancelAtPeriodEnd: boolean }` | `customer.subscription.created`, `customer.subscription.updated` | Foto del estado: sincronizar plan y estado. |
| `subscription.cancelled` | sí | `{ provider: 'stripe'; subscriptionId: string; customerId: string; endedAt: string }` | `customer.subscription.deleted` | Quitar el plan de la organización. |

### Identidad (Auth0, `/auth0`, Event Streams, Log Streams y Actions)

| Tipo | Org | `data` | Evento Auth0 | Qué haría el api |
| --- | --- | --- | --- | --- |
| `identity.user.signed_up` | no | `{ userId: string; email: string \| null; connection: string \| null }` | log `ss` | Nada hoy: el onboarding (crear organización) sigue síncrono vía Action a `POST /auth0/onboarding`, porque el Action espera la respuesta. |
| `identity.user.deleted` | no | `{ userId: string }` | log `du` | Marcar el `AccountUser` inactivo en las organizaciones donde exista. |
| `identity.signup.requested` | no | `{ user: string; email: string; company: { name: string; email?: string } }` | Action post-login (formulario de empresa) | Crear la organización en Auth0 con el usuario como miembro (self-service signup). Implementado en 0.2.8. |
| `identity.organization.member.added` | sí | `{ user: string }` | Event Streams `organization.member.added` | Guardar el miembro en el caché del equipo (`AccountUser`), con su rol leído de Auth0. |
| `identity.organization.member.removed` | sí | `{ user: string }` | Event Streams `organization.member.deleted` | Marcar el `AccountUser` como `disabled` (no se borra). |
| `identity.organization.member.role.assigned` | sí | `{ user: string; role: string }` (nombre del rol, `ORG_ADMIN`) | Event Streams `organization.member.role.assigned` | Guardar el rol en el caché. |
| `identity.organization.member.role.removed` | sí | `{ user: string; role: string }` | Event Streams `organization.member.role.deleted` | Quitar el rol del caché si es el que tenía. |

`organization` se completa cuando el log trae `organization_id`, pero no es obligatoria: en signup y
borrado el usuario no pertenece a una organización en ese momento.
En los `identity.organization.member.*` sí es obligatoria: sale de `data.object.organization.id`.

### Lo que NO se traduce

Se responde 200 al proveedor, se **descarta con log en debug** y no se publica (sin evento
`webhook.unmapped`).

| Proveedor | Eventos | Por qué |
| --- | --- | --- |
| Asaas | `PAYMENT_CREATED`, `PAYMENT_UPDATED`, `PAYMENT_RESTORED`, `PAYMENT_AUTHORIZED`, `PAYMENT_AWAITING_RISK_ANALYSIS`, `PAYMENT_APPROVED_BY_RISK_ANALYSIS` | Estados intermedios que el api provoca o ya lee (IN_PROCESS) en el polling; ningún consumidor actúa sobre ellos. |
| Asaas | `PAYMENT_BANK_SLIP_*`, `PAYMENT_CHECKOUT_VIEWED`, `PAYMENT_DUNNING_*`, `PAYMENT_ANTICIPATED`, `PAYMENT_RECEIVED_IN_CASH_UNDONE` | Boleto, checkout hospedado, cobranza y anticipo: Merkaly no los usa (solo Pix y tarjeta 1x con formulario propio). |
| Asaas | `PAYMENT_REFUND_IN_PROGRESS`, `PAYMENT_REFUND_DENIED` | El hecho relevante es `payment.refunded`. Se agregan (patch) si hace falta mostrar el proceso. |
| Asaas | `PAYMENT_SPLIT_*` | El cobro se crea directo en la subconta del comerciante, sin split. |
| Stripe | todos los demás (`customer.*`, `invoice.created`, `payment_intent.*`, ...) | El api solo necesita factura pagada o fallida y el ciclo de la suscripción. |
| Auth0 | `s` (login ok), `slo`, `sv`, `scp`, `scpr`, `sce`, `sapi`, `fapi`, `fs` | Volumen alto o ruido; el api ya sincroniza el usuario en cada request autenticado (`account.user.sync.requested`). |
| Auth0 | `f`, `fp`, `fu` (login fallido), `limit_wc` (usuario bloqueado) | Fuera del catálogo por ahora; entran (patch) cuando haya consumidor de alertas de seguridad. |
| Auth0 | eventos de Actions no registrados (incluido `user_login` del post-login) | Se agregan al catálogo cuando exista un Action con consumidor. |
| AliExpress | 1 a 12, 20, 41 | Mensajes de pedidos del lado vendedor; Merkaly es comprador DS y solo usa 53 (pedido) y 61 (producto). |
| AliExpress | 0 (`test_push`) | Botón de prueba de la consola, solo se loguea. |

## 5. Routing

| Regla | Detalle |
| --- | --- |
| Patrón | `type` es el patrón de Nest RMQ (`{ pattern, data }`) y la routing key. El consumidor usa `@OnMerkalyEvent('payment.confirmed')`. |
| Exchange | `merkaly.events`, topic. El productor publica ahí con `type` como routing key y **nunca nombra una cola**. Decidido el 2026-11-02: con cola directa el productor quedaba acoplado al consumidor. |
| Cola por consumidor | Con el nombre del repo que consume (`api.merkaly.io`, después `payments.merkaly.io`). La declara el consumidor y Nest la liga a cada tipo con handler; un consumidor nuevo no toca al productor. Sin consumidor ligado, el exchange descarta el mensaje: el consumidor tiene que haber arrancado al menos una vez. |
| Dead letter | `<cola>.dlq`, vía `x-dead-letter-exchange` de la cola principal. |
| Cola sin consumir | Argumentos de la cola principal: `x-message-ttl` 7 días, `x-max-length` 10.000, `x-overflow: drop-head`, dead letter a la `.dlq`. Solo el consumidor declara la cola, así que no hay choque de argumentos; cambiarlos exige borrar la cola. |
| Reintento del productor | `publish` espera el ack del broker; si falla, el webhook responde 503 y el proveedor reintenta (Asaas pausa la cola de webhooks tras fallos seguidos, hay que vigilarlo). |
| Reintento del consumidor | `EventsConsumer.handle`. Éxito: `ack`. Error transitorio (red, Mongo, Asaas caído): copia a `<cola>.retry` (TTL 30 s, vuelve a la principal) y `ack`; tras 5 intentos (cabecera `x-merkaly-retries`) va a la `.dlq`. Rechazo de negocio (`EventRejectedException`: venta inexistente, monto distinto, venta cerrada): `ack` y log visible, sin reintento. |
| Idempotencia | El consumidor deduplica por `id`. v1 sin persistencia: cada handler es idempotente por diseño (`confirmPayment` ya tolera el `ConflictException` concurrente; `sync()` es lectura). Después: colección de eventos procesados con índice único en `id` y TTL de 30 días. |
| Orden | No garantizado (`received` puede llegar antes que `confirmed`). Los handlers releen el estado real en el proveedor y usan `occurredAt` para descartar fotos viejas (`subscription.updated`). |

## 6. Versionado

| Cambio | Release del paquete | `version` del evento |
| --- | --- | --- |
| Tipo de evento nuevo | ninguno (no toca el paquete) | se documenta en el catálogo |
| Campo opcional nuevo en `data` | patch | igual |
| Quitar o renombrar un campo, cambiar tipo o significado | minor | +1 (`PaymentConfirmedV1` y `V2` conviven) |
| Quitar un tipo | minor, tras `@deprecated` y la ventana | n/a |

Cambio incompatible:

1. Paquete minor con la `version` nueva.
2. Los consumidores aceptan N y N+1 y se despliegan.
3. El productor pasa a emitir N+1 (siempre una sola versión por tipo).
4. Ventana de deprecación: **30 días** o hasta que la cola no tenga mensajes N, lo que sea más largo.
5. Los consumidores quitan N (otro minor quita la interfaz vieja).

Un consumidor que recibe una `version` que no conoce hace `nack` sin requeue (va a la `.dlq`, no se
pierde).

## 7. Plan de migración

| Paso | Repo | Release | Qué |
| --- | --- | --- | --- |
| 1 | nest | minor (0.2.0) | `MerkalyEvent<K>`, `MerkalyEventType`, `EventDataMap` (pagos y subconta), `MerkalyProducer`, `EventsPublisher.emit` al exchange, `EventsConsumer` (ack, `.retry`, `.dlq`, `around` para el contexto del app). Se quitan `WebhookEvent`, `WebhookPatterns`, `toPattern` y `createWebhookEvent` (nadie los importaba: webhooks tenía su copia). |
| 2 | webhooks | patch | Asaas traducido a `payment.*` con `emit`, `raw` saneado, `value` de reais a centavos. Stripe, Auth0 y AliExpress: se descartan con log hasta tener su traducción (nadie los consume; Stripe y Auth0 siguen llegando directo al api). |
| 3 | infra | n/a | Borrar la cola vieja `api.merkaly.io-queue` (mensajes crudos sin consumidor). La cola nueva la crea el api al arrancar. |
| 4 | api | patch | Consumidor de `payment.*` y `payment.account.*` en la cola `api.merkaly.io`. El endpoint del store lee solo Mongo y el checkout sigue el cobro por SSE; queda una relectura lenta en Asaas como red de seguridad si no llega el evento. |
| 5 | nest + webhooks + api | patch | Resto del catálogo por proveedor: AliExpress (`supplier.*`, con `aliexpressSellerId` e índice), Stripe (`subscription.*`, mover el webhook del api), Auth0 (`identity.*`). |
| 7 | nest + webhooks + api | minor (0.3.0) | Se quitan `MerkalyEventType` y `EventDataMap`: `type` pasa a string y `MerkalyEvent<T>` a genérico. Productores y consumidores usan los strings del catálogo. |
| 6 | payments | fuera de alcance | `payments.merkaly.io` declara su cola ligada a lo que necesite; publica su resultado con `producer: payments.merkaly.io`. |

## 8. Decisiones

| Tema | Decisión |
| --- | --- |
| Nombres | `<dominio>.<entidad>.<hecho>`, segmentos con punto (`supplier.order.status_changed`). |
| `payment.confirmed` y `payment.received` | Separados. |
| Eventos no traducidos | Webhooks responde 200 y deja la línea en warn (`no listener declared for this event`); sin `webhook.unmapped`. |
| Organización en AliExpress | `aliexpressSellerId` en la metadata de la organización en Auth0 (fuente de verdad) + índice en memoria `sellerId -> organización` en el api (Auth0 no busca por metadata). Desconocido: refresco y luego `.dlq`. A escala: colección global en Mongo. |
| `supplier.product.removed` | Sin organización; el api recorre las tiendas. A futuro: índice inverso. |
| `supplier.product.updated` | Igual que `removed`: global. `id` determinista `aliexpress:61:<item_id>:<event_time_stamps>`; `update_event` como string libre. |
| Auth0 login fallido y bloqueo | Fuera del catálogo por ahora. |
| Stripe sin `AUTH0_ORG_ID` | 200, log de error, no se publica. |
| Tipado | `type` string del catálogo, `data` genérico (`MerkalyEvent<T>`, `emit<T>(type, data)`); el handler declara la forma que espera. `raw` opcional en todos, `unknown`, 16 KB, saneado, nunca leído por consumidores. |
| Routing | Exchange topic `merkaly.events` desde ya (2026-11-02); cola por consumidor con el nombre de su repo. |
| Cola sin consumir | 7 días / 10.000 mensajes. |
