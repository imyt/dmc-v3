// Contract-test template. Copy per module: call the handler (or the running app), then
// assert the body matches the OpenAPI schema for that path, method and status.
import { describe, expect, it } from 'vitest';
import { checkResponse, loadSpec } from '../../packages/contracts/src/index';

const spec = loadSpec();

describe('contract template', () => {
  it('accepts a conforming response', () => {
    expect(checkResponse(spec, '/v1/health', 'get', 200, { status: 'ok', version: '0.1.0' })).toEqual([]);
  });
  it('flags a nonconforming response', () => {
    expect(checkResponse(spec, '/v1/health', 'get', 200, { status: 'down' }).length).toBeGreaterThan(0);
  });
  it('checks nested list items', () => {
    const bad = { items: [{ id: 'x' }], next_cursor: null };
    expect(checkResponse(spec, '/v1/examples', 'get', 200, bad).length).toBeGreaterThan(0);
    const good = { items: [{ id: 'x', name: 'n', version: 1 }], next_cursor: null };
    expect(checkResponse(spec, '/v1/examples', 'get', 200, good)).toEqual([]);
  });
  it('rejects paths that are not in the contract', () => {
    expect(checkResponse(spec, '/v1/nope', 'get', 200, {})[0]).toMatch(/not in the contract/);
  });
});
