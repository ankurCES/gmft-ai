/**
 * Stable, version-independent description of how to authenticate with an LLM
 * provider. The onboard driver asks the user for each `authFields` entry,
 * stores the value in the SecretStore, and calls `validate()` to confirm.
 */
export interface AuthField {
  /** Stable id. Stored as `provider.fieldId` in SecretStore. e.g. 'apiKey'. */
  id: string;
  /** Human label shown in the prompt. e.g. 'API key'. */
  label: string;
  /**
   * If true, this field's value is a non-secret URL/host (e.g. Ollama
   * endpoint) and is stored in `config.toml`, not the SecretStore. If
   * false, the value is treated as a secret.
   */
  isEndpoint?: boolean;
  /**
   * Optional placeholder text shown in the input field. e.g.
   * 'sk-ant-...' for Anthropic. Never include real keys in placeholders.
   */
  placeholder?: string;
}

export interface ModelInfo {
  /** The exact id used in API requests. e.g. 'claude-3-5-sonnet-latest'. */
  id: string;
  /** Human label shown in the picker. e.g. 'Claude 3.5 Sonnet (latest)'. */
  displayName: string;
  /**
   * If true, the model is the provider's default recommendation. The
   * onboard driver pre-selects this model in the picker.
   */
  isDefault?: boolean;
}

export type ValidationResult =
  | { ok: true; models?: readonly ModelInfo[] }
  | { ok: false; reason: 'invalid_key' | 'network' | 'unknown' };

/**
 * A single LLM provider module. Each provider lives in its own file
 * (`anthropic.ts`, `openai.ts`, …) and exports one `const` of this type.
 * The module is the unit of registration: tests import the const directly,
 * and the onboard driver iterates `PROVIDERS`.
 */
export interface ProviderModule {
  /** Stable id. MUST match `LlmConfig.provider` union and PROVIDERS key. */
  readonly id: 'anthropic' | 'openai' | 'google' | 'openrouter' | 'ollama';
  /** Human label shown in the provider picker. */
  readonly displayName: string;
  /**
   * Fields the user must provide. Order matters: each field is prompted
   * in sequence. For most providers this is a single `{ id: 'apiKey' }`.
   * Ollama has `{ id: 'endpoint', isEndpoint: true }` and no apiKey.
   */
  readonly authFields: readonly AuthField[];
  /**
   * Default endpoint URL. Overridable by the user. For cloud providers
   * this is the canonical API root. For Ollama this is `http://localhost:11434`.
   * Required when any authField has `isEndpoint: true`.
   */
  readonly defaultEndpoint?: string;
  /**
   * Curated model list. 3-5 models per provider. Excludes preview,
   * deprecated, and internal models. The onboard picker uses this.
   */
  readonly modelCatalog: readonly ModelInfo[];
  /**
   * 1-token test request. Returns `ok: true` if the key+endpoint combo
   * works; `invalid_key` on 401/403; `network` on timeout, DNS failure,
   * 5xx, or unreachable host. MUST NOT mutate any state. May be slow
   * (~5s timeout). The `endpoint` param overrides `defaultEndpoint`.
   */
  validate(
    key: string,
    endpoint?: string,
    signal?: AbortSignal,
  ): Promise<ValidationResult>;
}

/**
 * UI adapter the LLM provider field calls. 1.5b tests inject a fake
 * implementation. 1.5c binds the real Ink components in
 * `apps/gmft/src/onboard/bind-provider-ui.tsx`.
 */
export interface ProviderUI {
  pickProvider(providers: readonly ProviderModule[]): Promise<string | null>;
  enterKey(field: AuthField): Promise<string | null>;
  pickModel(
    provider: ProviderModule,
    models: readonly ModelInfo[],
  ): Promise<string | null>;
  confirmAction(message: string): Promise<boolean>;
}
