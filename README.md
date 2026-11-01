# @merkaly/nest

Runtime compartilhado dos backends NestJS da Merkaly (api, webhooks, payments). Este repositório publica dois pacotes, sempre com a mesma versão:

| Pacote | Onde entra no app | Conteúdo |
| --- | --- | --- |
| `@merkaly/nest` | `dependencies` | versões de `@nestjs/*`, rxjs, amqplib, class-validator, dotenv... e a infraestrutura comum (RabbitMQ, logger, filtro, health, env, assinaturas) |
| `@merkaly/nest-tooling` | `devDependencies` | ESLint 9, Prettier, TypeScript, tsconfig base/build, Nest CLI, ts-node |

Proposta e motivação: [docs/proposal.md](docs/proposal.md).

## Regra de versões

- O app **nunca** declara pacotes que `@merkaly/nest` ou `@merkaly/nest-tooling` já fornecem (`@nestjs/common`, `@nestjs/core`, `@nestjs/microservices`, `@nestjs/platform-express`, `rxjs`, `amqplib`, `class-validator`, `dotenv`, `eslint`, `typescript`...). Eles chegam ao app pelo `shamefully-hoist`.
- Tudo o que o app importa e **não** está nesses pacotes (ex.: `mongoose`, `stripe`, `express`, `@nestjs/mongoose`) é declarado no próprio app. Nunca dependa de um pacote transitivo que não esteja na lista.

## Uso em um app

`.npmrc`

```ini
shamefully-hoist=true
strict-peer-dependencies=false
```

`package.json`

```json
{
  "scripts": {
    "build": "nest build",
    "dev": "nest start --watch --no-shell",
    "lint": "eslint \"src/**/*.ts\" --fix",
    "format": "prettier --write \"src/**/*.ts\"",
    "start": "node dist/main"
  },
  "prettier": "@merkaly/nest-tooling/prettier",
  "dependencies": {
    "@merkaly/nest": "^0.2.0"
  },
  "devDependencies": {
    "@merkaly/nest-tooling": "^0.2.0"
  }
}
```

`eslint.config.mjs`

```js
import { createConfig } from '@merkaly/nest-tooling/eslint';

export default createConfig({ tsconfigRootDir: import.meta.dirname }); // opcional: ignores, rules
```

`tsconfig.json` e `tsconfig.build.json`

```json
{ "extends": "@merkaly/nest-tooling/tsconfig.base.json" }
```

```json
{ "extends": ["./tsconfig.json", "@merkaly/nest-tooling/tsconfig.build.json"] }
```

O build compila `src/` para `dist/` (`rootDir`/`outDir` usam `${configDir}`). Opções próprias (ex.: `paths`, `rootDir: "./"` no api) ficam no `tsconfig.json` do app. O `nest-cli.json` continua no app (5 linhas, o Nest CLI não suporta `extends`).

## API

```ts
import {
  env, loadEnv, // config
  LoggerModule, LoggerService, // logger
  ExceptionsFilter, // filtro HTTP JSON global
  HealthModule, // GET /health
  RabbitModule, EventsPublisher, rabbitConsumerOptions, OnRabbitEvent, ackMessage, nackMessage,
  WebhookEvent, WebhookPatterns, WebhookPattern, createWebhookEvent, toPattern,
  SignatureGuard, safeCompare, hmacDigest, verifyHmac,
} from '@merkaly/nest';
```

### Módulos

```ts
@Module({
  imports: [
    LoggerModule.forRoot(), // global; opcional: { host: () => cls.get('host') }
    RabbitModule.forRoot({
      url: env.string('RABBITMQ_URL'), // sem url: publish rejeita com 503
      queue: env.string('RABBITMQ_QUEUE', 'api_queue'),
      routes: { [WebhookPatterns.asaas.PAYMENT_CONFIRMED]: 'payments_queue' }, // opcional
      timeout: env.number('RABBITMQ_PUBLISH_TIMEOUT', 5000),
      required: env.isProduction, // produção não sobe sem url
    }),
    HealthModule, // inclui o status do broker se RabbitModule estiver importado
  ],
  providers: [{ provide: APP_FILTER, useClass: ExceptionsFilter }],
})
export class AppModule {}
```

`RabbitModule.forRootAsync({ imports, inject, useFactory })` aceita a config injetada.

### Eventos

Envelope `WebhookEvent<T>`: `{ id, source, type, receivedAt, organization?, data }`. Padrão do nome: `<source>.<evento>` em minúsculas (`toPattern('asaas', 'PAYMENT_CONFIRMED')` = `asaas.payment_confirmed`). Os padrões conhecidos ficam em `WebhookPatterns` (Asaas, Stripe, Auth0, AliExpress) e são a fonte única para produtores e consumidores.

```ts
await this.events.publish(
  WebhookPatterns.asaas.PAYMENT_CONFIRMED,
  createWebhookEvent({ id: body.id, source: 'asaas', type: body.event, data: body.payment }),
); // resolve só com ack do broker; timeout ou falha: ServiceUnavailableException
```

Consumidor (quando o api ou o payments passarem a consumir):

```ts
app.connectMicroservice(rabbitConsumerOptions({ url, queue: 'payments_queue' }));
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

Release: tag `vX.Y.Z` publica os dois pacotes (versões em `package.json` e `tooling/package.json` devem bater com a tag).
