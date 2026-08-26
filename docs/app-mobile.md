# App para celular: o que reusa, o que falta, e por onde começar

Levantamento feito para responder uma pergunta específica: **o que custaria ter o
InvestRadar no celular como aplicativo, e não como site aberto no navegador?**

Não é um plano aprovado nem uma decisão tomada. É o estado medido do repositório em
agosto de 2026, para que a conversa sobre isso comece de um lugar informado em vez de
recomeçar o levantamento.

---

## A conclusão que muda o resto

**Um app nativo aqui é uma vista nova, não um app novo.** Todo motor de decisão vive no
servidor — conciliação de nota, faixa de entrada, portão `AGUARDAR`, número mágico,
alocação-alvo, IR de vendas. Nada disso seria reescrito. O que se constrói é a camada que
mostra, e ela conversa com a API que já existe.

Isso é uma consequência de uma escolha antiga do projeto, não sorte: motor decide, IA
narra, e o cliente só apresenta. Um cliente novo herda tudo.

---

## O que já está pronto, e não por acaso

O cliente HTTP gerado (`lib/api-client-react/src/custom-fetch.ts`) **foi escrito prevendo
um cliente nativo**. Não é interpretação; está declarado:

```ts
/**
 * Set a base URL that is prepended to every relative request URL...
 * Useful for Expo bundles that need to call a remote API server.
 */
export function setBaseUrl(url: string | null): void

/**
 * Register a getter that supplies a bearer auth token...
 * Useful for Expo bundles making token-gated API calls.
 *
 * NOTE: This function should never be used in web applications where session
 * token cookies are automatically associated with API calls by the browser.
 */
export function setAuthTokenGetter(getter: AuthTokenGetter | null): void
```

E o parser de resposta carrega contornos explícitos de React Native — casos em que o
runtime se comporta diferente do navegador e que só aparecem em produção:

- `response.body` vem `undefined` em RN mesmo quando há corpo, porque `ReadableStream` não
  está implementado. Por isso o teste de corpo vazio usa `=== null` estrito e não `== null`:
  a comparação frouxa trataria **toda** resposta de RN como vazia.
- `response.blob()` pode não existir; há fallback para `.text()`.
- `instanceof URL` pode falhar com o polyfill de RN; a checagem é frouxa de propósito.

Ou seja: a camada de API é reusável **hoje**, gerada do mesmo `openapi.yaml` por
`pnpm --filter @workspace/api-spec run codegen`. Uma mudança de contrato continua
propagando para os dois clientes de uma vez, que é o que impede eles divergirem.

`@workspace/api-client-react` depende só de `@tanstack/react-query` e tem `react >= 18`
como peer — nada preso ao DOM no `package.json`.

---

## A lacuna, e é uma só

**A autenticação é por cookie de sessão, e não existe caminho por token.**

```ts
// artifacts/api-server/src/middlewares/auth.ts
export function requireAuth(req, res, next): void {
  if (!req.session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}
```

Uma busca por `Bearer` ou `authorization` nas rotas e middlewares não devolve nada fora do
`internal-auth.ts`, que é o token de job e não serve para usuário.

Então `setAuthTokenGetter` manda um cabeçalho que **ninguém lê**. Um app nativo precisa que
o servidor ganhe autenticação por token. É trabalho delimitado, mas mexe em segurança e
merece cuidado — as notas abaixo existem para isso.

### O que já está resolvido e não pode ser perdido no caminho

O login atual faz uma coisa que um caminho por token precisa preservar em espírito:

```ts
// ID de sessão novo antes de autenticar: sem isto, um ID de sessão fixado por um
// atacante ANTES do login continuava o mesmo depois — e viraria uma sessão
// autenticada que o atacante já conhecia.
await regenerateSession(req);
req.session.userId = user.id;
```

Fixação de sessão não se aplica a token emitido no login (o token nasce ali), mas o
princípio vale: **credencial usada antes de autenticar nunca vira credencial autenticada**.

Há também `loginRateLimiter` (10 tentativas por IP a cada 15 min, sucesso não conta) e
`registerRateLimiter`. Um endpoint de token é mais uma porta para força bruta e precisa do
mesmo limite — esquecer isso abriria por fora o que está fechado por dentro.

### Desenho sugerido, com o que decidir

Nada aqui está decidido; são as escolhas que a implementação vai ter de fazer.

1. **Refresh + access, ou token único de vida longa?** Token único é mais simples e é
   revogável se ficar no banco; par refresh/access é o padrão, e o custo é uma tabela e
   uma rota a mais. Com um usuário só, o simples provavelmente ganha.

2. **Onde o token vive.** Precisa de tabela nova (`user_tokens`), com hash do token e não
   o token em claro — mesma lógica de `password_hash` em `users`. Guardar em claro
   transformaria um vazamento de leitura do banco em acesso a todas as contas.

3. **Onde o app guarda.** `expo-secure-store` (Keychain/Keystore), nunca `AsyncStorage`.

4. **Como convive com o cookie.** O web continua no cookie — ele funciona, é
   same-origin, e trocá-lo por token no navegador só acrescentaria superfície de XSS. O
   `requireAuth` passa a aceitar **os dois**, na ordem: sessão presente vence; senão, lê o
   Bearer. Um caminho não pode enfraquecer o outro.

5. **Revogação e expiração.** Logout no app tem de invalidar do lado do servidor, não só
   apagar localmente. Sem isso "sair" não sai.

---

## Três caminhos

| Caminho | Custo | Ganha | Não ganha |
|---|---|---|---|
| **PWA** | dias | ícone na tela inicial, abre em tela cheia, offline básico | loja, push no iOS, integração com o sistema |
| **Capacitor** | semana | presença nas lojas com o mesmo código web | comportamento nativo de verdade |
| **React Native / Expo** | semanas | push, compartilhamento, biometria, offline real | — (mas exige o token acima) |

Hoje **não existe PWA**: `artifacts/carteira/public/` tem só `favicon.svg` e `robots.txt`,
sem manifest nem service worker, e o `vite.config.ts` não tem plugin de PWA.

### A recomendação

**Comece pelo PWA.** Custa pouco, não mexe em autenticação, funciona nos dois sistemas, e
responde a maior parte de "quero no celular" — que na prática costuma ser "quero abrir sem
digitar endereço".

Vá para nativo quando existir algo que o navegador não faz. E aqui existem dois candidatos
concretos, os dois nascidos de atrito real:

- **Notificação push para os alertas do Radar.** Hoje o Radar só é visto por quem abre o
  app. Um alerta de concentração ou de queda que ninguém vê é um alerta que não existe. No
  iOS, push confiável exige app nativo.
- **Receber PDF pelo menu de compartilhar.** Mandar a nota direto do app da corretora para
  o InvestRadar. Isso resolve exatamente o atrito que apareceu na primeira importação real:
  o seletor de arquivos do Android deixa escolher **um arquivo por vez**, e a tela teve de
  ser refeita para acumular seleções (ver `pages/importar.tsx`). O menu de compartilhar
  contorna o seletor inteiro.

O segundo é o argumento mais forte, porque a importação é justamente a funcionalidade em
que o celular é o lugar natural: o PDF chega no celular, não no computador.

---

## O que NÃO refazer

Registro explícito, porque a tentação numa base nova é reimplementar o que parece simples:

- **Nenhum motor.** Todos são server-side e já expostos por HTTP.
- **Nenhuma regra de convenção da B3.** `kindFromTicker` e `categoryConflict` decidem
  categoria a partir do sufixo, e a segunda cópia divergiria da primeira em silêncio.
- **Nenhum parser de PDF.** A leitura acontece no servidor (`/portfolio/import/preview`);
  o app manda o arquivo.
- **Nenhum rótulo de categoria.** `CATEGORY_LABELS` já existe e já foi consolidado uma vez
  justamente porque estava duplicado em três telas, e uma das cópias mostrava a chave crua
  do banco na tela.
- **Nenhum tipo escrito à mão.** Tudo sai do `openapi.yaml` pelo orval.

---

## Por onde uma sessão nova começa

O conhecimento deste projeto está no repositório, não no histórico de conversa. Na ordem:

1. `docs/funcionalidades.md` — as doze telas e a pergunta que cada uma responde
2. `docs/decision-engine.md` — os motores e, mais importante, **o que eles se recusam a
   afirmar**
3. Os docstrings dos módulos — é onde mora o *porquê* de cada regra, incluindo as ideias
   que foram derrubadas por medição
4. `lib/api-spec/openapi.yaml` — o contrato inteiro
5. Este arquivo

A regra da casa que atravessa tudo: **medir com dado real antes de desenhar, e mudar o
desenho quando a medição contradiz.** Várias regras deste projeto existem exatamente
assim — e várias ideias razoáveis morreram no mesmo teste.
