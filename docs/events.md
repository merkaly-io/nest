# Contrato de eventos entre servicios

Estado: **aprobado por el Founder; tipos de pagos y subconta implementados en `@merkaly/nest` 0.2.0** (exchange decidido el 2026-11-02). El resto del catálogo entra por proveedor.

Antes, `webhooks.merkaly.io` publicaba en `api.merkaly.io-queue` el evento crudo de cada proveedor
(`asaas.payment_received`, `stripe.invoice.paid`...) con el sobre `WebhookEvent`, que en 0.2.0 se
quitó. Ahora publica eventos normalizados en el exchange `merkaly.events`.

Principios:

- **Eventos de negocio normalizados**; el evento original del proveedor viaja adentro solo para
  auditoría.
- Un **enum** (`MerkalyEventType`) registra todos los tipos.
- El sobre dice **qué app lo produjo**.
- `data` es un **contrato tipado** por tipo de evento.

## 1. Por qué el contrato vive en `@merkaly/nest`

`@merkaly/nest` ya es la dependencia común de los backends (api, webhooks, payments) y ya exporta
`RabbitModule`, `EventsPublisher` y `EventsConsumer`. Productor y consumidor
importan el mismo tipo y el mismo enum: si el productor cambia un campo, el build del consumidor se
rompe en vez de fallar en producción.

**Costo:** cualquier cambio de contrato exige publicar el paquete y subir la dependencia en cada
servicio.

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
| Enum | Clave en SCREAMING_SNAKE con todos los segmentos: `SUPPLIER_ORDER_STATUS_CHANGED = 'supplier.order.status_changed'`. |
| Patrón | El valor del enum es el patrón de Nest RMQ y la routing key. |

```ts
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
  SUPPLIER_ORDER_STATUS_CHANGED = 'supplier.order.status_changed',
  SUPPLIER_ORDER_TRACKING_UPDATED = 'supplier.order.tracking_updated',
  SUPPLIER_PRODUCT_REMOVED = 'supplier.product.removed',
  SUBSCRIPTION_INVOICE_PAID = 'subscription.invoice.paid',
  SUBSCRIPTION_INVOICE_PAYMENT_FAILED = 'subscription.invoice.payment_failed',
  SUBSCRIPTION_UPDATED = 'subscription.updated',
  SUBSCRIPTION_CANCELLED = 'subscription.cancelled',
  IDENTITY_USER_SIGNED_UP = 'identity.user.signed_up',
  IDENTITY_USER_DELETED = 'identity.user.deleted',
  IDENTITY_SIGNUP_REQUESTED = 'identity.signup.requested',
}
```

## 3. Sobre (envelope) y tipado

`data` se tipa con un `EventDataMap` indexado por tipo de evento: el productor no puede emitir un
`data` que no corresponda al `type` y el handler recibe `data` ya tipado.

```ts
export interface EventDataMap {
  [MerkalyEventType.PAYMENT_CONFIRMED]: PaymentRef & { confirmedAt: string };
  [MerkalyEventType.SUPPLIER_PRODUCT_REMOVED]: { provider: 'aliexpress'; externalProductId: string };
  // ... una entrada por cada valor del enum (ver catálogo)
}

export interface MerkalyEvent<K extends MerkalyEventType = MerkalyEventType> {
  id: string;
  type: K;
  version: number;
  producer: MerkalyProducer;
  source?: MerkalyEventSource;
  organization?: string;
  occurredAt: string;
  publishedAt: string;
  correlationId?: string;
  data: EventDataMap[K];
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
publisher.emit(MerkalyEventType.PAYMENT_CONFIRMED, { ...ref, confirmedAt }, { organization, source: 'asaas', raw });

// consumidor
@OnMerkalyEvent(MerkalyEventType.PAYMENT_CONFIRMED)
handle(event: MerkalyEvent<MerkalyEventType.PAYMENT_CONFIRMED>) {
  event.data.paymentId; // string, tipado
}
```

| Campo | Obligatorio | Regla |
| --- | --- | --- |
| `id` | sí | Clave de idempotencia; el consumidor deduplica por ella. Evento de proveedor: `<source>:<id del proveedor>` (`asaas:evt_...`, `stripe:evt_...`, `auth0:<log_id>`). AliExpress no manda id: `aliexpress:<sha256 del mensaje, 32 hex>`. Evento interno: UUID v4. Un evento de proveedor produce como máximo un evento normalizado; si algún día produce varios, se sufija `#<type>`. |
| `type` | sí | Valor de `MerkalyEventType`. |
| `version` | sí | Versión del contrato de `data` para ese `type`, entero desde 1. No es la versión del paquete. |
| `producer` | sí | Repo que publicó (`MerkalyProducer`). |
| `source` | no | Proveedor externo de origen. Ausente en eventos internos. |
| `organization` | según tipo | Id de organización de Auth0 (`org_...`). Ver columna "Org" del catálogo. Si el productor no la conoce, la omite (nunca string vacío). |
| `occurredAt` | sí | ISO 8601 UTC del hecho según el proveedor (Asaas `dateCreated`, Stripe `created`, Auth0 `date`, AliExpress `timestamp`). Si falta, igual a `publishedAt`. |
| `publishedAt` | sí | ISO 8601 UTC del momento de publicar. Reemplaza `receivedAt`. |
| `correlationId` | no | Id del request HTTP que originó el evento (el del logger); un evento derivado hereda el del padre. Sirve para seguir un flujo en los logs de varios servicios. |
| `data` | sí | Contrato tipado (`EventDataMap[type]`). Montos en **centavos enteros**, fechas ISO, ids del proveedor como string (los de AliExpress superan 2^53). |
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
type PaymentMethod = 'PIX' | 'CARD';

interface PaymentRef {
  provider: 'asaas';
  paymentId: string; // pay_... de Asaas
  saleId: string | null; // externalReference = id de la venta
  method: PaymentMethod;
  amount: number; // centavos (Asaas manda reais decimales)
  netAmount: number | null; // centavos, después de la tarifa
}
```

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
| `supplier.order.status_changed` | no (la resuelve el api por `sellerId`) | `{ provider: 'aliexpress'; sellerId: string; externalOrderId: string; reference: string \| null; providerStatus: string; status?: 'AWAITING_PAYMENT' \| 'PAID' \| 'SHIPPED' \| 'DELIVERED' \| 'CANCELLED' }` | 53 (`dropshipper_order_status_update`) | Resolver la organización, buscar la compra por `supplierOrder.externalOrderIds` y `sync()`. |
| `supplier.order.tracking_updated` | no (la resuelve el api por `sellerId`) | `{ provider: 'aliexpress'; sellerId: string; externalOrderId: string; trackingNumbers: string[] }` | 18 (`waybill_changed`) | Resolver la organización y `sync()` (trae carrier y url; el comprador nunca ve el proveedor). |
| `supplier.product.removed` | no (global) | `{ provider: 'aliexpress'; externalProductId: string }` | 15 (`product_deleted`) | **Recorrer las tiendas**, encontrar las que importaron ese producto, inactivar sus variantes y alertar. A futuro: índice inverso `externalProductId -> organizaciones`. |

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
| `sellerId` desconocido | Refrescar el índice una vez; si sigue sin aparecer, `nack` sin requeue a la `.dlq` con error visible en el log. |
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

### Identidad (Auth0, `/auth0`, Log Streams y Actions)

| Tipo | Org | `data` | Evento Auth0 | Qué haría el api |
| --- | --- | --- | --- | --- |
| `identity.user.signed_up` | no | `{ userId: string; email: string \| null; connection: string \| null }` | log `ss` | Nada hoy: el onboarding (crear organización) sigue síncrono vía Action a `POST /auth0/onboarding`, porque el Action espera la respuesta. |
| `identity.user.deleted` | no | `{ userId: string }` | log `du` | Marcar el `AccountUser` inactivo en las organizaciones donde exista. |
| `identity.signup.requested` | no | `{ user: string; email: string; company: { name: string; email?: string } }` | Action post-login (formulario de empresa) | Crear la organización en Auth0 con el usuario como miembro (self-service signup). Implementado en 0.2.8. |

`organization` se completa cuando el log trae `organization_id`, pero no es obligatoria: en signup y
borrado el usuario no pertenece a una organización en ese momento.

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
| Auth0 | eventos de Actions no registrados (incluido `user_login` del post-login) | Se agregan al enum cuando exista un Action con consumidor. |
| AliExpress | 1 a 12, 20, 41 | Mensajes de pedidos del lado vendedor; Merkaly es comprador DS y solo usa 53. |
| AliExpress | 0 (`test_push`) | Botón de prueba de la consola, solo se loguea. |

## 5. Routing

| Regla | Detalle |
| --- | --- |
| Patrón | `type` es el patrón de Nest RMQ (`{ pattern, data }`) y la routing key. El consumidor usa `@OnMerkalyEvent(MerkalyEventType.PAYMENT_CONFIRMED)`. |
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
| Tipo de evento nuevo (enum + entrada en `EventDataMap`) | patch | igual |
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
| 4 | api | patch | Consumidor de `payment.*` y `payment.account.*` en la cola `api.merkaly.io`. El endpoint del store pasa a leer solo Mongo; se quita el polling contra Asaas apenas funcione. |
| 5 | nest + webhooks + api | patch | Resto del catálogo por proveedor: AliExpress (`supplier.*`, con `aliexpressSellerId` e índice), Stripe (`subscription.*`, mover el webhook del api), Auth0 (`identity.*`). |
| 6 | payments | fuera de alcance | `payments.merkaly.io` declara su cola ligada a lo que necesite; publica su resultado con `producer: payments.merkaly.io`. |

## 8. Decisiones

| Tema | Decisión |
| --- | --- |
| Nombres | `<dominio>.<entidad>.<hecho>`, segmentos con punto (`supplier.order.status_changed`). |
| `payment.confirmed` y `payment.received` | Separados. |
| Eventos no traducidos | Se descartan con log en debug; sin `webhook.unmapped`. |
| Organización en AliExpress | `aliexpressSellerId` en la metadata de la organización en Auth0 (fuente de verdad) + índice en memoria `sellerId -> organización` en el api (Auth0 no busca por metadata). Desconocido: refresco y luego `.dlq`. A escala: colección global en Mongo. |
| `supplier.product.removed` | Sin organización; el api recorre las tiendas. A futuro: índice inverso. |
| Auth0 login fallido y bloqueo | Fuera del catálogo por ahora. |
| Stripe sin `AUTH0_ORG_ID` | 200, log de error, no se publica. |
| Tipado | `data: EventDataMap[K]`, `emit(type, data)` y handlers tipados; `raw` opcional en todos, `unknown`, 16 KB, saneado, nunca leído por consumidores. |
| Routing | Exchange topic `merkaly.events` desde ya (2026-11-02); cola por consumidor con el nombre de su repo. |
| Cola sin consumir | 7 días / 10.000 mensajes. |
