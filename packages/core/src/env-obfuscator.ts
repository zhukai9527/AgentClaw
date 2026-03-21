/**
 * Environment Variable Obfuscation — bi-directional masking at the LLM boundary.
 *
 * Before sending messages to the LLM provider, sensitive env var values are
 * replaced with `<<$env:VAR_NAME>>` placeholders.
 *
 * When the LLM's output contains a placeholder (e.g. in a shell command),
 * it is restored to the real value before tool execution.
 */

/** Env var name patterns that are considered sensitive */
const SENSITIVE_PATTERNS =
  /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|DSN|WEBHOOK)(?:_|$)/i;

/** Minimum value length to consider for obfuscation (avoid false positives) */
const MIN_VALUE_LENGTH = 8;

export interface ObfuscationMap {
  /** placeholder → real value (for restore) */
  placeholderToReal: Map<string, string>;
  /** real value → placeholder (for obfuscate), sorted longest-first */
  realToPlaceholder: Array<[string, string]>;
}

/**
 * Build an obfuscation map from current process.env.
 * Call once at agent-loop startup; the map is reused across iterations.
 */
export function buildObfuscationMap(): ObfuscationMap {
  const placeholderToReal = new Map<string, string>();
  const pairs: Array<[string, string]> = [];

  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < MIN_VALUE_LENGTH) continue;
    if (!SENSITIVE_PATTERNS.test(key)) continue;

    const placeholder = `<<$env:${key}>>`;
    placeholderToReal.set(placeholder, value);
    pairs.push([value, placeholder]);
  }

  // Sort longest-first to avoid partial replacements
  pairs.sort((a, b) => b[0].length - a[0].length);

  return { placeholderToReal, realToPlaceholder: pairs };
}

/** Replace all real values in a string with placeholders */
export function obfuscateString(s: string, map: ObfuscationMap): string {
  if (!s || map.realToPlaceholder.length === 0) return s;
  let result = s;
  for (const [real, placeholder] of map.realToPlaceholder) {
    if (result.includes(real)) {
      result = result.replaceAll(real, placeholder);
    }
  }
  return result;
}

/** Restore all placeholders in a string to real values */
export function restoreString(s: string, map: ObfuscationMap): string {
  if (!s || map.placeholderToReal.size === 0) return s;
  let result = s;
  for (const [placeholder, real] of map.placeholderToReal) {
    if (result.includes(placeholder)) {
      result = result.replaceAll(placeholder, real);
    }
  }
  return result;
}

/**
 * Deep-obfuscate all string values in a messages array.
 * Returns a NEW array (does not mutate the original).
 */
export function obfuscateMessages<T>(messages: T[], map: ObfuscationMap): T[] {
  if (map.realToPlaceholder.length === 0) return messages;
  return JSON.parse(obfuscateString(JSON.stringify(messages), map));
}
