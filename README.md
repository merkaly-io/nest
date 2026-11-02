# @merkaly/nest

Pacote compartilhado dos backends NestJS da Merkaly (api, webhooks, payments). Faz duas coisas:

1. **Fonte única de versões**: fixa `@nestjs/*`, rxjs, amqplib, class-validator, dotenv e também o tooling de desenvolvimento (ESLint, Prettier, TypeScript, typescript-eslint, Nest CLI, ts-node, `@types/node`).
2. **Infraestrutura comum**: RabbitMQ (publisher + consumidor), contrato de eventos de webhook, logger, filtro de exceções, env e assinaturas.

Proposta e motivação: [docs/proposal.md](docs/proposal.md).

## Regra de versões

- O app **nunca** declara pacotes que `@merkaly/nest` já fornece (veja `dependencies` no `package.json`). Eles chegam ao app pelo `shamefully-hoist`.
- Tudo o que o app importa e **não** está nesse pacote (ex.: `mongoose`, `stripe`, `express`, `@nestjs/mongoose`, `@nestjs/swagger`) é declarado no próprio app. Nunca dependa de um pacote transitivo que não esteja na lista.

## Uso em um app

`.npmrc`

```ini
shamefully-hoist=true
strict-peer-dependencies=false
```

`package.json`

```json
{
  "dependencies": {
    "@merkaly/nest": "^0.1.7"
  }
}
```

`eslint.config.mjs`, `.prettierrc`, `tsconfig.json` e `nest-cli.json` continuam no app (mesmo conteúdo do api).

## API

```ts
import {
  env, loadEnv, // config
  LoggerModule, LoggerService, // logger
  requestLogger, requestOrigin, bodyParsers, bodyParserReason, // uma linha por request
  AbstractExceptionFilter, ExceptionsFilter, rememberError, // filtros (motivo do erro para o log)
  RabbitModule, EventsPublisher, rabbitConsumerOptions, OnRabbitEvent, ackMessage, nackMessage,
  WebhookEvent, WebhookPatterns, WebhookPattern, AliexpressOrderStatus, createWebhookEvent, toPattern,
  SignatureGuard, safeCompare, hmacDigest, verifyHmac,
} from '@merkaly/nest';
```

### Módulos

```ts
@Module({
  imports: [
    LoggerModule.forRoot({ service: 'webhooks.merkaly.io' }), // global
    RabbitModule.forRoot({
      url: env.string('RABBITMQ_URL'), // sem url: publish rejeita com 503
      queue: env.string('RABBITMQ_QUEUE', 'api.merkaly.io-queue'), // <repo>-queue
      routes: { [WebhookPatterns.asaas.PAYMENT_CONFIRMED]: 'payments.merkaly.io-queue' }, // opcional
      timeout: env.number('RABBITMQ_PUBLISH_TIMEOUT', 5000),
      required: env.isProduction, // produção não sobe sem url
    }),
  ],
  providers: [{ provide: APP_FILTER, useClass: ExceptionsFilter }],
})
export class AppModule {}
```

`RabbitModule.forRootAsync({ imports, inject, useFactory })` aceita a config injetada.

**Filas**: o nome é o do repositório do serviço que consome, `<repo>-queue` (ex.: `api.merkaly.io-queue`, `payments.merkaly.io-queue`). O pacote não tem fila padrão: cada app passa a sua.

**Health check**: o pacote não registra controllers. O Swagger servido em `/` responde 200 e funciona como health check.

### Logger e requests

Uma linha por request, impressa ao terminar a resposta (inclui Swagger e rotas desconhecidas):

```
10:21:07 412 LOG     [garagemtuning.store.merkaly.test] GET /store/products 200 34ms
10:21:08 027 WARN    [203.0.113.7] GET /wp-login.php 404 1ms "Cannot GET /wp-login.php"
10:21:09 551 ERROR   [admin.merkaly.io] POST /admin/orders 500 12ms "boom"
Error: boom
    at ...
```

- Nível: `ERROR` em 5xx (com o stack embaixo), `WARN` em 4xx, `LOG` no resto.
- Origem padrão (`requestOrigin`): `x-merkaly-host`, senão o host do `Origin`, senão `cf-connecting-ip`, senão o primeiro `x-forwarded-for`, senão o socket.
- Nunca loga body, headers, tokens nem query. O motivo é cortado em 200 caracteres.
- Logs internos (`logger.log({ group, message })`) mostram uma coluna de label: `context()` dentro de um request, senão `service`.

```ts
// main.ts
app.use(requestLogger(app)); // antes do Swagger; opcional { label: (req) => 'grupo' }
bodyParsers(app, { raw: ['/webhook/stripe'] }); // json + urlencoded com motivo seguro ("Invalid JSON body")
SwaggerModule.setup('/', app, document);
```

- `bodyParsers(app, { raw?, rawBody? })`: `raw` mantém o body como Buffer nesses paths; `rawBody: true` preenche `req.rawBody` (igual ao `NestFactory.create(..., { rawBody: true })`, que deixa de registrar os próprios parsers).
- Contexto por request (ex.: host do tenant via CLS), sem o pacote depender de `nestjs-cls`:

```ts
LoggerModule.forRootAsync({
  inject: [ClsService],
  useFactory: (cls: ClsService) => ({ service: 'api.merkaly.io', context: () => cls.get('host') }),
});
```

**Filtros**: o filtro não loga; guarda o motivo (e o stack de 5xx) em `response.locals` e o `requestLogger` imprime. `ExceptionsFilter` responde `{ statusCode, message, path, timestamp }`. Para filtros próprios, estender `AbstractExceptionFilter` (resposta padrão do Nest, sem o log duplicado do `ExceptionsHandler`) e usar `this.remember(response, motivo, trace?)` quando responder por conta própria.

### Eventos

Envelope `WebhookEvent<T>`: `{ id, source, type, receivedAt, organization?, data }`. Padrão do nome: `<source>.<evento>` em minúsculas (`toPattern('asaas', 'PAYMENT_CONFIRMED')` = `asaas.payment_confirmed`). Os padrões conhecidos ficam em `WebhookPatterns` e são a fonte única para produtores e consumidores, iguais ao que o webhooks publica:

- Asaas: `asaas.<evento em minúsculas>` (ex.: `asaas.payment_received`).
- Stripe: tipo pontuado original (ex.: `stripe.invoice.paid`, `stripe.customer.subscription.updated`).
- Auth0: nome legível do código de log (ex.: `auth0.success_signup`, `auth0.success_login`, `auth0.user_deleted`) e `auth0.user_login` da Action.
- AliExpress: tópico do `message_type` (53 `aliexpress.dropshipper_order_status_update`, 18 `aliexpress.waybill_changed`, 15 `aliexpress.product_deleted`); status do pedido DS em `AliexpressOrderStatus`.

```ts
await this.events.publish(
  WebhookPatterns.asaas.PAYMENT_CONFIRMED,
  createWebhookEvent({ id: body.id, source: 'asaas', type: body.event, data: body.payment }),
); // resolve só com ack do broker; timeout ou falha: ServiceUnavailableException
```

Consumidor (quando o api ou o payments passarem a consumir):

```ts
app.connectMicroservice(rabbitConsumerOptions({ url, queue: 'api.merkaly.io-queue' }));
await app.startAllMicroservices();

@OnRabbitEvent(WebhookPatterns.asaas.PAYMENT_CONFIRMED)
handle(@Payload() event: WebhookEvent, @Ctx() context: RmqContext) {
  return this.service.confirm(event).then(() => ackMessage(context));
}
```

### Env

`env.string`, `env.number`, `env.boolean`, `env.list`, `env.required`, `env.isProduction`. Carrega o `.env` (dotenv) no primeiro acesso. Valor obrigatório ausente ou inválido: **erro em produção**, aviso no log fora dela.

### Assinaturas

`safeCompare` (timing-safe, vazio nunca bate), `hmacDigest`/`verifyHmac` (sha256 hex por padrão) e `SignatureGuard` abstrato (exige `NestFactory.create(AppModule, { rawBody: true })`).

## Desenvolvimento

```bash
pnpm install
pnpm lint
pnpm build
```

Release: tag `vX.Y.Z` (igual à versão do `package.json`) publica no npm.
