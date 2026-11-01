# Proposta: @merkaly/nest como biblioteca de infraestrutura (0.2.0)

## Problema hoje

- `@merkaly/nest` 0.1.x não tem código (`export {}`). Só agrupa dependências.
- Mistura runtime e tooling: ESLint, Prettier, TypeScript, Nest CLI e ts-node viajam como `dependencies` e entram no install de produção de todo app.
- Cada serviço novo (webhooks, payments) reimplementa logger, filtro, health, cliente RabbitMQ e verificação de assinatura, e repete ~20 devDependencies com versões que divergem (o scaffold do webhooks já declara `@nestjs/*`, `rxjs`, `amqplib` por conta própria).
- Não existe contrato compartilhado de eventos: produtor (webhooks) e consumidores (payments, api) teriam que combinar nomes de padrão à mão.

## Decisões

1. **Fonte única de versões.** `@merkaly/nest` fixa as versões de `@nestjs/*` e das libs de runtime; os apps recebem tudo via `shamefully-hoist`. Nest continua em `dependencies` (sem peerDependencies). Regra: o app nunca declara um pacote fornecido por `@merkaly/nest` ou `@merkaly/nest-tooling`; o que ele importa e não está nesses pacotes (dotenv fora do helper, mongoose, stripe, express...) é declarado no app, nunca usado de forma transitiva.
2. **Tooling em pacote separado, no mesmo repo: `@merkaly/nest-tooling`** (pasta `tooling/`, workspace pnpm, mesma versão e mesma tag).
   - Por que não um subpath `@merkaly/nest/tooling`: um subpath compartilha as `dependencies` do pacote, então ESLint/TypeScript continuariam entrando no install de produção. Só um pacote separado em `devDependencies` deixa a produção enxuta.
   - Custos: dois pacotes para publicar (o workflow de release publica os dois na mesma tag) e o primeiro publish do `@merkaly/nest-tooling` precisa configurar o trusted publisher no npm.
   - Conteúdo: `createConfig()` do ESLint 9 (igual ao config atual do api), Prettier (printWidth 100, singleQuote, trailingComma all), `tsconfig.base.json` e `tsconfig.build.json` com `${configDir}`, Nest CLI + schematics, TypeScript, ts-node, tsconfig-paths, `@types/node`, `@types/express`.
   - Sem Jest por enquanto (regra do Founder: sem specs nos serviços backend, alinhado ao #38). Quando voltar, entra como preset no tooling.
3. **Infraestrutura compartilhada** (genérica, config injetada, sem constantes de app). Nomes e assinaturas copiados do scaffold do webhooks (PR #1) para a troca ser quase só de import:
   - `RabbitModule.forRoot/forRootAsync` + `EventsPublisher.publish(pattern, event)`: `ClientProxy` `Transport.RMQ`, fila durável, mensagem persistente, resolve só com ack do broker, timeout configurável, `ServiceUnavailableException` em falha, rotas `pattern -> fila`, `required` derruba o boot sem url.
   - Consumo (para depois): `rabbitConsumerOptions()`, `@OnRabbitEvent()`, `ackMessage()`, `nackMessage()`.
   - Contrato: `WebhookEvent<T>` `{ id, source, type, receivedAt, organization?, data }`, padrão `<source>.<evento>`, `toPattern()`, `createWebhookEvent()` e o registro tipado `WebhookPatterns` (Asaas pagamentos, Stripe assinatura/fatura, Auth0 usuário, AliExpress pedido).
   - `LoggerModule`/`LoggerService` (padrão do api, `host` opcional para o CLS), `ExceptionsFilter` JSON, `HealthModule` (`GET /health`, inclui broker se houver `RabbitModule`), `env` (dotenv + getters tipados, erro em produção quando falta obrigatório), assinaturas (`safeCompare`, `hmacDigest`, `verifyHmac`, `SignatureGuard`).
4. **Versão 0.2.0** (minor, quebra: tooling sai das dependências). Sem publicar até o OK do Founder.

## Layout

```
package.json            @merkaly/nest (runtime)
pnpm-workspace.yaml     packages: [tooling]
src/
  config/   env, loadEnv
  events/   WebhookEvent, toPattern, createWebhookEvent, WebhookPatterns
  filters/  ExceptionsFilter
  health/   HealthModule, HealthController
  logger/   LoggerModule, LoggerService
  rabbit/   RabbitModule, EventsPublisher, consumidor
  signature/ SignatureGuard, safeCompare, hmacDigest, verifyHmac
tooling/
  package.json          @merkaly/nest-tooling (dev)
  eslint.mjs  prettier.json  tsconfig.base.json  tsconfig.build.json
```

## Como um app consome

```json
{
  "prettier": "@merkaly/nest-tooling/prettier",
  "dependencies": { "@merkaly/nest": "^0.2.0" },
  "devDependencies": { "@merkaly/nest-tooling": "^0.2.0" }
}
```

```js
// eslint.config.mjs
import { createConfig } from '@merkaly/nest-tooling/eslint';
export default createConfig({ tsconfigRootDir: import.meta.dirname });
```

```json
// tsconfig.json / tsconfig.build.json
{ "extends": "@merkaly/nest-tooling/tsconfig.base.json" }
{ "extends": ["./tsconfig.json", "@merkaly/nest-tooling/tsconfig.build.json"] }
```

```ts
imports: [
  LoggerModule.forRoot(),
  RabbitModule.forRoot({ url: env.string('RABBITMQ_URL'), queue: 'api_queue', required: env.isProduction }),
  HealthModule,
],
providers: [{ provide: APP_FILTER, useClass: ExceptionsFilter }],
```

Mais detalhes no [README](../README.md).

## Migração

**webhooks.merkaly.io** (primeiro, ainda no PR #1):
1. `@merkaly/nest` `^0.2.0` + `@merkaly/nest-tooling` `^0.2.0`; remover das deps `@nestjs/common|core|microservices|platform-express`, `amqplib`, `amqp-connection-manager`, `chalk`, `class-*`, `dotenv`, `reflect-metadata`, `rxjs`, e das devDeps ESLint/Prettier/TypeScript/Nest CLI/ts-node/@types.
2. Trocar `eslint.config.mjs`, `.prettierrc` e tsconfigs pelos extends acima.
3. Apagar `src/infrastructure/{events,logger,filters,health,signature}` e importar de `@merkaly/nest`. Renomes: `EventsModule` -> `RabbitModule`, `EventsModuleOptions` -> `RabbitModuleOptions`, `EVENTS_*` -> `RABBIT_*`. `EventsPublisher`, `WebhookEvent`, `toPattern`, `createWebhookEvent`, `ExceptionsFilter`, `LoggerService`, `SignatureGuard` e helpers mantêm nome e assinatura. `WebhookRequest` vira tipo estrutural (sem express).
4. `AppConfig.RABBITMQ` pode usar `env.*`; publicar com `WebhookPatterns.*` em vez de strings.

**payments.merkaly.io** (quando for ativado): mesmo passo 1 e 2; consumir com `rabbitConsumerOptions` + `@OnRabbitEvent(WebhookPatterns.asaas.*)` + `ackMessage`.

**api.merkaly.io** (depois, sem pressa):
1. Bump para `^0.2.0` e adicionar `@merkaly/nest-tooling` em devDependencies (hoje ESLint/TS chegam pelo runtime; sem isso o lint/build quebra).
2. Remover `chalk` das deps; declarar `dotenv` só se continuar importando direto.
3. Configs por extends; o api mantém `rootDir: "./"` e `paths` próprios no `tsconfig.json` (tem `app.ts` na raiz e roda `dist/src/main`).
4. Opcional: trocar o `LoggerService` próprio pelo do pacote com `host` do CLS; o bootstrap Rabbit comentado vira `rabbitConsumerOptions` quando o consumo for aprovado.

erp.merkaly.io e fiscal estão deprecados e ficam fora.

## Riscos

- **Hoisting implícito**: depende de `shamefully-hoist=true` em cada app; sem isso imports de `@nestjs/*` quebram. Mitigação: `.npmrc` no template dos apps.
- **Quebra no api ao subir para 0.2.0** sem adicionar o tooling (lint/build sem ESLint/TS). Mitigação: passo 1 da migração no mesmo PR.
- **Nest 12** já existe (`@nestjs/common` 12.3.x); este pacote fica em 11.2.x. O salto para 12 vira uma release separada e testada no api.
- **Primeiro publish do tooling**: o trusted publishing (OIDC) do npm precisa do pacote configurado; pode exigir um publish manual inicial.
- **AliExpress**: o padrão `aliexpress.order_status_changed` é provisório até mapearmos o tipo real da notificação DS.
- **Sem testes** no pacote (decisão atual); a validação é lint, build, `pack` e um app descartável que sobe com os presets e o `RabbitModule`.
