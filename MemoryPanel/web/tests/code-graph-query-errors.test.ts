import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

describe('CodeGraph query error in the browser client', () => {
  it.each([
    { status: 503, errorCode: 'CODE_GRAPH_INDEX_BUILDING' },
    { status: 409, errorCode: 'CODE_GRAPH_INDEX_FAILED' },
  ])('retains $errorCode from the Panel envelope', async ({ status, errorCode }) => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.stubGlobal('navigator', { language: 'en-US' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      code: status,
      message: 'index state',
      request_id: 'req-1',
      error_code: errorCode,
      data: null,
    }, { status })));

    const { knowledgeApi, KnowledgeApiError } = await import('../src/lib/api/knowledge-api');
    await expect(knowledgeApi.code.search({ codeGraphId: 'cg-1', query: 'foo' })).rejects.toMatchObject({
      name: KnowledgeApiError.name,
      code: status,
      errorCode,
      requestId: 'req-1',
    });
  });

  it('leaves an unrelated 503 without a CodeGraph error code', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.stubGlobal('navigator', { language: 'en-US' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      code: 503, message: 'service unavailable', request_id: 'req-2', data: null,
    }, { status: 503 })));

    const { knowledgeApi } = await import('../src/lib/api/knowledge-api');
    await expect(knowledgeApi.code.explore('cg-1', 'foo')).rejects.toMatchObject({
      code: 503,
      errorCode: undefined,
    });
  });
});
