import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetAgentModelConfig = vi.fn<() => string | undefined>();
const mockGetLightModelConfig = vi.fn<() => string | undefined>();
const mockGetDedupModelConfig = vi.fn<() => string | undefined>();

vi.mock('../../src/config/env.js', () => ({
  getAgentModelConfig: mockGetAgentModelConfig,
  getLightModelConfig: mockGetLightModelConfig,
  getDedupModelConfig: mockGetDedupModelConfig,
}));

describe('review model resolution', () => {
  beforeEach(() => {
    mockGetAgentModelConfig.mockReset();
    mockGetLightModelConfig.mockReset();
    mockGetDedupModelConfig.mockReset();
  });

  it('prefers scoped configured model for each review category', async () => {
    mockGetAgentModelConfig.mockReturnValue('agent-model');
    mockGetLightModelConfig.mockReturnValue('light-model');
    mockGetDedupModelConfig.mockReturnValue('dedup-model');

    const { getAgentModel, getLightModel, getRealtimeDedupModel } = await import(
      '../../src/review/constants.js'
    );

    expect(getAgentModel()).toBe('agent-model');
    expect(getLightModel()).toBe('light-model');
    expect(getRealtimeDedupModel()).toBe('dedup-model');
  });

  it('falls back to built-in defaults when no configured model exists', async () => {
    mockGetAgentModelConfig.mockReturnValue(undefined);
    mockGetLightModelConfig.mockReturnValue(undefined);
    mockGetDedupModelConfig.mockReturnValue(undefined);

    const {
      DEFAULT_AGENT_MODEL,
      DEFAULT_LIGHT_MODEL,
      DEFAULT_REALTIME_DEDUP_MODEL,
      getAgentModel,
      getLightModel,
      getRealtimeDedupModel,
    } = await import('../../src/review/constants.js');

    expect(getAgentModel()).toBe(DEFAULT_AGENT_MODEL);
    expect(getLightModel()).toBe(DEFAULT_LIGHT_MODEL);
    expect(getRealtimeDedupModel()).toBe(DEFAULT_REALTIME_DEDUP_MODEL);
  });
});
