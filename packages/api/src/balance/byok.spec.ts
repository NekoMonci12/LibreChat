import { EModelEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import {
  createAgentBalanceChargeFactorResolver,
  isUserProvidedEndpoint,
  isUserProvidedToolCredential,
  resolveBalanceChargeFactor,
  resolveByokBalancePolicy,
  resolveEndpointBalancePolicy,
  resolveToolBalanceChargeFactor,
} from './byok';

describe('byok balance policy', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('resolveByokBalancePolicy', () => {
    it('charges nothing and bypasses the check by default', () => {
      const policy = resolveByokBalancePolicy(undefined);
      expect(policy.chargeFactor).toBe(0);
      expect(policy.bypassBalanceCheck).toBe(true);
    });

    it('scales the charge factor from the configured percent', () => {
      expect(resolveByokBalancePolicy({ byokChargePercent: 50 }).chargeFactor).toBe(0.5);
      expect(resolveByokBalancePolicy({ byokChargePercent: 100 }).chargeFactor).toBe(1);
      expect(resolveByokBalancePolicy({ byokChargePercent: 0 }).chargeFactor).toBe(0);
    });

    it('clamps an out-of-range percent to the valid range', () => {
      expect(resolveByokBalancePolicy({ byokChargePercent: 150 }).chargeFactor).toBe(1);
      expect(resolveByokBalancePolicy({ byokChargePercent: -20 }).chargeFactor).toBe(0);
    });

    it('treats a non-numeric percent as unset', () => {
      const policy = resolveByokBalancePolicy({
        byokChargePercent: Number.NaN,
      });
      expect(policy.chargeFactor).toBe(0);
    });

    it('only bypasses the check when explicitly enabled', () => {
      expect(resolveByokBalancePolicy({ byokBypassBalanceCheck: false }).bypassBalanceCheck).toBe(
        false,
      );
      expect(resolveByokBalancePolicy({ byokBypassBalanceCheck: true }).bypassBalanceCheck).toBe(
        true,
      );
    });
  });

  describe('resolveBalanceChargeFactor', () => {
    it('charges the full standard cost for an operator-paid request', () => {
      const factor = resolveBalanceChargeFactor({
        balanceConfig: { byokChargePercent: 0 },
        isUserProvided: false,
      });
      expect(factor).toBe(1);
    });

    it('charges the BYOK fraction for a user-provided request', () => {
      const factor = resolveBalanceChargeFactor({
        balanceConfig: { byokChargePercent: 25 },
        isUserProvided: true,
      });
      expect(factor).toBe(0.25);
    });
  });

  describe('isUserProvidedEndpoint', () => {
    it('detects a user-provided OpenAI key', () => {
      process.env.OPENAI_API_KEY = 'user_provided';
      expect(isUserProvidedEndpoint({ endpoint: EModelEndpoint.openAI })).toBe(true);
    });

    it('reports an operator-provided key as not user-provided', () => {
      process.env.OPENAI_API_KEY = 'sk-operator-key';
      expect(isUserProvidedEndpoint({ endpoint: EModelEndpoint.openAI })).toBe(false);
    });

    it('matches the endpoint case-insensitively', () => {
      process.env.OPENAI_API_KEY = 'user_provided';
      expect(isUserProvidedEndpoint({ endpoint: 'OpenAI' })).toBe(true);
    });

    it('never treats Vertex AI as user-provided', () => {
      process.env.GOOGLE_KEY = 'user_provided';
      expect(isUserProvidedEndpoint({ endpoint: 'vertexai' })).toBe(false);
    });

    it('does not treat Anthropic on Vertex as user-provided', () => {
      process.env.ANTHROPIC_API_KEY = 'user_provided';
      const appConfig = {
        endpoints: { anthropic: { vertexConfig: { enabled: true } } },
      } as unknown as AppConfig;
      expect(isUserProvidedEndpoint({ endpoint: EModelEndpoint.anthropic, appConfig })).toBe(false);
    });

    it('treats Anthropic with a key as user-provided when not on Vertex', () => {
      process.env.ANTHROPIC_API_KEY = 'user_provided';
      const appConfig = {
        endpoints: { anthropic: { vertexConfig: { enabled: false } } },
      } as unknown as AppConfig;
      expect(isUserProvidedEndpoint({ endpoint: EModelEndpoint.anthropic, appConfig })).toBe(true);
    });

    it('reads the Azure group holding the key, not the endpoint flag', () => {
      process.env.AZURE_API_KEY = 'sk-operator-key';
      const appConfig = {
        endpoints: {
          azureOpenAI: {
            modelGroupMap: { 'gpt-4o': { group: 'user-group' } },
            groupMap: { 'user-group': { apiKey: 'user_provided' } },
          },
        },
      } as unknown as AppConfig;
      expect(
        isUserProvidedEndpoint({
          endpoint: EModelEndpoint.azureOpenAI,
          appConfig,
          model: 'gpt-4o',
        }),
      ).toBe(true);
    });

    it('falls back to the Azure environment when the model has no group', () => {
      delete process.env.AZURE_API_KEY;
      delete process.env.AZURE_OPENAI_BASEURL;
      const appConfig = {
        endpoints: { azureOpenAI: { modelGroupMap: {}, groupMap: {} } },
      } as unknown as AppConfig;
      expect(
        isUserProvidedEndpoint({
          endpoint: EModelEndpoint.azureOpenAI,
          appConfig,
          model: 'gpt-4o',
        }),
      ).toBe(false);

      process.env.AZURE_API_KEY = 'user_provided';
      expect(
        isUserProvidedEndpoint({
          endpoint: EModelEndpoint.azureOpenAI,
          appConfig,
          model: 'gpt-4o',
        }),
      ).toBe(true);
    });

    it('detects a user-provided custom endpoint key', () => {
      const appConfig = {
        endpoints: {
          custom: [
            { name: 'my-endpoint', apiKey: 'user_provided', baseURL: 'https://example.com' },
          ],
        },
      } as unknown as AppConfig;
      expect(isUserProvidedEndpoint({ endpoint: 'my-endpoint', appConfig })).toBe(true);
    });

    it('detects a user-provided custom endpoint base URL', () => {
      const appConfig = {
        endpoints: {
          custom: [{ name: 'my-endpoint', apiKey: 'sk-operator', baseURL: 'user_provided' }],
        },
      } as unknown as AppConfig;
      expect(isUserProvidedEndpoint({ endpoint: 'my-endpoint', appConfig })).toBe(true);
    });

    it('reports an operator-provided custom endpoint as not user-provided', () => {
      const appConfig = {
        endpoints: {
          custom: [{ name: 'my-endpoint', apiKey: 'sk-operator', baseURL: 'https://example.com' }],
        },
      } as unknown as AppConfig;
      expect(isUserProvidedEndpoint({ endpoint: 'my-endpoint', appConfig })).toBe(false);
    });

    it('returns false for an unknown endpoint', () => {
      expect(isUserProvidedEndpoint({ endpoint: 'not-a-real-endpoint' })).toBe(false);
      expect(isUserProvidedEndpoint({})).toBe(false);
    });
  });

  describe('resolveEndpointBalancePolicy', () => {
    it('charges the full cost and keeps the check for an operator-paid request', () => {
      process.env.OPENAI_API_KEY = 'sk-operator-key';
      const policy = resolveEndpointBalancePolicy({
        endpoint: EModelEndpoint.openAI,
        appConfig: { balance: { byokChargePercent: 0 } } as unknown as AppConfig,
      });
      expect(policy.balanceChargeFactor).toBe(1);
      expect(policy.bypassBalanceCheck).toBe(false);
    });

    it('frees and admits a user-provided request', () => {
      process.env.OPENAI_API_KEY = 'user_provided';
      const policy = resolveEndpointBalancePolicy({
        endpoint: EModelEndpoint.openAI,
        appConfig: { balance: { byokChargePercent: 0 } } as unknown as AppConfig,
      });
      expect(policy.balanceChargeFactor).toBe(0);
      expect(policy.bypassBalanceCheck).toBe(true);
    });

    it('keeps the check for a user-provided request when the bypass is off', () => {
      process.env.OPENAI_API_KEY = 'user_provided';
      const policy = resolveEndpointBalancePolicy({
        endpoint: EModelEndpoint.openAI,
        appConfig: {
          balance: { byokChargePercent: 100, byokBypassBalanceCheck: false },
        } as unknown as AppConfig,
      });
      expect(policy.balanceChargeFactor).toBe(1);
      expect(policy.bypassBalanceCheck).toBe(false);
    });
  });

  describe('createAgentBalanceChargeFactorResolver', () => {
    it('charges a usage row at its own agent factor', () => {
      process.env.OPENAI_API_KEY = 'user_provided';
      const resolver = createAgentBalanceChargeFactorResolver({
        balanceConfig: { byokChargePercent: 0 },
        endpointByAgentId: new Map([
          ['operator-agent', EModelEndpoint.anthropic],
          ['user-agent', EModelEndpoint.openAI],
        ]),
        fallbackEndpoint: EModelEndpoint.anthropic,
      });

      expect(resolver({ agentId: 'user-agent' })).toBe(0);
      expect(resolver({ agentId: 'operator-agent' })).toBe(1);
    });

    it('falls back to the primary agent factor for an unknown agent', () => {
      process.env.OPENAI_API_KEY = 'user_provided';
      const resolver = createAgentBalanceChargeFactorResolver({
        balanceConfig: { byokChargePercent: 0 },
        endpointByAgentId: new Map(),
        fallbackEndpoint: EModelEndpoint.openAI,
      });

      expect(resolver({ agentId: 'unknown-agent' })).toBe(0);
      expect(resolver({})).toBe(0);
    });

    it('charges the full cost when no agent endpoint is known', () => {
      const resolver = createAgentBalanceChargeFactorResolver({
        balanceConfig: { byokChargePercent: 0 },
      });
      expect(resolver({})).toBe(1);
    });
  });

  describe('isUserProvidedToolCredential', () => {
    it('reports an unset field as user-provided', () => {
      delete process.env.GEMINI_API_KEY;
      expect(isUserProvidedToolCredential('GEMINI_API_KEY')).toBe(true);
    });

    it('reports an explicitly user-provided field as user-provided', () => {
      process.env.GEMINI_API_KEY = 'user_provided';
      expect(isUserProvidedToolCredential('GEMINI_API_KEY')).toBe(true);
    });

    it('reports an operator-provided field as not user-provided', () => {
      process.env.GEMINI_API_KEY = 'sk-operator-key';
      expect(isUserProvidedToolCredential('GEMINI_API_KEY')).toBe(false);
    });

    it('reports a missing field name as not user-provided', () => {
      expect(isUserProvidedToolCredential(undefined)).toBe(false);
    });
  });

  describe('resolveToolBalanceChargeFactor', () => {
    it('charges the user rate when the tool ran on their own key', () => {
      process.env.GEMINI_API_KEY = 'user_provided';
      const factor = resolveToolBalanceChargeFactor({
        authValues: { GEMINI_API_KEY: 'user-key' },
        authFieldOrder: ['GEMINI_API_KEY', 'GOOGLE_KEY'],
        balanceConfig: { byokChargePercent: 0 },
      });
      expect(factor).toBe(0);
    });

    it('charges the full cost when the operator provided the key', () => {
      process.env.GEMINI_API_KEY = 'sk-operator-key';
      const factor = resolveToolBalanceChargeFactor({
        authValues: { GEMINI_API_KEY: 'operator-key' },
        authFieldOrder: ['GEMINI_API_KEY', 'GOOGLE_KEY'],
        balanceConfig: { byokChargePercent: 0 },
      });
      expect(factor).toBe(1);
    });

    it('falls through to the next field in preference order', () => {
      process.env.GEMINI_API_KEY = 'sk-operator-key';
      process.env.GOOGLE_KEY = 'user_provided';
      const factor = resolveToolBalanceChargeFactor({
        authValues: { GOOGLE_KEY: 'user-key' },
        authFieldOrder: ['GEMINI_API_KEY', 'GOOGLE_KEY'],
        balanceConfig: { byokChargePercent: 0 },
      });
      expect(factor).toBe(0);
    });
  });
});
