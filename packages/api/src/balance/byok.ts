import { EModelEndpoint, extractEnvVariable, normalizeEndpointName } from 'librechat-data-provider';
import type { TCustomConfig, TEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { isEnabled, isUserProvided } from '~/utils/common';
import { resolveConfigSecret } from '~/admin/secrets';
import { getBalanceConfig } from '~/app/config';

/** The balance levers that decide how a user-provided request is charged. */
export interface ByokBalanceConfig {
  /** Percent of the standard cost charged for a user-provided request. */
  byokChargePercent?: number;
  /** Whether the pre-flight balance check is skipped for a user-provided request. */
  byokBypassBalanceCheck?: boolean;
}

/** How a user-provided request is charged and admitted. */
export interface ByokBalancePolicy {
  /** Fraction of the standard cost charged, between 0 (free) and 1 (full cost). */
  chargeFactor: number;
  /** Whether the pre-flight balance check is skipped entirely. */
  bypassBalanceCheck: boolean;
}

/**
 * The built-in credential env vars whose `user_provided` value means the user
 * pays the provider, not the operator. A base URL counts too: a user-provided
 * reverse proxy means the operator never sees the provider bill.
 */
const BUILT_IN_CREDENTIAL_ENV: Readonly<Record<string, readonly string[]>> = {
  [EModelEndpoint.openAI.toLowerCase()]: ['OPENAI_API_KEY', 'OPENAI_REVERSE_PROXY'],
  [EModelEndpoint.anthropic.toLowerCase()]: ['ANTHROPIC_API_KEY'],
  [EModelEndpoint.google.toLowerCase()]: ['GOOGLE_KEY'],
  [EModelEndpoint.assistants.toLowerCase()]: ['ASSISTANTS_API_KEY', 'ASSISTANTS_BASE_URL'],
  [EModelEndpoint.azureAssistants.toLowerCase()]: [
    'AZURE_ASSISTANTS_API_KEY',
    'AZURE_ASSISTANTS_BASE_URL',
  ],
  [EModelEndpoint.bedrock.toLowerCase()]: [
    'BEDROCK_AWS_ACCESS_KEY_ID',
    'BEDROCK_AWS_SECRET_ACCESS_KEY',
    'BEDROCK_AWS_SESSION_TOKEN',
    'BEDROCK_AWS_BEARER_TOKEN',
  ],
};

/**
 * Reads the balance levers that apply to user-provided credentials.
 *
 * `byokChargePercent` is a percentage of the standard cost, so it is scaled to
 * a fraction and clamped to `[0, 1]`. `byokBypassBalanceCheck` defaults to
 * `true`: a request the operator does not pay for is not blocked by an
 * exhausted balance.
 */
export function resolveByokBalancePolicy(
  balanceConfig?: ByokBalanceConfig | Partial<TCustomConfig['balance']> | null,
): ByokBalancePolicy {
  const percent = balanceConfig?.byokChargePercent;
  const usablePercent = typeof percent === 'number' && Number.isFinite(percent) ? percent : 0;
  return {
    chargeFactor: Math.min(1, Math.max(0, usablePercent / 100)),
    bypassBalanceCheck: balanceConfig?.byokBypassBalanceCheck !== false,
  };
}

/**
 * The fraction of the standard cost a request is charged: the standard cost
 * for a request the operator pays for, and the BYOK fraction for one whose
 * credentials the user provided.
 */
export function resolveBalanceChargeFactor({
  balanceConfig,
  isUserProvided: userProvided,
}: {
  balanceConfig?: ByokBalanceConfig | Partial<TCustomConfig['balance']> | null;
  isUserProvided: boolean;
}): number {
  if (!userProvided) {
    return 1;
  }
  return resolveByokBalancePolicy(balanceConfig).chargeFactor;
}

/**
 * The custom endpoint definition an endpoint name refers to: the exact name
 * match first, then the case-insensitive match the provider registry falls
 * back to (a custom endpoint named `OpenRouter` is stored under that name but
 * its provider resolves to the lowercase `openrouter`).
 */
function findCustomEndpoint(
  appConfig: AppConfig | undefined,
  endpoint: string,
): Partial<TEndpoint> | undefined {
  const custom = appConfig?.endpoints?.[EModelEndpoint.custom];
  if (!Array.isArray(custom) || custom.length === 0) {
    return undefined;
  }
  const exact = custom.find(
    (config) => normalizeEndpointName(config.name ?? '') === normalizeEndpointName(endpoint),
  );
  if (exact) {
    return exact;
  }
  const target = endpoint.toLowerCase();
  return custom.find((config) => (config.name ?? '').toLowerCase() === target);
}

/**
 * Whether a custom endpoint's key or base URL is the user's own. The values
 * are read as the endpoint reads them — a stored secret decrypted, an env
 * reference expanded — so `${KEY}` pointing at a `user_provided` env value
 * counts too.
 */
function isUserProvidedCustomEndpoint(appConfig: AppConfig | undefined, endpoint: string): boolean {
  const config = findCustomEndpoint(appConfig, endpoint);
  if (!config) {
    return false;
  }
  if (isUserProvided(resolveConfigSecret(config.apiKey ?? ''))) {
    return true;
  }
  return isUserProvided(extractEnvVariable(config.baseURL ?? ''));
}

/**
 * Whether the Azure OpenAI group serving `model` holds a user-provided key.
 * Azure groups carry their own key, so the group's key — not the endpoint's
 * environment variable — decides who pays. A model with no group mapping
 * resolves to nothing, and the caller then falls back to the environment.
 */
function isUserProvidedAzureGroup(
  appConfig: AppConfig | undefined,
  model?: string | null,
): boolean {
  const azureConfig = appConfig?.endpoints?.[EModelEndpoint.azureOpenAI];
  if (!azureConfig || !model) {
    return false;
  }
  const groupName = azureConfig.modelGroupMap?.[model]?.group;
  if (!groupName) {
    return false;
  }
  const group = azureConfig.groupMap?.[groupName];
  if (!group) {
    return false;
  }
  return isUserProvided(resolveConfigSecret(group.apiKey ?? ''));
}

/**
 * Whether Anthropic runs on Vertex AI, which authenticates with a service
 * account the operator holds rather than with a user-provided key.
 */
function isAnthropicVertex(appConfig: AppConfig | undefined): boolean {
  const vertexConfig = appConfig?.endpoints?.[EModelEndpoint.anthropic]?.vertexConfig;
  if (vertexConfig && vertexConfig.enabled !== false) {
    return true;
  }
  return isEnabled(process.env.ANTHROPIC_USE_VERTEX);
}

/**
 * Whether the credentials a request runs on belong to the user rather than to
 * the operator.
 *
 * This is read from the configured credential, not from the endpoints config's
 * `userProvide` flag: that flag is forced to `false` for Azure OpenAI, Azure
 * Assistants and Anthropic-with-Vertex, so it would silently miss
 * user-provided Azure credentials.
 */
export function isUserProvidedEndpoint({
  endpoint,
  appConfig,
  model,
}: {
  endpoint?: string | null;
  appConfig?: AppConfig;
  /** The model the request runs, which selects the Azure group holding the key. */
  model?: string | null;
}): boolean {
  if (!endpoint) {
    return false;
  }
  const normalized = endpoint.toLowerCase();

  /** Vertex AI authenticates with a service account, never with a user key. */
  if (normalized === 'vertexai') {
    return false;
  }
  if (normalized === EModelEndpoint.anthropic.toLowerCase() && isAnthropicVertex(appConfig)) {
    return false;
  }

  if (normalized === EModelEndpoint.azureOpenAI.toLowerCase()) {
    if (isUserProvidedAzureGroup(appConfig, model)) {
      return true;
    }
    return (
      isUserProvided(process.env.AZURE_API_KEY) || isUserProvided(process.env.AZURE_OPENAI_BASEURL)
    );
  }

  const envNames = BUILT_IN_CREDENTIAL_ENV[normalized];
  if (envNames) {
    return envNames.some((name) => isUserProvided(process.env[name]));
  }

  return isUserProvidedCustomEndpoint(appConfig, endpoint);
}

/**
 * The balance levers that apply to a request on `endpoint`: the fraction of
 * the standard cost it is charged, and whether the pre-flight balance check
 * is skipped.
 *
 * The bypass only applies to a user-provided request — an operator-paid one is
 * always admitted against the balance.
 */
export function resolveEndpointBalancePolicy({
  endpoint,
  appConfig,
  model,
}: {
  endpoint?: string | null;
  appConfig?: AppConfig;
  model?: string | null;
}): { balanceChargeFactor: number; bypassBalanceCheck: boolean } {
  const balanceConfig = getBalanceConfig(appConfig);
  const userProvided = isUserProvidedEndpoint({ endpoint, appConfig, model });
  const policy = resolveByokBalancePolicy(balanceConfig);
  return {
    balanceChargeFactor: resolveBalanceChargeFactor({
      balanceConfig,
      isUserProvided: userProvided,
    }),
    bypassBalanceCheck: userProvided && policy.bypassBalanceCheck,
  };
}

/**
 * Whether the credential a tool resolved came from the user rather than from
 * the operator's environment.
 *
 * A tool resolves its key from the first matching auth field, and the field
 * that matched is the one the operator would have configured. So the operator
 * pays when that field holds a real value in the environment, and the user
 * pays when the field is unset or explicitly marked `user_provided`.
 */
export function isUserProvidedToolCredential(field?: string | null): boolean {
  if (!field) {
    return false;
  }
  const value = process.env[field];
  return !value || value.trim() === '' || isUserProvided(value);
}

/**
 * The fraction of the standard cost a tool's usage is charged.
 *
 * A tool resolves one of several credential fields, and the operator pays for
 * the call when the field it ran with holds a real value in the environment —
 * the user pays when that field is unset or marked `user_provided`.
 */
export function resolveToolBalanceChargeFactor({
  authValues,
  authFieldOrder,
  balanceConfig,
}: {
  /** The resolved credential values, keyed by auth field. */
  authValues?: Record<string, string | undefined> | null;
  /** The fields the tool prefers, most preferred first. */
  authFieldOrder: string[];
  balanceConfig?: ByokBalanceConfig | Partial<TCustomConfig['balance']> | null;
}): number {
  const usedField = authFieldOrder.find((field) => !!authValues?.[field]);
  return resolveBalanceChargeFactor({
    balanceConfig,
    isUserProvided: isUserProvidedToolCredential(usedField),
  });
}

/**
 * A per-usage charge factor resolver for a graph of agents.
 *
 * A graph may mix user-provided and operator-paid agents, so a usage row is
 * charged at its own agent's factor. A usage row whose agent is unknown falls
 * back to the primary agent's factor.
 */
export function createAgentBalanceChargeFactorResolver({
  balanceConfig,
  appConfig,
  endpointByAgentId,
  fallbackEndpoint,
}: {
  balanceConfig?: ByokBalanceConfig | Partial<TCustomConfig['balance']> | null;
  appConfig?: AppConfig;
  /** The provider each agent runs on, keyed by agent id. */
  endpointByAgentId?: Map<string, string | undefined> | Record<string, string | undefined>;
  /** The primary agent's provider, used when a usage row names no known agent. */
  fallbackEndpoint?: string | null;
}): (usage: { agentId?: string | null; model?: string | null }) => number {
  const config = balanceConfig ?? getBalanceConfig(appConfig);

  const endpointFor = (agentId?: string | null): string | undefined => {
    if (agentId == null) {
      return fallbackEndpoint ?? undefined;
    }
    if (endpointByAgentId instanceof Map) {
      return endpointByAgentId.get(agentId) ?? fallbackEndpoint ?? undefined;
    }
    return endpointByAgentId?.[agentId] ?? fallbackEndpoint ?? undefined;
  };

  return (usage) =>
    resolveBalanceChargeFactor({
      balanceConfig: config,
      isUserProvided: isUserProvidedEndpoint({
        endpoint: endpointFor(usage?.agentId),
        appConfig,
        model: usage?.model,
      }),
    });
}
