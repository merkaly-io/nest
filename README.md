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
  requestLogger, requestOrigin, requestContext, noteRequest, bodyParsers, bodyParserReason, // uma linha por request
  AbstractExceptionFilter, ExceptionsFilter, rememberError, // filtros (motivo do erro para o log)
  RabbitModule, EventsPublisher, EventsConsumer, EventRejectedException, // eventos
  rabbitConsumerOptions, assertConsumerTopology, OnMerkalyEvent,
  MerkalyEvent, MerkalyEventType, MerkalyProducer, EventDataMap, createMerkalyEvent, AliexpressOrderStatus,
  SignatureGuard, safeCompare, hmacDigest, verifyHmac,
} from '@merkaly/nest';
```

### Módulos

```ts
@Module({
  imports: [
    LoggerModule.forRoot({ service: 'webhooks.merkaly.io' }), // global
    RabbitModule.forRoot({
      url: env.string('RABBITMQ_URL'), // sem url: emit rejeita com 503
      producer: MerkalyProducer.WEBHOOKS, // vai em todo evento
      timeout: env.number('RABBITMQ_PUBLISH_TIMEOUT', 5000),
      required: env.isProduction, // produção não sobe sem url
    }),
  ],
  providers: [{ provide: APP_FILTER, useClass: ExceptionsFilter }],
})
export class AppModule {}
```

`RabbitModule.forRootAsync({ imports, inject, useFactory })` aceita a config injetada.

**Exchange e filas**: o produtor publica no exchange topic `merkaly.events` com o tipo do evento como routing key e nunca conhece uma fila. Cada consumidor declara a sua fila, com o nome do repositório (`api.merkaly.io`, `payments.merkaly.io`), e o Nest a liga a cada tipo que ele escuta. Um consumidor novo não toca no produtor.

**Health check**: o pacote não registra controllers. O Swagger servido em `/` responde 200 e funciona como health check.

### Logger e requests

LEVEL, ORIGIN e SCOPE têm largura fixa (`-` quando falta o valor, `…` quando passa da largura), então a descrição (`KIND:: MESSAGE`) começa sempre na mesma posição:

```
             LEVEL   ORIGIN                   SCOPE                  KIND:: MESSAGE
08:02:05 657 DEBUG   api.merkaly.io           -                      MongoService:: connected
08:02:08 410 LOG     admin.merkaly.io         org_6sflVH0jykwUzj8z   OrderSaleRepository:: order created
08:02:08 410 LOG     admin.merkaly.io         org_6sflVH0jykwUzj8z   POST:: /admin/orders 201 15ms
08:02:08 423 WARN    203.0.113.7              -                      GET:: /wp-login.php 404 2ms "Cannot GET /wp-login.php"
08:02:08 439 ERROR   admin.merkaly.io         org_6sflVH0jykwUzj8z   GET:: /admin/boom 500 0ms "boom"
Error: boom
    at ...
```

- **ORIGIN** (24): quem fez o request, nas linhas de request e nos logs internos emitidos durante ele: `x-merkaly-host`, senão o host do `Origin`, `cf-connecting-ip`, o primeiro `x-forwarded-for` ou o socket (`requestOrigin`). Fora de um request, o `service`.
- **SCOPE** (22): contexto de negócio definido pelo app (`requestLogger({ scope })` ou `LoggerModule({ scope })`, ex.: id da organização). Nas linhas de request é resolvido ao terminar a resposta, então pega o que os guards definiram.
- **KIND::** abre a descrição, sem largura fixa (nunca é cortado): método HTTP nas linhas de request; nos logs internos, o `group` de quem loga. Com `requestLogger({ kind })` a linha de request usa esse valor (ex.: o evento do webhook) e o método passa para a descrição: `PAYMENT_RECEIVED:: POST /asaas 200 44ms`.
- **MESSAGE**: `/path STATUS Nms "motivo"` (motivo cortado em 200, sem query, body nem headers) ou o texto. Nível: `ERROR` em 5xx com o stack embaixo, `WARN` em 4xx, `LOG` no resto.

```ts
// main.ts
app.use(requestLogger(app)); // antes do Swagger; opcional { scope: (req) => 'stripe', kind: (req) => req.body?.event }
bodyParsers(app, { raw: ['/webhook/stripe'] }); // json + urlencoded com motivo seguro ("Invalid JSON body")
SwaggerModule.setup('/', app, document);
```

- `noteRequest(texto, nível?)` soma um resultado ao fim da linha do request (`-> payment.received`, `"discarded"`) em vez de uma linha separada; o nível só sobe (`warn`/`error`). Fora de um request devolve `false`. O `EventsPublisher` usa isso: dentro de um request o `emit` vira `-> <tipo>` na linha do request, fora dele continua com linha própria.
- O ORIGIN do request fica num `AsyncLocalStorage` do pacote (`requestContext`). O `requestLogger` cria o contexto e o `LoggerModule` registra um middleware que volta a entrar nele depois dos body parsers (que podem perder o contexto assíncrono), igual ao `nestjs-cls`.
- `bodyParsers(app, { raw?, rawBody? })`: `raw` mantém o body como Buffer nesses paths; `rawBody: true` preenche `req.rawBody` (igual ao `NestFactory.create(..., { rawBody: true })`, que deixa de registrar os próprios parsers).
- SCOPE com CLS, sem o pacote depender de `nestjs-cls`:

```ts
LoggerModule.forRootAsync({
  inject: [ClsService],
  useFactory: (cls: ClsService) => ({ service: 'api.merkaly.io', scope: () => cls.get('identity') }),
});
```

**Filtros**: o filtro não loga; guarda o motivo (e o stack de 5xx) em `response.locals` e o `requestLogger` imprime. `ExceptionsFilter` responde `{ statusCode, message, path, timestamp }`. Para filtros próprios, estender `AbstractExceptionFilter` (resposta padrão do Nest, sem o log duplicado do `ExceptionsHandler`) e usar `this.remember(response, motivo, trace?)` quando responder por conta própria.

### Eventos

Contrato completo em [`docs/events.md`](docs/events.md). Eventos de negócio normalizados (`payment.received`, nunca `asaas.payment_received`): se o provedor muda, o consumidor não muda.

```ts
// produtor: data tipado pelo tipo; resolve com o evento ou ServiceUnavailableException (o provedor reintenta)
await this.events.emit(MerkalyEventType.PAYMENT_RECEIVED, { ...paymentRef, receivedAt }, {
  id: `asaas:${body.id}`, source: 'asaas', organization, occurredAt, raw: { type: body.event, payload },
});
```

Consumidor:

```ts
// main.ts
const consumer = { url, queue: 'api.merkaly.io' };
await assertConsumerTopology(consumer); // cria .retry e .dlq
app.connectMicroservice(rabbitConsumerOptions(consumer));
await app.startAllMicroservices();

// módulo: `around` roda cada mensagem dentro do contexto do app (ex.: CLS com a organização)
RabbitModule.forConsumerAsync({
  inject: [ClsService],
  useFactory: (cls: ClsService) => ({
    queue: 'api.merkaly.io',
    around: (event, next) => cls.run(() => { cls.set('identity', event.organization); return next(); }),
  }),
});

// handler
@OnMerkalyEvent(MerkalyEventType.PAYMENT_RECEIVED)
received(@Payload() event: MerkalyEvent<MerkalyEventType.PAYMENT_RECEIVED>, @Ctx() context: RmqContext) {
  return this.consumer.handle(event, context, (e) => this.payments.refresh(e.data.saleId));
}
```

`@OnMerkalyEvent(...types)` aceita vários tipos no mesmo handler. `EventsConsumer.handle` fecha a mensagem e loga uma linha (`ORIGIN` = provedor, `SCOPE` = organização, `KIND` = `EVENT`):

| Resultado | O que acontece |
| --- | --- |
| Sucesso | `ack`. |
| `EventRejectedException` (venda inexistente, valor diferente...) | `ack` + `WARN`: reintentar não resolve. |
| Outro erro (Mongo, rede, provedor fora) | Vai para `<fila>.retry` (30 s) e volta; depois de 5 tentativas, `<fila>.dlq`. |
| Malformado ou `version` maior que a do handler | `<fila>.dlq` direto. |

A fila principal descarta para a `.dlq` o que ficar 7 dias sem consumo ou passar de 10.000 mensagens.

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
