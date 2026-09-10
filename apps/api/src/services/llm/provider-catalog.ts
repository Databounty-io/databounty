// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only provider catalog boundary. Ported from v1's
 * `services/llm/provider-catalog.ts`. Discovery data never changes routing:
 * admins explicitly register and approve models after inspecting it.
 */
export interface DiscoveredModel {
  id: string;
  name: string;
  contextWindow: number | null;
  supportsJson: boolean;
}

export class ProviderCatalogError extends Error {}

export interface ProviderCatalogSnapshot {
  models: DiscoveredModel[];
  fetchedAt: string;
  cacheHit: boolean;
}

const OPENROUTER_CACHE_TTL_MS = 5 * 60_000;
let openRouterCache: { models: DiscoveredModel[]; fetchedAt: string; expiresAt: number } | null = null;

interface OpenRouterCatalogModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  supported_parameters?: unknown;
}
interface OpenRouterCatalogResponse {
  data?: OpenRouterCatalogModel[];
}

export async function discoverOpenRouterModels(
  apiKey: string,
  opts: { force?: boolean } = {}
): Promise<ProviderCatalogSnapshot> {
  if (!apiKey) throw new ProviderCatalogError("OpenRouter is not configured");
  if (!opts.force && openRouterCache && openRouterCache.expiresAt > Date.now()) {
    return { models: openRouterCache.models, fetchedAt: openRouterCache.fetchedAt, cacheHit: true };
  }
  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new ProviderCatalogError("OpenRouter model discovery is unavailable");
  }
  if (!response.ok) throw new ProviderCatalogError(`OpenRouter model discovery failed (${response.status})`);
  const body = (await response.json()) as OpenRouterCatalogResponse;
  const models = (body.data ?? [])
    .filter((model): model is OpenRouterCatalogModel & { id: string } => typeof model.id === "string")
    .map((model) => ({
      id: model.id,
      name: typeof model.name === "string" ? model.name : model.id,
      contextWindow: typeof model.context_length === "number" ? model.context_length : null,
      supportsJson: Array.isArray(model.supported_parameters) && model.supported_parameters.includes("response_format"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const fetchedAt = new Date().toISOString();
  openRouterCache = { models, fetchedAt, expiresAt: Date.now() + OPENROUTER_CACHE_TTL_MS };
  return { models, fetchedAt, cacheHit: false };
}

/** Test hook — drop the discovery cache. */
export function clearProviderCatalogCache(): void {
  openRouterCache = null;
}
