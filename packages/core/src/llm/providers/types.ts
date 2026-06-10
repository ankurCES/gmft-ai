// Phase 1.5a stub. The real `ProviderModule` shape is defined in
// Phase 1.5b (5 provider modules: anthropic, openai, google, openrouter,
// ollama) — this file is the forward-reference target that 1.5b replaces.
// OnboardRuntime.providers: readonly ProviderModule[] is already declared
// in packages/core/src/config/registry.ts and re-exported via index.ts.

/**
 * Shape of a single LLM provider module. Real fields (id, displayName,
 * authFields, defaultEndpoint?, modelCatalog, validate) land in 1.5b.
 */
export interface ProviderModule {
  readonly id: string;
}
