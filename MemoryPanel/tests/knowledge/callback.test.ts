import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { registerKnowledgeCallbackRoutes } from '../../src/panel/http/routes/knowledge/callback-routes.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';

function fixture() {
  const app = new Hono();
  const kernelCreate = vi.fn(async () => ({ code: 0, message: 'ok', data: null }));
  const codeGraphGet = vi.fn(async () => ({
    code_graph_id: 'cg-1', team_id: 'team-1', repo_name: 'repo', repo_url: 'https://example.com/repo',
    branch: 'main', owner_user_id: 'user-1', service_url: 'https://example.com/knowledge', status: 'ready',
  }));
  const resolve = vi.fn(() => ({ instance_id: 'svc-1', gateway_endpoint: 'https://example.com', api_key: 'key' }));
  const deps = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config: { metadataRemoteTimeoutMs: 5000 },
    instanceRegistry: { resolve },
    knowledgeClientFactory: () => ({ codeGraphGet }),
    kernelHttp: { postEnvelope: kernelCreate },
    knowledgeTaskRegistry: { peek: () => null },
  } as unknown as PanelDeps;
  registerKnowledgeCallbackRoutes(app, deps);
  const post = (body: Record<string, unknown>) => app.request('/knowledge/status-callback', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { post, kernelCreate, codeGraphGet, resolve };
}

describe('CodeGraph status callback', () => {
  it('records a preserved refresh failure without rewriting the previous entity', async () => {
    const f = fixture();
    const response = await f.post({
      knowledge_id: 'cg-1', service_id: 'svc-1', type: 'code-graph', status: 'ready',
      event: 'refresh_failed', summary: 'old summary', sync_error: 'Git unavailable',
    });

    expect(response.status).toBe(200);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.codeGraphGet).not.toHaveBeenCalled();
    expect(f.kernelCreate).not.toHaveBeenCalled();
  });

  it('still writes the entity for a later successful refresh', async () => {
    const f = fixture();
    const response = await f.post({
      knowledge_id: 'cg-1', service_id: 'svc-1', type: 'code-graph', status: 'ready',
      summary: 'new summary', sync_error: null,
    });

    expect(response.status).toBe(200);
    expect(f.codeGraphGet).toHaveBeenCalledOnce();
    expect(f.kernelCreate).toHaveBeenCalledOnce();
  });
});
