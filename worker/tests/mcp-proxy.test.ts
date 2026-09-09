/**
 * Núcleo puro do proxy /mcp (src/mcp-proxy.ts): Host, Origin, CORS,
 * cabeçalhos encaminhados e o nome que vai para a telemetria.
 *
 * Nada aqui pina literal de hostname: tudo vem do SERVER_CONFIG que o proxy
 * consome. O que o teste guarda é a POLÍTICA — quem passa, quem leva 403 —
 * porque é a única validação de Origin/Host da pilha (o container não valida).
 */

import { describe, expect, it } from "vitest";

import { SERVER_CONFIG } from "../src/config.js";
import {
  corsHeaders,
  forwardedHeaders,
  hostnameOf,
  isAllowedHost,
  isAllowedOrigin,
  toolNamesFromBody,
} from "../src/mcp-proxy.js";

const HOST = SERVER_CONFIG.allowedHostnames[0]!;

describe("Host", () => {
  it("aceita os hostnames configurados, com ou sem porta", () => {
    for (const h of SERVER_CONFIG.allowedHostnames) {
      expect(isAllowedHost(h), h).toBe(true);
      expect(isAllowedHost(`${h}:8787`), `${h}:8787`).toBe(true);
    }
  });

  it("recusa host ausente, malformado ou de fora", () => {
    expect(isAllowedHost(null)).toBe(false);
    expect(isAllowedHost("")).toBe(false);
    expect(isAllowedHost("evil.example")).toBe(false);
    expect(isAllowedHost(`${HOST}.evil.example`)).toBe(false);
    expect(isAllowedHost("[::1")).toBe(false);
  });

  it("hostnameOf normaliza para minúsculas e tira a porta", () => {
    expect(hostnameOf("SIH.Sidneybissoli.com:443")).toBe("sih.sidneybissoli.com");
  });
});

describe("Origin", () => {
  it("sem Origin passa (cliente que não é navegador)", () => {
    expect(isAllowedOrigin(null, HOST, "")).toBe(true);
    expect(isAllowedOrigin(null, HOST, undefined)).toBe(true);
  });

  it("Origin de outro site → recusada (vira 403)", () => {
    expect(isAllowedOrigin("https://evil.example", HOST, "")).toBe(false);
    expect(isAllowedOrigin("https://evil.example", HOST, "https://outro.example")).toBe(false);
  });

  it("Origin 'null' e malformada → recusadas", () => {
    expect(isAllowedOrigin("null", HOST, "")).toBe(false);
    expect(isAllowedOrigin("não é url", HOST, "")).toBe(false);
  });

  it("Origin do próprio host ou de um hostname configurado → aceita", () => {
    expect(isAllowedOrigin(`https://${HOST}`, HOST, "")).toBe(true);
    for (const h of SERVER_CONFIG.allowedHostnames) {
      expect(isAllowedOrigin(`https://${h}`, HOST, ""), h).toBe(true);
    }
  });

  it("localhost em qualquer porta → aceita (Inspector no navegador)", () => {
    expect(isAllowedOrigin("http://localhost:6274", HOST, "")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:5173", HOST, "")).toBe(true);
  });

  it("ALLOWED_ORIGIN lista origins extras (vírgula) e '*' abre tudo", () => {
    const lista = "https://a.example, https://b.example/";
    expect(isAllowedOrigin("https://a.example", HOST, lista)).toBe(true);
    expect(isAllowedOrigin("https://b.example", HOST, lista)).toBe(true);
    expect(isAllowedOrigin("https://c.example", HOST, lista)).toBe(false);
    expect(isAllowedOrigin("https://c.example", HOST, "*")).toBe(true);
  });
});

describe("CORS", () => {
  it("sem Origin não emite cabeçalho nenhum", () => {
    expect(corsHeaders(null)).toEqual({});
  });

  it("com Origin ecoa a origin validada (nunca '*') e varia por Origin", () => {
    const h = corsHeaders("http://localhost:6274");
    expect(h["Access-Control-Allow-Origin"]).toBe("http://localhost:6274");
    expect(h["Access-Control-Allow-Headers"]).toContain("Mcp-Session-Id");
    expect(h["Access-Control-Allow-Headers"]).toContain("MCP-Protocol-Version");
    expect(h.Vary).toBe("Origin");
  });
});

describe("cabeçalhos encaminhados ao container", () => {
  it("leva os do transporte e deixa Authorization, Cookie e CF-* na borda", () => {
    const out = forwardedHeaders(
      new Headers({
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Mcp-Session-Id": "abc",
        "MCP-Protocol-Version": "2025-06-18",
        Authorization: "Bearer segredo",
        Cookie: "a=b",
        "CF-Connecting-IP": "1.2.3.4",
        "x-mcp-self": "marca",
      }),
    );
    expect(out.get("accept")).toBe("application/json, text/event-stream");
    expect(out.get("content-type")).toBe("application/json");
    expect(out.get("mcp-session-id")).toBe("abc");
    expect(out.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(out.get("authorization")).toBeNull();
    expect(out.get("cookie")).toBeNull();
    expect(out.get("cf-connecting-ip")).toBeNull();
    expect(out.get("x-mcp-self")).toBeNull();
  });
});

describe("toolNamesFromBody — o que vai para o Analytics Engine", () => {
  it("tools/call → o nome da tool", () => {
    expect(
      toolNamesFromBody({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_icsap", arguments: {} } }),
    ).toEqual(["get_icsap"]);
  });

  it("outros métodos → o próprio método", () => {
    expect(toolNamesFromBody({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).toEqual(["initialize"]);
    expect(toolNamesFromBody({ jsonrpc: "2.0", id: 2, method: "tools/list" })).toEqual(["tools/list"]);
  });

  it("tools/call sem nome → 'tools/call' (não perde a chamada)", () => {
    expect(toolNamesFromBody({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })).toEqual(["tools/call"]);
  });

  it("lote JSON-RPC → um nome por item, na ordem", () => {
    expect(
      toolNamesFromBody([
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "a" } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, result: {} },
      ]),
    ).toEqual(["a", "notifications/initialized"]);
  });

  it("corpo inválido, vazio ou sem method → nada", () => {
    expect(toolNamesFromBody(undefined)).toEqual([]);
    expect(toolNamesFromBody(null)).toEqual([]);
    expect(toolNamesFromBody("texto")).toEqual([]);
    expect(toolNamesFromBody({ jsonrpc: "2.0", id: 1, result: {} })).toEqual([]);
    expect(toolNamesFromBody({ method: 42 })).toEqual([]);
  });
});
