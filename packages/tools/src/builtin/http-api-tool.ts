/**
 * Dynamic Tool generator for HTTP API knowledge sources.
 *
 * Converts a KnowledgeSource config into a standard Tool that the agent
 * can call like any built-in tool. The LLM provides parameters, and
 * the tool makes the HTTP request and returns the response.
 */
import type {
  Tool,
  ToolResult,
  KnowledgeSource,
  HttpApiSourceConfig,
  HttpApiParameter,
  ToolParameterSchema,
} from "@agentclaw/types";

/**
 * Build URL with path parameter substitution.
 * Replaces {paramName} placeholders in the URL template.
 */
function buildUrl(
  urlTemplate: string,
  pathParams: Record<string, string>,
  queryParams: Record<string, string>,
): string {
  let url = urlTemplate;
  for (const [key, value] of Object.entries(pathParams)) {
    url = url.replace(`{${key}}`, encodeURIComponent(value));
  }
  if (Object.keys(queryParams).length > 0) {
    const qs = new URLSearchParams(queryParams).toString();
    url += (url.includes("?") ? "&" : "?") + qs;
  }
  return url;
}

/**
 * Extract a subset of the response using a simple dot-notation path.
 * e.g., ".data.stock_count" extracts json.data.stock_count
 */
function extractFromResponse(data: unknown, path?: string): unknown {
  if (!path) return data;
  const keys = path.replace(/^\./, "").split(".");
  let current: unknown = data;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return current;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Convert a KnowledgeSource into a callable Tool.
 */
export function createHttpApiTool(source: KnowledgeSource): Tool {
  const config = source.config as HttpApiSourceConfig;

  // Build parameter schema for LLM
  const properties: Record<string, { type: string; description?: string }> = {};
  const required: string[] = [];
  for (const param of config.parameters) {
    properties[param.name] = {
      type: param.type,
      description: param.description,
    };
    if (param.required) {
      required.push(param.name);
    }
  }

  const parameterSchema: ToolParameterSchema = {
    type: "object",
    properties,
    required,
  };

  return {
    name: `ks_${source.name}`,
    description: source.description,
    category: "builtin",
    parameters: parameterSchema,

    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      try {
        // Separate parameters by location
        const pathParams: Record<string, string> = {};
        const queryParams: Record<string, string> = {};
        const bodyParams: Record<string, unknown> = {};

        for (const paramDef of config.parameters) {
          const value = input[paramDef.name];
          if (value === undefined) continue;
          const strValue = String(value);

          switch (paramDef.in) {
            case "path":
              pathParams[paramDef.name] = strValue;
              break;
            case "query":
              queryParams[paramDef.name] = strValue;
              break;
            case "body":
              bodyParams[paramDef.name] = value;
              break;
          }
        }

        const url = buildUrl(config.url, pathParams, queryParams);

        // Build fetch options
        const fetchOptions: RequestInit = {
          method: config.method,
          headers: {
            Accept: "application/json",
            ...config.headers,
          },
        };

        // Add body for non-GET requests
        if (config.method !== "GET" && Object.keys(bodyParams).length > 0) {
          fetchOptions.headers = {
            ...fetchOptions.headers,
            "Content-Type": "application/json",
          };
          fetchOptions.body = JSON.stringify(bodyParams);
        }

        // Execute request with timeout
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        fetchOptions.signal = controller.signal;

        const response = await fetch(url, fetchOptions);
        clearTimeout(timeout);

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          return {
            content: `HTTP ${response.status}: ${response.statusText}. ${text.slice(0, 500)}`,
            isError: true,
          };
        }

        const contentType = response.headers.get("content-type") || "";
        let result: unknown;

        if (contentType.includes("application/json")) {
          const json = await response.json();
          result = extractFromResponse(json, config.responseMapping);
        } else {
          result = await response.text();
        }

        // Truncate large responses
        const content =
          typeof result === "string"
            ? result.slice(0, 4000)
            : JSON.stringify(result, null, 2).slice(0, 4000);

        return { content, isError: false };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: `API call failed: ${message}`,
          isError: true,
        };
      }
    },
  };
}

/**
 * Create Tool instances from all enabled knowledge sources of an agent.
 */
export function createKnowledgeSourceTools(sources: KnowledgeSource[]): Tool[] {
  return sources
    .filter((s) => s.enabled && s.type === "http_api")
    .map(createHttpApiTool);
}
