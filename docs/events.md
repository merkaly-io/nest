# Mensajería entre servicios (RabbitMQ)

Estado: **`@merkaly/nest` 0.5.0** (ENG-129, fase 2 de la migración a RabbitMQ por servicio). Un
exchange por servicio, varias colas por servicio con claves exactas, publisher confirms con
`mandatory` y decoradores `@HandleEvent`, `@HandleCommand` y `@HandleInvoke`. Reemplaza a
`merkaly.events`, `merkaly.requests`, `@OnMerkalyEvent` y `@OnMerkalyRequest` (0.4.x), sin
convivencia: no había tráfico real.

Los servicios migran en las fases siguientes (signals primero, después api y webhooks juntos). Este
documento describe el modelo nuevo y, en el catálogo, lo que el código publica y consume hoy.
payments queda **pendiente de migración** (sigue en 0.4.x, ver sección 9).

Principios:

- **Mensajes de negocio normalizados** (`payment.received`, nunca `asaas.payment_received`); el
  evento original del proveedor viaja adentro solo para auditoría.
- Los nombres son **strings** por convención; el paquete no exporta enums de servicios ni de
  mensajes. Valida el formato al arrancar. Sumar un servicio o un mensaje no obliga a publicar el
  paquete: cada servicio define sus constantes y este catálogo es la referencia.
- El sobre dice **qué servicio lo produjo** (`producer`, nombre corto).
- `data` es un **contrato acordado** por tipo (interfaces opcionales como `PaymentRef`, solo tipos).

## 1. Por qué vive en `@merkaly/nest`

`@merkaly/nest` es la dependencia común de los backends (api, webhooks, signals, payments) y la
fuente única de versiones de Nest. Define el sobre (`MerkalyEvent<T>`), algunas interfaces de `data`
reutilizables y el transporte. El `type` es un string libre del catálogo.

| Alternativa | Por qué no |
| --- | --- |
| Copiar los tipos en cada servicio | Se desalinean. |
| Registro de JSON Schema (o AsyncAPI) | Demasiado para pocos servicios TypeScript del mismo equipo. Se puede generar después si entra un consumidor en otro lenguaje. |
| `@merkaly/api` | Son los contratos HTTP de admin y store; los frontends no deben ver mensajes internos. |

## 2. Nombres

Se arman desde strings y se validan al arrancar (`RabbitNameError` con un mensaje claro). Nada de
`*` ni `#`.

| Pieza | Regla | Ejemplo |
| --- | --- | --- |
| Servicio | `^[a-z][a-z0-9-]*$`, nombre corto del repo | `api`, `webhooks`, `signals` |
| Exchange | `merkaly.<servicio>`, topic, durable, uno por servicio | `merkaly.webhooks` |
| Trabajo (cola) | `^[a-z][a-z0-9-]*$`; `invokes` está reservado | `payments`, `identity`, `emails` |
| Cola | `merkaly.<servicio>-<trabajo>`, más `.retry` y `.dlq` | `merkaly.api-payments`, `merkaly.api-payments.retry`, `merkaly.api-payments.dlq` |
| Cola de invokes | `merkaly.<servicio>-invokes`, sin `.retry` ni `.dlq` | `merkaly.api-invokes` |
| Tipo de mensaje | `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`: segmentos con punto, minúsculas, al menos dos | `payment.confirmed`, `email.send` |
| Routing key | igual al tipo (Nest exige patrón = routing key) | `payment.confirmed` |

Forma del tipo:

| Clase | Forma | Ejemplo |
| --- | --- | --- |
| Evento | `<dominio>.<entidad>.<hecho>` o `<dominio>.<hecho>`, hecho en pasado (snake_case si son dos palabras) | `supplier.order.status_changed` |
| Comando | `<entidad>.<verbo>` en presente, **sin el servicio**: dice qué hacer, no quién | `email.send` |
| Invoke | igual que un comando, sin el servicio | `payment.withdrawal.authorize` |

Sin prefijos de transporte (`command.`, `event.`) ni de servicio: el exchange ya dice de quién es.

## 3. Clases de mensaje

| Clase | Quién publica | Exchange | API del publisher | Handler | Respuesta | `.retry` / `.dlq` |
| --- | --- | --- | --- | --- | --- | --- |
| Evento (algo que pasó) | quien lo vivió | el **propio** | `emit(type, data, meta?)` | `@HandleEvent(type, { queue, from })` | no | sí |
| Comando (algo que hacer) | quien lo pide | el **del destino** | `command(service, type, data, meta?)` | `@HandleCommand(type, { queue })` | no | sí |
| Invoke (pedido con respuesta en segundos) | quien pregunta | el **del destino** | `invoke(service, type, data, { timeout, ...meta })` | `@HandleInvoke(type)` | sí, el retorno del handler | no |

- `@HandleEvent` liga la cola a `merkaly.<from>` (el exchange de quien publica el evento; `from` es
  obligatorio, también para eventos propios: `from: 'api'`).
- `@HandleCommand` y `@HandleInvoke` ligan al exchange propio.
- `@HandleEvent` y `@HandleCommand` aceptan un tipo o una lista, y se pueden apilar en el mismo
  método mientras sea la **misma cola** (por ejemplo, claves de `merkaly.webhooks` y de
  `merkaly.api` en `identity`). `@HandleInvoke` es un tipo por handler.
- Los handlers van en **controllers** (Nest solo descubre patrones ahí).

## 4. Sobre (envelope)

```ts
export interface MerkalyEvent<T = unknown> {
  id: string;
  type: string; // payment.confirmed
  version: number;
  producer: string; // servicio que publicó: webhooks, api, signals
  source?: MerkalyEventSource; // 'asaas' | 'stripe' | 'auth0' | 'aliexpress'
  organization?: string;
  occurredAt: string;
  publishedAt: string;
  correlationId?: string;
  data: T;
  raw?: MerkalyRawEvent;
}

export interface MerkalyInvoke<T = unknown> extends MerkalyEvent<T> {
  expiresAt: string; // ISO, ahora + timeout: vencido, el consumidor lo descarta
}
```

| Campo | Obligatorio | Regla |
| --- | --- | --- |
| `id` | sí | Clave de idempotencia; el consumidor deduplica por ella. Evento de proveedor: `<source>:<id del proveedor>` (`asaas:evt_...`, `auth0:<log_id>`). AliExpress no manda id: `aliexpress:<sha256 del mensaje, 32 hex>` (o `aliexpress:61:<item_id>:<event_time_stamps>`). Mensaje interno: UUID v4, o un id estable por envío en comandos (`email.send`). |
| `type` | sí | String del catálogo. |
| `version` | sí | Versión del contrato de `data` para ese `type`, entero desde 1. No es la versión del paquete. |
| `producer` | sí | Nombre corto del servicio que publicó (el de `RabbitModule.forRoot({ service })`). Hasta 0.4.x era `webhooks.merkaly.io`. Es el ORIGIN de la línea de log del consumidor. |
| `source` | no | Proveedor externo de origen. Ausente en mensajes internos. |
| `organization` | según tipo | Id de organización de Auth0 (`org_...`). Si el productor no la conoce, la omite (nunca string vacío). |
| `occurredAt` | sí | ISO 8601 UTC del hecho según el proveedor. Si falta, igual a `publishedAt`. |
| `publishedAt` | sí | ISO 8601 UTC del momento de publicar. |
| `correlationId` | no | Id del request HTTP que originó el mensaje; un mensaje derivado hereda el del padre. |
| `data` | sí | Contrato por tipo. Montos en **centavos enteros** (el productor convierte en la frontera), fechas ISO, ids del proveedor como string (los de AliExpress superan 2^53). |
| `raw` | no | Solo auditoría: **ningún consumidor lo lee**. Máximo 16 KB serializado (`RAW_PAYLOAD_LIMIT`); si se pasa, `payload` se omite y `truncated: true`. Saneado por el productor. |

Saneado de `raw` (en el productor):

| Proveedor | Se quita |
| --- | --- |
| Asaas | datos del cliente, `creditCard` salvo marca y últimos 4, `pixQrCode`, urls de factura |
| Auth0 | `ip`, `user_agent`, `details`, `location_info`, `hostname` |
| AliExpress | dirección, nombre, teléfono y CPF del destinatario si vinieran |

En el cable el cuerpo es el paquete de Nest RMQ: `{ pattern: type, data: <sobre> }` para eventos y
comandos, y `{ pattern, data, id }` para invokes (Nest responde a los paquetes con `id`).

## 5. Topología y routing

| Regla | Detalle |
| --- | --- |
| Exchange | Uno por servicio, `merkaly.<servicio>`, topic, durable. Lo declara el publisher del dueño, cada consumidor que liga claves de él y el publisher que le manda un comando o invoke (mismos argumentos, la declaración es idempotente). |
| Colas | Varias por servicio, una por trabajo. Cada cola tiene un solo dueño; las réplicas del servicio se reparten sus mensajes. La declara el dueño con `rabbitQueue()` (o `rabbitInvokes()`) en su `main.ts`. |
| Bindings | Una clave **exacta** por tipo con handler, nunca `#` ni `*`. Una cola puede ligar claves de varios exchanges. |
| Transporte | Cada cola tiene su transport id (`Symbol.for('merkaly.queue:<trabajo>')`, invokes `Symbol.for('merkaly.invokes')`): los handlers de una cola nunca se ligan a otra. |
| Clave repetida | Dos handlers de la misma clave en la misma cola hacen fallar el boot (Nest correría los dos y habría doble ack). |
| Patrón | El `pattern` del cuerpo tiene que ser la routing key cuando el mensaje llega por un exchange; si no, se descarta a la `.dlq`. Lo que vuelve de `.retry` llega por el exchange por defecto y no se valida. |
| Sin consumidor | Todo publish va con `mandatory`: si ninguna cola liga la clave, el broker devuelve el mensaje y la promesa rechaza con `UnroutableMessageException` (503). El productor no pierde mensajes en silencio; webhooks responde 5xx y el proveedor reintenta. Corolario: **la cola del consumidor tiene que existir antes** de que el productor publique (desplegar primero al consumidor). |
| Confirmación | Publisher confirms: `emit` y `command` resuelven cuando el broker tomó y enrutó el mensaje. Timeout 5 s (`timeout` del módulo). |
| Broker caído | Falla en el momento (`ServiceUnavailableException`, "not connected"), sin buffer silencioso. Con la conexión arriba pero el canal ocupado, el mensaje espera como máximo el timeout y se descarta del buffer. |
| Cola sin consumir | Argumentos de la cola principal (sin cambios desde 0.4): `x-message-ttl` 7 días, `x-max-length` 10.000, `x-overflow: drop-head`, dead letter a la `.dlq`. Cambiarlos exige borrar la cola. **TODO fase 5**: revisar `drop-head` (bajo presión descarta los más viejos a la `.dlq`). |
| Bindings viejos | El paquete liga, no desliga: si se quita un handler, la clave queda ligada en el broker y sus mensajes van a la `.dlq` (sin handler). Desligar a mano (management UI o `rabbitmqadmin`). |

### Reintentos del consumidor (`EventsConsumer.handle`)

| Resultado | Qué pasa |
| --- | --- |
| Éxito | `ack`. |
| `EventRejectedException` (venta inexistente, monto distinto...) | `ack` + `WARN`: reintentar no lo arregla. |
| Otro error (Mongo, red, proveedor caído) | Copia a `<cola>.retry` (TTL `retryDelay`, 30 s por defecto, vuelve sola a la cola) con la cabecera `x-merkaly-retries`, y `ack` del original **solo después de la confirmación del broker** (ENG-91). Si la copia no se confirma, `nack` con requeue del original. Tras `retries` intentos (5 por defecto), `.dlq`. |
| Malformado o `version` mayor que la del handler | `.dlq` directo. |

La cola de origen (para `.retry` y `.dlq`) la conoce el servidor que consumió el mensaje, nunca el
payload. `retries` y `retryDelay` son por cola (`rabbitQueue({ retries, retryDelay })`).

### Invokes

| Regla | Detalle |
| --- | --- |
| Exchange | El del servicio que responde (`invoke('api', ...)` publica en `merkaly.api`). |
| Cola | `merkaly.<servicio>-invokes`, durable, `noAck`, sin `.retry` ni `.dlq`, `x-message-ttl` 30 s, `x-max-length` 1.000 con `drop-head`. La declara quien responde con `rabbitInvokes()`. |
| Respuesta | Direct reply-to (`amq.rabbitmq.reply-to`) con `correlationId`, en el mismo canal del publisher. |
| Mensaje | `expiration` = timeout, no persistente; el sobre lleva `expiresAt`. Vencido: el broker lo descarta y, si igual llega, el servidor lo descarta sin correr el handler (`WARN expired, dropped`). |
| Errores | Sin respuesta en el plazo: `GatewayTimeoutException`. Handler con error, broker sin configurar o caído: `ServiceUnavailableException`. Nadie ligó el tipo: `UnroutableMessageException` en el momento (sin esperar el timeout). Quien pregunta decide el fallback (webhooks responde `REFUSED`). |
| Contexto | El handler corre fuera del contexto del app (sin CLS, guards ni interceptors globales); abre el suyo si lo necesita. |

### Idempotencia y orden

- El consumidor deduplica por `id`. Hoy sin persistencia (cada handler es idempotente por diseño;
  signals deduplica en memoria). Inbox persistente: fase 5 (ENG-112).
- Orden no garantizado (`received` puede llegar antes que `confirmed`): los handlers releen el estado
  real en el proveedor.

## 6. Matriz de routing (destino de las fases 3 y 4)

| Mensaje | Clase | Publica | Exchange | Cola dueña |
| --- | --- | --- | --- | --- |
| `payment.confirmed`, `.received`, `.failed`, `.overdue`, `.cancelled`, `.refunded`, `.refund.in_progress`, `.split.failed`, `.chargeback.opened`, `.chargeback.updated` | evento | webhooks | `merkaly.webhooks` | `merkaly.api-payments` |
| `payment.account.approved`, `.rejected`, `.status_changed` | evento | webhooks | `merkaly.webhooks` | `merkaly.api-payments` |
| `payment.transfer.created`, `.pending`, `.in_bank_processing`, `.blocked`, `.done`, `.failed`, `.cancelled` | evento | webhooks | `merkaly.webhooks` | `merkaly.api-payments` |
| `supplier.order.status_changed` | evento | webhooks | `merkaly.webhooks` | `merkaly.api-supplier` |
| `supplier.product.updated` | evento | webhooks | `merkaly.webhooks` | **ninguna** (ver sección 8) |
| `identity.signup.requested`, `identity.organization.member.added`, `.removed`, `.role.assigned`, `.role.removed`, `identity.organization.created`, `.updated`, `.deleted` | evento | webhooks | `merkaly.webhooks` | `merkaly.api-identity` |
| `account.user.linked` | evento | api | `merkaly.api` | `merkaly.api-identity` |
| `payment.withdrawal.authorize`, `payment.refund.authorize` | invoke | webhooks | `merkaly.api` | `merkaly.api-invokes` |
| `email.send` | comando | nadie hoy | `merkaly.signals` | `merkaly.signals-emails` |

## 7. Catálogo

Lo que el código publica y consume hoy (master de webhooks, api y signals, 2026-11-24). Los
servicios todavía usan 0.4.x (`merkaly.events` y `merkaly.requests`); el exchange y la cola de la
tabla son los de la matriz.

"Org": **sí** = obligatoria (sin ella el productor responde 200 al proveedor, loguea y no publica);
**no** = el productor no la conoce.

```ts
type PaymentMethod = 'PIX' | 'CARD' | 'BOLETO';

interface PaymentRef {
  provider: 'asaas';
  paymentId: string; // pay_... de Asaas
  saleId: string | null; // del externalReference <orgId>:<saleId>
  method: PaymentMethod;
  amount: number; // centavos
  netAmount: number | null; // centavos, después de la tarifa
  providerEvent?: string; // PAYMENT_RECEIVED
  providerStatus?: string; // RECEIVED, CONFIRMED...
  walletId?: string | null; // wallet de la subconta, del split
  externalReference?: string | null; // sin tocar
}
```

El api no decide con `data`: relee el cobro en Asaas (el evento es un disparador).

### Cobros del store (Asaas, `/asaas`, publica webhooks)

| Tipo | Org | `data` | Eventos Asaas | Consumidor |
| --- | --- | --- | --- | --- |
| `payment.confirmed` | sí | `PaymentRef & { confirmedAt }` | `PAYMENT_CONFIRMED` | api: `syncSalePayment` |
| `payment.received` | sí | `PaymentRef & { receivedAt }` | `PAYMENT_RECEIVED` | api: igual |
| `payment.failed` | sí | `PaymentRef & { reason: 'card_refused' \| 'risk_rejected' }` | `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED`, `PAYMENT_REPROVED_BY_RISK_ANALYSIS` | api: igual |
| `payment.overdue` | sí | `PaymentRef & { dueDate }` | `PAYMENT_OVERDUE` | api: igual |
| `payment.cancelled` | sí | `PaymentRef` | `PAYMENT_DELETED` | api: igual |
| `payment.refunded` | sí | `PaymentRef & { refundedAmount; partial }` | `PAYMENT_REFUNDED`, `PAYMENT_PARTIALLY_REFUNDED` | api: igual |
| `payment.refund.in_progress` | sí | `PaymentRef` | `PAYMENT_REFUND_IN_PROGRESS` | api: igual (`REFUNDED` llega después) |
| `payment.refund.denied` | sí | `PaymentRef` | `PAYMENT_REFUND_DENIED` | api: igual (resync del cobro) |
| `payment.split.failed` | sí | `PaymentRef & { reason: 'cancelled' \| 'divergence_block' }` | `PAYMENT_SPLIT_CANCELLED`, `PAYMENT_SPLIT_DIVERGENCE_BLOCK` | api: igual |
| `payment.chargeback.opened` | sí | `PaymentRef & { reason: string \| null }` | `PAYMENT_CHARGEBACK_REQUESTED` | api: igual |
| `payment.chargeback.updated` | sí | `PaymentRef & { stage: 'disputed' \| 'awaiting_reversal' }` | `PAYMENT_CHARGEBACK_DISPUTE`, `PAYMENT_AWAITING_CHARGEBACK_REVERSAL` | api: igual |

### Subconta del comerciante (Asaas, KYC, publica webhooks)

| Tipo | Org | `data` | Eventos Asaas | Consumidor |
| --- | --- | --- | --- | --- |
| `payment.account.approved` | sí | `{ provider: 'asaas'; accountId }` | `ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED` | api: `refreshAccount` |
| `payment.account.rejected` | sí | igual | `ACCOUNT_STATUS_GENERAL_APPROVAL_REJECTED` | api: igual |
| `payment.account.status_changed` | sí | `{ provider: 'asaas'; accountId; section: 'general' \| 'commercialInfo' \| 'documentation' \| 'bankAccountInfo'; status: 'PENDING' \| 'AWAITING_APPROVAL' \| 'APPROVED' \| 'REJECTED' \| 'EXPIRING_SOON' \| 'EXPIRED' }` | resto de `ACCOUNT_STATUS_*` | api: igual |

### Transferencias de la subconta (Asaas, publica webhooks)

La organización sale del `?organization=` del webhook de la subconta. Llegan sin orden y al menos una
vez.

| Tipo | Org | `data` | Eventos Asaas | Consumidor |
| --- | --- | --- | --- | --- |
| `payment.transfer.created`, `.pending`, `.in_bank_processing`, `.blocked`, `.done`, `.failed`, `.cancelled` | sí | `{ provider: 'asaas'; transferId; amount; netAmount: number \| null; operationType: string \| null; providerEvent; providerStatus; externalReference: string \| null }` (centavos) | `TRANSFER_*` | api: `syncWithdrawal` |

### Pedido y producto del proveedor (AliExpress, `/aliexpress`, publica webhooks)

| Tipo | Org | `data` | Mensaje AliExpress | Consumidor |
| --- | --- | --- | --- | --- |
| `supplier.order.status_changed` | no (la resuelve el api por `sellerId`) | `SupplierOrderStatusChanged`: `{ provider: 'aliexpress'; sellerId; externalOrderId; reference: string \| null; providerStatus; status?: 'AWAITING_PAYMENT' \| 'PAID' \| 'SHIPPED' \| 'DELIVERED' \| 'CANCELLED' }` | 53 | api: resuelve la organización y `syncSupplierOrder` (relee `ds.order.get`); `sellerId` desconocido = rechazo |
| `supplier.product.updated` | no (global) | `SupplierProductUpdated`: `{ provider: 'aliexpress'; externalProductId; country?; event?; occurredAt? }` | 61 | **nadie** (ver sección 8) |

`providerStatus` es el `orderStatus` sin tocar (tipo `AliexpressOrderStatus`, unión de strings):

| `providerStatus` | `status` |
| --- | --- |
| `OrderCreated`, `paymentFailedEvent` | `AWAITING_PAYMENT` |
| `PaymentAuthorized` | `PAID` |
| `OrderShipped` | `SHIPPED` |
| `OrderConfirmed` | `DELIVERED` |
| `OrderClosed` u otro | omitido (decide `sync()`) |

Mensaje 61: `externalProductId` = `item_id` como string, `country` = `country_code`, `event` =
`update_event` sin tocar (solo `OUT_OF_STOCK` documentado), `occurredAt` = `event_time_stamps` en ISO.

### Identidad (Auth0, `/auth0`, publica webhooks)

| Tipo | Org | `data` | Origen Auth0 | Consumidor |
| --- | --- | --- | --- | --- |
| `identity.signup.requested` | no | `IdentitySignupRequested`: `{ user; email; company: { name; email? } }` | Action post-login (formulario de empresa) | api: `signupStore` (crea la organización con el usuario como miembro) |
| `identity.organization.member.added` | sí | `data.object` de Auth0: `{ organization: { id; name? }; user: { user_id } }` | Event Streams `organization.member.added` | api: caché de miembros (`AccountUser`) |
| `identity.organization.member.removed` | sí | igual | `organization.member.deleted` | api: marca `disabled` |
| `identity.organization.member.role.assigned` | sí | igual + `role: { id; name }` | `organization.member.role.assigned` | api: guarda el rol |
| `identity.organization.member.role.removed` | sí | igual que `role.assigned` | `organization.member.role.deleted` | api: quita el rol |
| `identity.organization.created` | sí | `data.object` de Auth0: `{ id; name?; display_name?; metadata? }` | `organization.created` | api: `TenantService.reload` |
| `identity.organization.updated` | sí | igual | `organization.updated` | api: igual |
| `identity.organization.deleted` | sí | igual | `organization.deleted` | api: `TenantService.remove` |

### Cuenta (publica el api)

| Tipo | Org | `data` | Origen | Consumidor |
| --- | --- | --- | --- | --- |
| `account.user.linked` | no | `{ from; to }` (ids de Auth0: el vinculado, borrado, y el primario) | cambio de contraseña que vincula una identidad existente | api: `reassignUserReferences` en todas las organizaciones |

Hoy se publica en segundo plano (`runInBackground`): si el broker falla, solo queda el log (outbox:
fase 5).

### Comandos de notificación (signals)

`signals` consume con **una cola por canal**; hoy solo email. `id` = clave de idempotencia estable
por envío para que un reenvío no mande dos emails.

| Tipo | Org | `data` | Cola | Consumidor |
| --- | --- | --- | --- | --- |
| `email.send` | según el envío | `{ to: string \| string[]; cc?: string \| string[]; subject; text }` | `merkaly.signals-emails` | signals: envía; error transitorio `.retry`, dato inválido o rechazo permanente `ack` con log; dedup en memoria por `id` |

Nadie lo publica todavía (el api lo hará con `command('signals', 'email.send', ...)`). A futuro
`sms.send` y `whatsapp.send` en `merkaly.signals-sms` y `merkaly.signals-whatsapp`.

### Invokes que responde el api

| Tipo | Quién pregunta | `data` | Respuesta |
| --- | --- | --- | --- |
| `payment.withdrawal.authorize` | webhooks (`POST /asaas/withdrawals`, timeout 3 s) | `{ transfer: { id, amount, externalReference, operationType } }` (`amount` en centavos; nunca la clave Pix) | `{ status: 'APPROVED' }` o `{ status: 'REFUSED', refuseReason }` |
| `payment.refund.authorize` | webhooks (mismo endpoint) | `{ refund: { id, payment, amount } }` (centavos) | igual |

## 8. Desajustes conocidos (catálogo vs código)

Publicado y sin consumidor:

- `supplier.product.updated`: ligado en `merkaly.api-supplier` con un handler que solo registra el
  aviso como pendiente (ENG-16) y hace `ack`, para que AliExpress no reciba 503.

Consumido y sin productor:

- `email.send`: signals lo consume, nadie lo publica todavía.

Documentado antes y sin código (ni productor ni consumidor), queda como propuesta:

| Tipo | Nota |
| --- | --- |
| `identity.user.signed_up`, `identity.user.deleted` | logs `ss` y `du` de Auth0 |
| `supplier.order.tracking_updated` | mensaje 18 de AliExpress |
| `supplier.product.removed` | mensaje 15 de AliExpress |
| `subscription.invoice.paid`, `.invoice.payment_failed`, `subscription.updated`, `subscription.cancelled` | Stripe: no hay webhook de Stripe en webhooks |

Con claves exactas nada de esto se liga hasta que tenga handler.

## 9. payments (pendiente de migración)

`payments.merkaly.io` sigue en 0.4.x, fuera de esta migración: declara `payments.merkaly.io` ligada a
`merkaly.events` con `payment.provider.#`, conecta una cola de pedidos sin handlers y re-emite los
`payment.*` traducidos con `producer: payments.merkaly.io`. En master de webhooks **nadie publica**
`payment.provider.notified` y webhooks sigue traduciendo Asaas, así que hoy payments no recibe nada.

Cuando entre: exchange `merkaly.payments`, sus eventos `payment.*` saldrían de ahí (los
consumidores cambian `from: 'webhooks'` por `from: 'payments'`), y sus invokes sin el servicio en el
nombre (`payment.charge.create` en vez de `payments.charge.create`). Contrato del servicio: repo
payments, `docs/contract.md`.

## 10. Lo que no se traduce

Webhooks responde 200 al proveedor, descarta con log y no publica (sin `webhook.unmapped`).

| Proveedor | Eventos | Por qué |
| --- | --- | --- |
| Asaas | `PAYMENT_CREATED`, `PAYMENT_UPDATED`, `PAYMENT_RESTORED`, `PAYMENT_AUTHORIZED`, `PAYMENT_AWAITING_RISK_ANALYSIS`, `PAYMENT_APPROVED_BY_RISK_ANALYSIS` | Estados intermedios que el api provoca o ya lee. |
| Asaas | `PAYMENT_BANK_SLIP_*`, `PAYMENT_CHECKOUT_VIEWED`, `PAYMENT_DUNNING_*`, `PAYMENT_ANTICIPATED`, `PAYMENT_RECEIVED_IN_CASH_UNDONE` | Merkaly no los usa (solo Pix y tarjeta 1x). |
| Auth0 | logins, `slo`, `sv`, `scp`, `sapi`, fallidos y bloqueos | Volumen alto o sin consumidor. |
| AliExpress | 1 a 12, 20, 41; 0 (`test_push`) | Lado vendedor o prueba; Merkaly es comprador DS (53 y 61). |

## 11. Versionado

| Cambio | Release del paquete | `version` del mensaje |
| --- | --- | --- |
| Tipo nuevo | ninguno (no toca el paquete) | se documenta en el catálogo |
| Campo opcional nuevo en `data` | ninguno, o patch si hay interfaz exportada | igual |
| Quitar o renombrar un campo, cambiar tipo o significado | minor si hay interfaz exportada | +1 (conviven N y N+1) |

Cambio incompatible de `data`: los consumidores aceptan N y N+1 y se despliegan, el productor pasa a
N+1, ventana de 30 días, los consumidores quitan N. Un consumidor que recibe una `version` que no
conoce manda el mensaje a la `.dlq`.

## 12. Pendientes (fase 5 y siguientes)

- Revisar `x-overflow: drop-head` y los 10.000 mensajes de las colas principales.
- Alerta de `.dlq` (ENG-116), inbox persistente (ENG-112), outbox en el api.
- Broker caído en el arranque (ENG-87): hoy el publisher falla en el momento, sin buffer.
- Cola de un solo consumidor entre entornos: sin vhosts, un servicio local con el `RABBITMQ_URL` de
  producción compite por los mensajes. En local, `RABBITMQ_URL` vacío.
- Limpieza manual de la topología de 0.4 cuando migren los servicios: exchanges `merkaly.events` y
  `merkaly.requests`; colas `api.merkaly.io` (+ `.retry`, `.dlq`, `.requests`) y
  `signals.merkaly.io-emails` (+ `.retry`, `.dlq`).

## 13. Historia

| Versión | Cambio |
| --- | --- |
| 0.2.0 | Sobre `MerkalyEvent`, exchange `merkaly.events`, `EventsConsumer` con `.retry` y `.dlq`. |
| 0.3.0 | Sin `MerkalyEventType` ni `EventDataMap`: `type` string y `data` genérico. |
| 0.3.1 | Request-reply en `merkaly.requests`. |
| 0.5.0 | Exchange y colas por servicio, claves exactas, `mandatory`, confirmación antes del ack al reintentar, `@HandleEvent` / `@HandleCommand` / `@HandleInvoke`, `emit` / `command` / `invoke`. Sin `MerkalyProducer` (`producer` es el nombre corto), `MerkalyRequest` pasa a `MerkalyInvoke`, `AliexpressOrderStatus` es solo un tipo. |
