import assert from 'node:assert/strict';
import test from 'node:test';
import { appMcpDirectory } from '@foreman-code/contracts/product-environment-node';

test('Worker harnesses use the deployed managed MCP directory even when the other spelling is present', () => {
  assert.equal(appMcpDirectory({ FOREMAN_CODE_APP_MCP_DIRECTORY: '/installed/worker/mcp',
    GRAPHQL_APP_MCP_DIRECTORY: '/wrong/mcp' }), '/installed/worker/mcp');
  assert.throws(() => appMcpDirectory({ FOREMAN_CODE_APP_MCP_DIRECTORY: 'relative/mcp' }), /absolute directory/);
});
