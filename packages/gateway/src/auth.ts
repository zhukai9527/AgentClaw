import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { loadConfig } from "./config.js";

/** 获取当前有效的 API key（支持热更新：config.json 优先，env 兜底） */
function getApiKey(): string | undefined {
  const cfg = loadConfig();
  return cfg.apiKey || process.env.API_KEY;
}

/**
 * Extract credential from request:
 * 1. Authorization: Bearer <key>
 * 2. Query parameter ?api_key=<key> or ?token=<key>
 */
function extractCredential(req: FastifyRequest): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  const query = req.query as Record<string, string>;
  return query.api_key || query.token;
}

/**
 * Register API key authentication on a Fastify instance.
 * If API_KEY is not set anywhere, no auth is enforced at startup.
 * Auth is re-evaluated on each request to support hot config updates.
 */
export function registerAuth(app: FastifyInstance): void {
  const initialKey = getApiKey();
  if (!initialKey) {
    console.log(
      "[auth] API_KEY not set — authentication disabled (will re-check on config update)",
    );
  } else {
    console.log("[auth] API_KEY set — authentication enabled");
  }

  // Verify endpoint — allows frontend to check if a key is valid
  app.get(
    "/api/auth/verify",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const apiKey = getApiKey();
      if (!apiKey) return reply.send({ ok: true });
      const credential = extractCredential(req);
      if (credential === apiKey) {
        return reply.send({ ok: true });
      }
      return reply.status(401).send({ error: "Invalid API key" });
    },
  );

  // Global onRequest hook
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url;

    // Allow static assets, SPA shell, and generated files without auth
    if (
      url === "/" ||
      url === "/health" ||
      url === "/favicon.ico" ||
      url.startsWith("/assets/") ||
      url.startsWith("/files/") ||
      url.startsWith("/preview/") ||
      url.startsWith("/chat") ||
      url.startsWith("/plans") ||
      url.startsWith("/memory") ||
      url.startsWith("/settings") ||
      url.startsWith("/traces") ||
      url.startsWith("/token-logs")
    ) {
      return;
    }

    // Protect /api/*, /ws*
    if (url.startsWith("/api/") || url.startsWith("/ws")) {
      const apiKey = getApiKey();
      if (!apiKey) return; // no key configured = no auth
      const credential = extractCredential(req);
      if (credential !== apiKey) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
    }
  });
}
