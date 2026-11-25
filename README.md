# @merkaly/nest

Pacote compartilhado dos backends NestJS da Merkaly (api, webhooks, signals, payments). Faz duas coisas:

1. **Fonte única de versões**: fixa `@nestjs/*` (versão exata, todos os serviços rodam a mesma), rxjs, amqplib, class-validator, dotenv e também o tooling de desenvolvimento (ESLint, Prettier, TypeScript, typescript-eslint, Nest CLI, ts-node, `@types/node`).
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
    "@merkaly/nest": "^0.5.0"
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
  noIndex, // X-Robots-Tag noindex + /robots.txt bloqueando buscadores
  AbstractExceptionFilter, ExceptionsFilter, rememberError, // filtros (motivo do erro para o log)
  RabbitModule, EventsPublisher, EventsConsumer, EventRejectedException, UnroutableMessageException, // mensagens
  rabbitQueue, rabbitInvokes, HandleEvent, HandleCommand, HandleInvoke, // consumidores
  exchangeName, queueName, invokesQueueName, RabbitNameError, // nomes por convenção
  MerkalyEvent, MerkalyInvoke, createMerkalyEvent, AliexpressOrderStatus, PaymentRef, // sobre e tipos de data
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
      service: 'webhooks', // producer de toda mensagem; exchange merkaly.webhooks só no primeiro emit
      timeout: env.number('RABBITMQ_PUBLISH_TIMEOUT', 5000),
      required: env.isProduction, // produção não sobe sem url
    }),
  ],
  providers: [{ provide: APP_FILTER, useClass: ExceptionsFilter }],
})
export class AppModule {}
```

`RabbitModule.forRootAsync({ imports, inject, useFactory })` aceita a config injetada. O `service` é validado no boot (`^[a-z][a-z0-9-]*$`).

**Exchange e filas**: cada dono de domínio tem o seu exchange topic `merkaly.<serviço>` e publica nele os seus eventos (declarado no primeiro `emit`, nunca ao conectar); eventos entregues, comandos e invokes vão para o exchange do destino. Um gateway (webhooks) não tem exchange próprio: entrega cada mensagem de provedor no exchange do dono com `deliver`. Cada serviço declara as suas filas, uma por trabalho (`merkaly.api-payments`, `merkaly.signals-emails`), ligadas com chaves exatas (nunca `#`) a um ou mais exchanges. Um consumidor novo não toca no produtor, mas precisa existir antes: toda publicação usa `mandatory` e falha se nenhuma fila liga a chave. Modelo completo em [`docs/events.md`](docs/events.md).

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
- **MESSAGE**: `/path STATUS Nms "motivo"` (motivo cortado em 200, sem query, body nem headers) ou o texto. Nível: `ERROR` em 5xx com o stack embaixo, `WARN` em 4xx, `LOG` no resto, `DEBUG` em 404 sem rota (scanners e bots).

**Nível mínimo** (`LOG_LEVEL`): imprime o nível escolhido e os mais graves, na ordem do Nest `verbose < debug < log < warn < error`. Padrão `log` em produção (`NODE_ENV=production`, sem `DEBUG` nem `VERBOSE`) e `debug` fora dela. Valor inválido não derruba o boot: usa o padrão e avisa com um `WARN`. Vale também para as linhas do `requestLogger` (o 404 de scanner some em produção) e do RabbitMQ.

```bash
LOG_LEVEL=debug   # diagnóstico temporário em produção
LOG_LEVEL=warn    # só WARN e ERROR
```

**Saída**: `ERROR` e stacks vão para stderr (`console.error`), `WARN` para `console.warn` (stderr) e o resto para stdout. Cor só com TTY (detectada pelo `chalk`), então os logs do Railway saem sem ANSI; `FORCE_COLOR=1` força a cor e `FORCE_COLOR=0` a desliga.

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

### Mensagens

Contrato completo e catálogo em [`docs/events.md`](docs/events.md). Mensagens de negócio normalizadas (`payment.received`, nunca `asaas.payment_received`): se o provedor muda, o consumidor não muda. O `type` é uma string do catálogo (pontos, minúsculas, validada no boot); o pacote não exporta enums de serviços nem de mensagens, só os tipos de `data` (`PaymentRef`, `SupplierOrderStatusChanged`, `IdentitySignupRequested`...).

| Classe | Publica | Exchange | Handler | Resposta |
| --- | --- | --- | --- | --- |
| Evento | `emit(type, data, meta?)` | o próprio | `@HandleEvent(type, { queue, from })` | não |
| Evento entregue (gateway) | `deliver(service, type, data, meta?)` | o do dono | `@HandleEvent(type, { queue, from })` | não |
| Comando | `command(service, type, data, meta?)` | o do destino | `@HandleCommand(type, { queue })` | não |
| Invoke | `invoke(service, type, data, { timeout, ...meta })` | o do destino | `@HandleInvoke(type)` | sim |

```ts
// produtor: resolve com o evento quando o broker confirmou e roteou; senão ServiceUnavailableException
// (UnroutableMessageException se nenhuma fila liga o tipo). O provedor recebe 503 e reenvia.
await this.events.emit('account.user.linked', { from, to });

// gateway: o fato do provedor vai para o exchange do dono (merkaly.payments), não para um próprio
await this.events.deliver('payments', 'payment.received', { ...paymentRef, receivedAt }, {
  id: `asaas:${body.id}`, source: 'asaas', organization, occurredAt, raw: { type: body.event, payload },
});

await this.events.command('signals', 'email.send', { to, subject, text }, { id: notification.id });
```

Consumidor:

```ts
// main.ts: um servidor por fila, cada um com o seu transport id
const rabbit = { url, service: 'api', logger: app.get(LoggerService) };
app.connectMicroservice(rabbitQueue({ ...rabbit, queue: 'payments' })); // merkaly.api-payments (+ .retry, .dlq)
app.connectMicroservice(rabbitQueue({ ...rabbit, queue: 'identity', retries: 5, retryDelay: 30_000 }));
app.connectMicroservice(rabbitInvokes(rabbit)); // merkaly.api-invokes
await app.startAllMicroservices();

// módulo: `around` roda cada mensagem dentro do contexto do app (ex.: CLS com a organização)
RabbitModule.forConsumerAsync({
  inject: [ClsService],
  useFactory: (cls: ClsService) => ({
    around: (event, next) => cls.run(() => { cls.set('identity', event.organization); return next(); }),
    inbox: { has: (entry) => inbox.has(entry), add: (entry) => inbox.add(entry) }, // opcional: dedupe por { queue, eventId }
    onDeadLetter: (letter) => alerts.notify(letter), // opcional: alerta, depois da linha ERROR [DLQ]
  }),
});

// handler (controller): chaves exatas; várias chaves e decoradores empilhados na mesma fila
@HandleEvent(['payment.confirmed', 'payment.received'], { queue: 'payments', from: 'payments' })
payment(@Payload() event: MerkalyEvent<PaymentRef>, @Ctx() context: RmqContext) {
  return this.consumer.handle(event, context, (e) => this.payments.refresh(e.data.paymentId));
}

@HandleEvent('identity.signup.requested', { queue: 'identity', from: 'auth' }) // entregue por webhooks
@HandleEvent('account.user.linked', { queue: 'identity', from: 'api' }) // dois exchanges, uma fila
identity(@Payload() event: MerkalyEvent, @Ctx() context: RmqContext) { ... }
```

Os handlers ficam em controllers. A mesma chave duas vezes na mesma fila derruba o boot (o Nest rodaria os dois e haveria ack duplo). `EventsConsumer.handle` fecha a mensagem e loga uma linha (`ORIGIN` = serviço que publicou, ex. `webhooks`, `SCOPE` = organização, `KIND` = `EVENT`):

| Resultado | O que acontece |
| --- | --- |
| Sucesso | `ack`. |
| `EventRejectedException` (venda inexistente, valor diferente...) | `ack` + `WARN`: reintentar não resolve. |
| Outro erro (Mongo, rede, provedor fora) | Cópia em `<fila>.retry` (30 s) e `ack` só depois da confirmação do broker; se a cópia falha, `nack` com requeue. Depois de 5 tentativas, `<fila>.dlq`. |
| Malformado ou `version` maior que a do handler | `<fila>.dlq` direto. |
| Já processado (com `inbox`) | `ack` sem rodar o handler. |
| Sem handler para a chave ou `pattern` diferente da routing key | `<fila>.dlq` (nunca `ack` silencioso). |

Todo descarte para a `.dlq` loga uma linha `ERROR` no grupo `DLQ`. A fila principal descarta para a `.dlq` o que ficar 7 dias sem consumo; o limite de 10.000 mensagens e a `.dlq` de 14 dias vêm das operator policies do broker (`docs/events.md`, "Límites y políticas del broker").

### Invoke (request-reply)

Para quem precisa de uma resposta na hora (ex. webhooks responde ao Asaas se um saque é aprovado).

```ts
// quem pergunta: resolve com o retorno do handler; GatewayTimeoutException sem resposta no prazo,
// ServiceUnavailableException se o handler falhou ou o broker não está disponível,
// UnroutableMessageException se ninguém liga o tipo
const answer = await this.events.invoke<Req, Res>('api', 'payment.withdrawal.authorize', data, { timeout: 3000 });

// handler (controller) de quem responde: o retorno é a resposta
@HandleInvoke('payment.withdrawal.authorize')
authorize(@Payload() invoke: MerkalyInvoke<Req>): Promise<Res> { ... }
```

- Fila `merkaly.<serviço>-invokes` no exchange de quem responde, `noAck`, sem `.retry` nem `.dlq`, TTL 30 s. Um invoke perdido vira timeout em quem perguntou.
- Resposta via direct reply-to (`amq.rabbitmq.reply-to`) com `correlationId`.
- O sobre leva `expiresAt` e a mensagem `expiration` = timeout: vencido, o broker e o servidor o descartam (`WARN expired, dropped`).
- Uma linha por invoke em quem responde (`INVOKE:: <tipo> (<id>) ok 12ms`). Dentro de um request HTTP, quem pergunta soma `=> <tipo> 12ms` à linha do request.
- O handler roda fora do contexto do app (sem CLS, guards nem interceptors globais): abre o próprio (`cls.run`) se precisar.

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

Release: tag `vX.Y.Z` (ou prerelease `vX.Y.Z-rc.N`) publica no npm com essa versão; o `package.json` do master fica em `0.0.0`.
