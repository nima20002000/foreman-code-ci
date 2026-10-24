import { z } from 'zod';
import { APP_MCP_TOKEN_NAMES } from './product.js';
import { INSTALLATION_NAMES } from './installationNames.mjs';

/** Credential mechanism evidence only; resolved credentials never cross this boundary. */
export const McpCredentialArrangementSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('environment_variable'),
    environmentVariable: z.enum([...APP_MCP_TOKEN_NAMES, INSTALLATION_NAMES.environment.MCP_TOKEN]),
  }).strict(),
  z.object({ kind: z.literal('scoped_http_header') }).strict(),
  z.object({ kind: z.literal('unknown') }).strict(),
]);
export type McpCredentialArrangement = z.infer<typeof McpCredentialArrangementSchema>;

export const PairedMcpEndpointSchema = z.object({ mainId: z.uuid(), deviceId: z.uuid(),
  configuredEndpoint: z.url(), nativeEndpoint: z.url().refine(value => {
    const url = new URL(value)
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && url.pathname === '/mcp' && !url.username && !url.password && !url.search && !url.hash
  }, 'A private worker MCP endpoint is required'),
}).strict();
export type PairedMcpEndpoint = z.infer<typeof PairedMcpEndpointSchema>;
