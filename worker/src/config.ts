/**
 * Identidade e tunáveis do Worker de borda do sih-br-mcp — instância do template
 * de hosting da Fase 0 (mcp-br-commons/templates/cloudflare-worker). Os demais
 * módulos leem daqui.
 *
 * A versão vem do package.json da RAIZ do repositório, a única fonte de verdade
 * de versão (é o mesmo arquivo que src/provenance.ts lê para o SERVER_VERSION do
 * handshake). O Worker não importa `dist/` da raiz: o servidor de verdade roda
 * no container, e o que este processo precisa saber dele cabe num JSON.
 */

import pkg from "../../package.json" with { type: "json" };

export const SERVER_CONFIG = {
  /** Nome curto do servidor (/status, landing, server card). Igual a SERVER_NAME em ../src/server.ts. */
  name: "sih-br-mcp",
  /** Versão do servidor — única fonte: package.json da raiz. */
  version: pkg.version as string,
  /** Título de exibição. Mesmo texto de SERVER_TITLE (../src/server.ts) e do server.json. */
  title: "SIH/SUS Brasil MCP",
  /** Uma frase: o que o servidor serve e de qual fonte. */
  description:
    "Servidor MCP das internações hospitalares do SUS (SIH/SUS, 1992–2025): causas, " +
    "séries mensais, ICSAP e taxas por 100 mil, a partir dos cubos públicos do healthbr-data.",
  /**
   * Contato exibido na landing page. A URL raiz do Worker é o que sysadmins
   * upstream veem — precisa resolver para identificação humana + contato.
   */
  contactEmail: "sbissoli76@gmail.com",
  /** Site do servidor: o DOMÍNIO PRÓPRIO, não o repositório (é o que o server.json declara). */
  websiteUrl: "https://sih.sidneybissoli.com",
  /** Repositório do código-fonte (server card, landing, JSON-LD). */
  repositoryUrl: "https://github.com/SidneyBissoli/sih-br-mcp",
  /**
   * Chave do IndexNow. É PÚBLICA por desenho: ela prova posse do domínio por
   * estar servida em `/<chave>.txt`, então versionar aqui não é vazamento.
   */
  indexNowKey: "c1f3a8d9b2e64f07a5d1c9e8b3f24a61",
  /** Rota do endpoint MCP (Streamable HTTP) — a mesma que o container serve (MCP_PATH em ../src/http.ts). */
  mcpRoute: "/mcp",
  /**
   * Hostnames aceitos no header Host do /mcp (spec MCP 2025-11-25: o servidor
   * valida Host e Origin contra DNS rebinding; 403 se inválido). O container
   * NÃO valida — este é o único lugar. Porta é ignorada na comparação.
   */
  allowedHostnames: [
    "sih.sidneybissoli.com",
    "sih-br-mcp-edge.sidneybissoli.workers.dev",
    "localhost",
    "127.0.0.1",
  ] as readonly string[],
} as const;

/**
 * Instância do container. UMA por desenho (max_instances: 1 no wrangler.jsonc):
 * o cache de cubos no disco efêmero é compartilhado por todos os clientes e o
 * custo fica previsível (PLAN-004 §3). Trocar o nome aqui cria outra instância.
 */
export const CONTAINER_INSTANCE = "sih-1";

/** Tempo máximo da sonda do /healthz do container em GET /health (ms). */
export const HEALTH_PROBE_TIMEOUT_MS = 3_000;

/**
 * As doze ferramentas do servidor — nome e título copiados de ../src/tools.ts
 * (campos `name` e `title` do array `tools`). O teste tests/tools-sync.test.ts
 * compara esta lista com o fonte da raiz: se uma ferramenta entra ou sai lá,
 * o teste reprova aqui. Alimenta a landing page; o server card pergunta ao
 * container (fonte viva) e só cai nesta lista quando ele não responde.
 */
export const TOOLS = [
  { name: "list_csap_groups", title: "Grupos CSAP (Portaria 221/2008)" },
  { name: "list_cid_chapters", title: "Capítulos da CID-10" },
  { name: "get_available_years", title: "Anos disponíveis e frescor dos cubos" },
  { name: "get_hospitalizations", title: "Internações do SUS com filtros" },
  { name: "get_hospitalization_trends", title: "Séries temporais de internações" },
  { name: "compare_regions", title: "Comparação entre UFs e regiões" },
  { name: "get_icsap", title: "Internações por condições sensíveis (ICSAP)" },
  { name: "get_icsap_indicators", title: "Indicadores de ICSAP" },
  { name: "rank_csap_groups", title: "Ranking dos grupos CSAP" },
  { name: "classify_as_csap", title: "Classificar CID-10 como CSAP" },
  { name: "get_hospitalization_rates", title: "Taxas de internação por população" },
  { name: "compare_icsap_trends", title: "Tendências comparativas de ICSAP" },
] as const satisfies readonly { name: string; title: string }[];

/**
 * Rate limit de entrada por cliente (IP), aplicado às rotas não-públicas.
 * Token bucket em memória por isolate: proteção contra abuso acidental/burst,
 * não um limite global exato (recicla com o isolate; instâncias em POPs
 * distintos não somam). Para limite global rígido, mover a contagem para um
 * Durable Object. Aqui o teto é mais baixo que nos irmãos porque cada chamada
 * de tool custa CPU do container (a série de 34 anos leva ~30 s).
 */
export const RATE_LIMIT = {
  /** Burst máximo por cliente. */
  clientBurst: 10,
  /** Reposição de tokens por segundo por cliente. */
  clientRefillPerSec: 2,
  /** Teto de buckets rastreados por isolate (evicção FIFO ao estourar). */
  maxClientBuckets: 1000,
} as const;

/**
 * Texto da LANDING PAGE — a única superfície própria do produto, e por isso a
 * única que responde por ele numa busca. `lang` segue o PÚBLICO do produto;
 * o bloco `emOutroIdioma` é texto indexável, não rodapé de cortesia.
 */
export const LANDING = {
  lang: "pt-BR" as "pt-BR" | "en",
  resumo:
    "Servidor MCP das internações hospitalares do SUS (SIH/SUS, 1992–2025): causas, " +
    "séries, ICSAP e taxas por 100 mil habitantes, com a fonte citada em cada resposta.",
  exemplos: [
    "“Quantas internações por pneumonia houve no Espírito Santo em 2023?”",
    "“Como evoluiu a taxa de internações por condições sensíveis à atenção primária de 2008 a 2025?”",
    "“Quais grupos CSAP mais internam idosos no Nordeste?”",
    "“Compare a taxa de internação por 100 mil entre as capitais do Sul.”",
  ] as readonly string[],
  destaques: [
    "Toda resposta traz bloco de procedência: o cubo, a safra do dado, a versão do canal e a citação do DATASUS.",
    "Série histórica de 34 anos (1992–2025) sobre cubos agregados — sem baixar microdados.",
    "ICSAP pela Portaria 221/2008 na CID-10 e por tabela derivada e validada na CID-9 (1992–1997).",
    "Taxas por 100 mil com denominadores populacionais do mesmo canal público (healthbr-data).",
  ] as readonly string[],
  repoUrl: SERVER_CONFIG.repositoryUrl,
  npmUrl: "https://www.npmjs.com/package/sih-br-mcp",
  docsUrl: "",
  emOutroIdioma: {
    lang: "en" as "pt-BR" | "en",
    resumo:
      "Brazil's public hospital admissions (SIH/SUS, 1992–2025) for your AI assistant: " +
      "causes, monthly series, ambulatory-care-sensitive conditions (ICSAP) and rates per " +
      "100,000, every figure with its source.",
    exemplos: [
      "“How many hospital admissions for pneumonia did Espírito Santo record in 2023?”",
      "“Which Brazilian states have the highest ICSAP rates among the elderly?”",
    ] as readonly string[],
  },
} as const;
