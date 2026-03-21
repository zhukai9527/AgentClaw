import type {
  LLMRouter,
  LLMProvider,
  TaskType,
  ModelTier,
  ModelInfo,
} from "@agentclaw/types";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface FallbackEntry {
  providerId: string;
  modelId: string;
}

interface RouteRule {
  providerId: string;
  modelId: string;
  fallbacks: FallbackEntry[];
}

interface TierRoute {
  tier: ModelTier;
}

/** Per-model accumulated usage statistics. */
interface ModelUsageStats {
  provider: string;
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  callCount: number;
}

/** Aggregated usage statistics returned by `getUsageStats()`. */
interface UsageStats {
  byModel: ModelUsageStats[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  totalCalls: number;
}

/** Result of `routeWithFallback` — an ordered list of candidates. */
interface RouteCandidate {
  provider: LLMProvider;
  model: string;
}

// ---------------------------------------------------------------------------
// Error classification (inspired by ClawRouter)
// ---------------------------------------------------------------------------

/** Categorized error types for intelligent retry/cooldown decisions. */
export type LLMErrorCategory =
  | "auth_failure" // 401/403 — don't retry, key/permission issue
  | "quota_exceeded" // 403 + quota body — don't retry
  | "rate_limited" // 429 — cooldown then retry
  | "overloaded" // 529/503 + overload body — short cooldown
  | "server_error" // 5xx — switch to next model immediately
  | "config_error" // 400/413 — skip this model (context too long, etc.)
  | "network_error" // ECONNRESET, ETIMEDOUT — transient, retry
  | "unknown"; // Unclassified

interface CooldownEntry {
  until: number; // Date.now() + cooldown ms
  category: LLMErrorCategory;
}

/** Cooldown durations by error category (ms). */
const COOLDOWN_MS: Partial<Record<LLMErrorCategory, number>> = {
  rate_limited: 60_000, // 60s for rate limits
  overloaded: 15_000, // 15s for overload
  server_error: 30_000, // 30s for server errors
  network_error: 10_000, // 10s for network errors
};

/**
 * Classify an LLM error into a category based on status code and message.
 * Works with any Error object — extracts status from common error shapes.
 */
export function classifyLLMError(error: unknown): LLMErrorCategory {
  if (!error) return "unknown";

  const err = error instanceof Error ? error : new Error(String(error));
  const msg = err.message.toLowerCase();

  // Extract status code from common error shapes
  const statusMatch = msg.match(/\b(status|code)[:\s]*(\d{3})\b/);
  const status = statusMatch
    ? parseInt(statusMatch[2], 10)
    : ((error as { status?: number }).status ??
      (error as { statusCode?: number }).statusCode ??
      0);

  // Network errors (no status code)
  if (
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("econnrefused") ||
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("socket hang up")
  ) {
    return "network_error";
  }

  // Status-based classification
  if (status === 401 || (status === 403 && !msg.includes("quota"))) {
    return "auth_failure";
  }
  if (status === 403 && msg.includes("quota")) {
    return "quota_exceeded";
  }
  if (
    status === 429 ||
    msg.includes("rate limit") ||
    msg.includes("too many requests")
  ) {
    return "rate_limited";
  }
  if (
    status === 529 ||
    (status === 503 && msg.includes("overload")) ||
    msg.includes("overloaded")
  ) {
    return "overloaded";
  }
  if (
    status === 400 ||
    status === 413 ||
    msg.includes("context length") ||
    msg.includes("too long")
  ) {
    return "config_error";
  }
  if (status >= 500) {
    return "server_error";
  }

  // Degraded response detection (200 OK but content indicates failure)
  if (
    msg.includes("service temporarily") ||
    msg.includes("temporarily unavailable")
  ) {
    return "overloaded";
  }

  return "unknown";
}

/** Whether this error category should trigger a cooldown on the model. */
export function shouldCooldown(category: LLMErrorCategory): boolean {
  return category in COOLDOWN_MS;
}

/** Whether this error category is retryable (possibly on a different model). */
export function isRetryable(category: LLMErrorCategory): boolean {
  return (
    category === "rate_limited" ||
    category === "overloaded" ||
    category === "server_error" ||
    category === "network_error"
  );
}

// ---------------------------------------------------------------------------
// Default tier mapping for task types (used when no explicit rule exists)
// ---------------------------------------------------------------------------

const DEFAULT_TIER_FOR_TASK: Record<TaskType, ModelTier> = {
  planning: "flagship",
  coding: "standard",
  chat: "fast",
  classification: "fast",
  embedding: "fast",
  summarization: "standard",
};

// ---------------------------------------------------------------------------
// SmartRouter
// ---------------------------------------------------------------------------

/**
 * Smart LLM Router.
 *
 * Routes tasks to the best provider + model based on configured rules.
 * Supports cost tracking, automatic fallback chains, provider health status,
 * and tier-based intelligent routing.
 */
export class SmartRouter implements LLMRouter {
  // -- Provider registry ----------------------------------------------------
  private providers = new Map<string, LLMProvider>();

  // -- Routing tables -------------------------------------------------------
  /** Explicit provider+model rules (with optional fallback chains). */
  private routes = new Map<TaskType, RouteRule>();
  /** Tier-based rules — resolved dynamically against registered providers. */
  private tierRoutes = new Map<TaskType, TierRoute>();

  // -- Provider health ------------------------------------------------------
  private downProviders = new Set<string>();

  // -- Model cooldown (inspired by ClawRouter error classification) ---------
  /** Key: `${providerName}::${modelId}` → cooldown info */
  private modelCooldowns = new Map<string, CooldownEntry>();
  /** Per-model error counts for diagnostics */
  private modelErrorCounts = new Map<string, Map<LLMErrorCategory, number>>();

  // -- Cost tracking --------------------------------------------------------
  /** Key: `${providerName}::${modelId}` */
  private usageMap = new Map<string, ModelUsageStats>();

  // =========================================================================
  // Provider registration
  // =========================================================================

  /** Register a provider (keyed by provider.name). */
  registerProvider(provider: LLMProvider): void {
    this.providers.set(provider.name, provider);
  }

  // =========================================================================
  // Route configuration
  // =========================================================================

  /**
   * Configure a routing rule for a task type.
   *
   * Optionally accepts a fallback chain — an ordered list of alternative
   * provider+model pairs to try if the primary is unavailable.
   *
   * The method signature is backward-compatible: calling without `fallbacks`
   * behaves identically to the original implementation.
   */
  setRoute(
    taskType: TaskType,
    providerId: string,
    modelId: string,
    fallbacks?: FallbackEntry[],
  ): void {
    this.routes.set(taskType, {
      providerId,
      modelId,
      fallbacks: fallbacks ?? [],
    });
  }

  /**
   * Set a tier-based routing rule for a task type.
   *
   * When the router resolves this task type it will automatically pick the
   * best *available* (non-down) provider whose model list includes a model
   * of the requested tier.
   */
  setTierRoute(taskType: TaskType, tier: ModelTier): void {
    this.tierRoutes.set(taskType, { tier });
  }

  // =========================================================================
  // Provider health
  // =========================================================================

  /** Mark a provider as unavailable. It will be skipped during routing. */
  markProviderDown(providerName: string): void {
    this.downProviders.add(providerName);
  }

  /** Mark a provider as available again. */
  markProviderUp(providerName: string): void {
    this.downProviders.delete(providerName);
  }

  /** Check whether a provider is currently marked as down. */
  isProviderDown(providerName: string): boolean {
    return this.downProviders.has(providerName);
  }

  // =========================================================================
  // Cost tracking
  // =========================================================================

  /**
   * Record token usage for a provider/model call.
   *
   * The estimated cost is derived from the matching `ModelInfo` entry
   * registered on the provider (using `costPer1kInput` / `costPer1kOutput`).
   * If no cost information is available the cost contribution is 0.
   */
  trackUsage(
    provider: string,
    model: string,
    tokensIn: number,
    tokensOut: number,
  ): void {
    const key = `${provider}::${model}`;

    // Look up cost info from registered provider models
    const modelInfo = this.findModelInfo(provider, model);
    const costIn = modelInfo?.costPer1kInput
      ? (tokensIn / 1000) * modelInfo.costPer1kInput
      : 0;
    const costOut = modelInfo?.costPer1kOutput
      ? (tokensOut / 1000) * modelInfo.costPer1kOutput
      : 0;
    const cost = costIn + costOut;

    const existing = this.usageMap.get(key);
    if (existing) {
      existing.totalInputTokens += tokensIn;
      existing.totalOutputTokens += tokensOut;
      existing.totalCost += cost;
      existing.callCount += 1;
    } else {
      this.usageMap.set(key, {
        provider,
        model,
        totalInputTokens: tokensIn,
        totalOutputTokens: tokensOut,
        totalCost: cost,
        callCount: 1,
      });
    }
  }

  /** Return aggregated usage statistics across all tracked provider/model pairs. */
  getUsageStats(): UsageStats {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;
    let totalCalls = 0;

    const byModel: ModelUsageStats[] = [];

    for (const entry of this.usageMap.values()) {
      totalInputTokens += entry.totalInputTokens;
      totalOutputTokens += entry.totalOutputTokens;
      totalCost += entry.totalCost;
      totalCalls += entry.callCount;
      byModel.push({ ...entry });
    }

    return {
      byModel,
      totalInputTokens,
      totalOutputTokens,
      totalCost,
      totalCalls,
    };
  }

  // =========================================================================
  // Routing — primary entry point (LLMRouter interface)
  // =========================================================================

  /**
   * Select the best provider and model for a task type.
   *
   * Resolution order:
   * 1. Explicit route rule (skipping providers marked as down, walking the
   *    fallback chain if necessary).
   * 2. Explicit tier route (`setTierRoute`).
   * 3. Default tier mapping (planning→flagship, coding→standard, etc.).
   * 4. First registered available provider + its first model.
   *
   * Throws if no provider can be found at all.
   */
  route(taskType: TaskType): { provider: LLMProvider; model: string } {
    // 1. Explicit route rule + fallback chain
    const rule = this.routes.get(taskType);
    if (rule) {
      const result = this.resolveRouteRule(rule);
      if (result) return result;
    }

    // 2. Tier-based routing (explicit tier route, then default mapping)
    const tier =
      this.tierRoutes.get(taskType)?.tier ?? DEFAULT_TIER_FOR_TASK[taskType];
    if (tier) {
      const result = this.resolveByTier(tier);
      if (result) return result;
    }

    // 4. First available provider
    for (const provider of this.providers.values()) {
      if (!this.downProviders.has(provider.name)) {
        return { provider, model: provider.models[0]?.id ?? "" };
      }
    }

    throw new Error(
      `No providers registered. Cannot route task type "${taskType}".`,
    );
  }

  // =========================================================================
  // Routing — with full fallback list
  // =========================================================================

  /**
   * Return an ordered list of route candidates for a task type.
   *
   * The list is sorted by priority (primary first, then fallbacks) and
   * excludes any provider currently marked as down.
   * Models in cooldown are deprioritized (moved to end) rather than removed,
   * so they remain as last-resort fallbacks.
   */
  routeWithFallback(taskType: TaskType): RouteCandidate[] {
    const candidates: RouteCandidate[] = [];

    // Collect from explicit rule + fallbacks
    const rule = this.routes.get(taskType);
    if (rule) {
      const entries: FallbackEntry[] = [
        { providerId: rule.providerId, modelId: rule.modelId },
        ...rule.fallbacks,
      ];
      for (const entry of entries) {
        const provider = this.providers.get(entry.providerId);
        if (provider && !this.downProviders.has(provider.name)) {
          candidates.push({ provider, model: entry.modelId });
        }
      }
    }

    // If we already have candidates from explicit rules, deprioritize cooled-down ones and return
    if (candidates.length > 0) return this.prioritizeNonCooledDown(candidates);

    // Tier-based resolution (explicit tier route, then default)
    const tier =
      this.tierRoutes.get(taskType)?.tier ?? DEFAULT_TIER_FOR_TASK[taskType];
    if (tier) {
      const tierCandidates = this.collectByTier(tier);
      if (tierCandidates.length > 0)
        return this.prioritizeNonCooledDown(tierCandidates);
    }

    // Ultimate fallback: all available providers
    for (const provider of this.providers.values()) {
      if (!this.downProviders.has(provider.name)) {
        candidates.push({ provider, model: provider.models[0]?.id ?? "" });
      }
    }

    return this.prioritizeNonCooledDown(candidates);
  }

  // =========================================================================
  // Model cooldown & error reporting
  // =========================================================================

  /**
   * Report an error for a specific model. Classifies the error, applies
   * cooldown if appropriate, and tracks error counts.
   *
   * Call this from agent-loop when a provider stream/chat fails.
   * Returns the classification so the caller can decide whether to retry.
   */
  reportError(
    providerName: string,
    modelId: string,
    error: unknown,
  ): { category: LLMErrorCategory; retryable: boolean } {
    const category = classifyLLMError(error);
    const key = `${providerName}::${modelId}`;

    // Track error counts
    if (!this.modelErrorCounts.has(key)) {
      this.modelErrorCounts.set(key, new Map());
    }
    const counts = this.modelErrorCounts.get(key)!;
    counts.set(category, (counts.get(category) ?? 0) + 1);

    // Apply cooldown if applicable
    const cooldownMs = COOLDOWN_MS[category];
    if (cooldownMs) {
      this.modelCooldowns.set(key, {
        until: Date.now() + cooldownMs,
        category,
      });
      console.log(
        `[smart-router] Model ${key} cooling down for ${cooldownMs / 1000}s (${category})`,
      );
    }

    return { category, retryable: isRetryable(category) };
  }

  /** Check if a specific model is currently in cooldown. */
  isModelCoolingDown(providerName: string, modelId: string): boolean {
    const key = `${providerName}::${modelId}`;
    const entry = this.modelCooldowns.get(key);
    if (!entry) return false;
    if (Date.now() >= entry.until) {
      this.modelCooldowns.delete(key);
      return false;
    }
    return true;
  }

  /** Get error statistics for diagnostics. */
  getErrorStats(): Map<string, Map<LLMErrorCategory, number>> {
    return new Map(this.modelErrorCounts);
  }

  /** Clear all cooldowns (e.g., on manual reset). */
  clearCooldowns(): void {
    this.modelCooldowns.clear();
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Reorder candidates so models in cooldown are at the end (not removed).
   * This ensures they remain as last-resort fallbacks.
   */
  private prioritizeNonCooledDown(
    candidates: RouteCandidate[],
  ): RouteCandidate[] {
    const ready: RouteCandidate[] = [];
    const cooled: RouteCandidate[] = [];
    for (const c of candidates) {
      if (this.isModelCoolingDown(c.provider.name, c.model)) {
        cooled.push(c);
      } else {
        ready.push(c);
      }
    }
    return [...ready, ...cooled];
  }

  /**
   * Try to resolve an explicit route rule. Walks primary + fallback chain,
   * skipping providers marked as down.
   */
  private resolveRouteRule(
    rule: RouteRule,
  ): { provider: LLMProvider; model: string } | null {
    const entries: FallbackEntry[] = [
      { providerId: rule.providerId, modelId: rule.modelId },
      ...rule.fallbacks,
    ];

    for (const entry of entries) {
      if (this.downProviders.has(entry.providerId)) continue;
      const provider = this.providers.get(entry.providerId);
      if (provider) return { provider, model: entry.modelId };
    }

    return null;
  }

  /**
   * Find the first available provider that has a model matching the
   * requested tier.
   */
  private resolveByTier(
    tier: ModelTier,
  ): { provider: LLMProvider; model: string } | null {
    for (const provider of this.providers.values()) {
      if (this.downProviders.has(provider.name)) continue;
      const model = provider.models.find((m) => m.tier === tier);
      if (model) {
        return { provider, model: model.id };
      }
    }
    return null;
  }

  /**
   * Collect all available provider+model pairs for a given tier, ordered by
   * provider registration order.
   */
  private collectByTier(tier: ModelTier): RouteCandidate[] {
    const results: RouteCandidate[] = [];
    for (const provider of this.providers.values()) {
      if (this.downProviders.has(provider.name)) continue;
      const model = provider.models.find((m) => m.tier === tier);
      if (model) {
        results.push({ provider, model: model.id });
      }
    }
    return results;
  }

  /** Look up a ModelInfo from a registered provider by provider name and model id. */
  private findModelInfo(
    providerName: string,
    modelId: string,
  ): ModelInfo | undefined {
    const provider = this.providers.get(providerName);
    if (!provider) return undefined;
    return provider.models.find((m) => m.id === modelId);
  }
}
