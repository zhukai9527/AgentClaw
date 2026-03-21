import { describe, it, expect } from "vitest";
import {
  classifyLLMError,
  isRetryable,
  shouldCooldown,
  SmartRouter,
} from "../index.js";

describe("classifyLLMError", () => {
  it("should classify 429 as rate_limited", () => {
    expect(classifyLLMError(new Error("status: 429 Too Many Requests"))).toBe(
      "rate_limited",
    );
    expect(classifyLLMError({ status: 429, message: "slow down" })).toBe(
      "rate_limited",
    );
  });

  it("should classify 401/403 as auth_failure", () => {
    expect(classifyLLMError(new Error("status: 401 Unauthorized"))).toBe(
      "auth_failure",
    );
    expect(classifyLLMError(new Error("status: 403 Forbidden"))).toBe(
      "auth_failure",
    );
  });

  it("should classify 403 + quota as quota_exceeded", () => {
    expect(classifyLLMError(new Error("status: 403 quota exceeded"))).toBe(
      "quota_exceeded",
    );
  });

  it("should classify 529/503+overload as overloaded", () => {
    expect(classifyLLMError(new Error("status: 529"))).toBe("overloaded");
    expect(classifyLLMError(new Error("status: 503 overloaded"))).toBe(
      "overloaded",
    );
  });

  it("should classify 500/502 as server_error", () => {
    expect(classifyLLMError(new Error("status: 500"))).toBe("server_error");
    expect(classifyLLMError(new Error("status: 502"))).toBe("server_error");
  });

  it("should classify 400/413 as config_error", () => {
    expect(classifyLLMError(new Error("status: 400 Bad Request"))).toBe(
      "config_error",
    );
    expect(classifyLLMError(new Error("context length exceeded"))).toBe(
      "config_error",
    );
  });

  it("should classify network errors", () => {
    expect(classifyLLMError(new Error("ECONNRESET"))).toBe("network_error");
    expect(classifyLLMError(new Error("fetch failed"))).toBe("network_error");
    expect(classifyLLMError(new Error("ETIMEDOUT"))).toBe("network_error");
  });

  it("should classify degraded response as overloaded", () => {
    expect(classifyLLMError(new Error("service temporarily unavailable"))).toBe(
      "overloaded",
    );
  });

  it("should return unknown for unclassified errors", () => {
    expect(classifyLLMError(new Error("something weird"))).toBe("unknown");
  });
});

describe("isRetryable / shouldCooldown", () => {
  it("rate_limited is retryable and should cooldown", () => {
    expect(isRetryable("rate_limited")).toBe(true);
    expect(shouldCooldown("rate_limited")).toBe(true);
  });

  it("auth_failure is not retryable and should not cooldown", () => {
    expect(isRetryable("auth_failure")).toBe(false);
    expect(shouldCooldown("auth_failure")).toBe(false);
  });

  it("server_error is retryable and should cooldown", () => {
    expect(isRetryable("server_error")).toBe(true);
    expect(shouldCooldown("server_error")).toBe(true);
  });
});

describe("SmartRouter cooldown", () => {
  it("should put model in cooldown after reportError", () => {
    const router = new SmartRouter();
    const result = router.reportError(
      "openai",
      "gpt-4",
      new Error("status: 429"),
    );
    expect(result.category).toBe("rate_limited");
    expect(result.retryable).toBe(true);
    expect(router.isModelCoolingDown("openai", "gpt-4")).toBe(true);
  });

  it("should not cooldown on auth_failure", () => {
    const router = new SmartRouter();
    router.reportError("openai", "gpt-4", new Error("status: 401"));
    expect(router.isModelCoolingDown("openai", "gpt-4")).toBe(false);
  });

  it("should clear cooldowns", () => {
    const router = new SmartRouter();
    router.reportError("openai", "gpt-4", new Error("status: 429"));
    expect(router.isModelCoolingDown("openai", "gpt-4")).toBe(true);
    router.clearCooldowns();
    expect(router.isModelCoolingDown("openai", "gpt-4")).toBe(false);
  });
});
