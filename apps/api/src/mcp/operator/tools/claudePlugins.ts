import {
  ClaudePluginListInputSchema, ClaudePluginListResultSchema,
  ClaudePluginChangeInputSchema, ClaudePluginChangeResultSchema,
  ClaudePluginMarketplaceAddInputSchema, ClaudePluginMarketplaceAddResultSchema,
} from '@foreman-code/contracts/management'
import { defineOperatorTool } from '../definition.js'

export const claudePluginTools = [
  defineOperatorTool({
    name: 'claude_plugins_list',
    requires: [['harnesses:read', 'global']],
    enabled: s => !!s.harnessSettings?.claudePlugins,
    description: 'List installed or available user-scope Claude Code plugins and marketplaces on Main. Supports search and pagination. The returned revision can optionally guard changes against stale state. Native Claude is the source of truth.',
    inputSchema: ClaudePluginListInputSchema, outputSchema: ClaudePluginListResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input, { extra }) => context.services.harnessSettings!.claudePlugins!.list(context.principal, input, extra.mcpReq.signal),
  }),
  defineOperatorTool({
    name: 'claude_plugin_change',
    requires: [['harnesses:update', 'global'], ['harnesses:read', 'global']],
    enabled: s => !!s.harnessSettings?.claudePlugins,
    description: 'Install, uninstall, enable or disable a user-scope Claude Code plugin on Main for new Claude sessions. A command_review result needs review of the shown marketplace command; accept its hash with a new commandId.',
    detail: 'An uncertain result is checked again with the same commandId without repeating the native command. The Computers screen’s sync-plugins task copies Main plugins to paired computers.',
    inputSchema: ClaudePluginChangeInputSchema, outputSchema: ClaudePluginChangeResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    run: (context, input) => context.services.harnessSettings!.claudePlugins!.change(context.principal, input, 'mcp'),
  }),
  defineOperatorTool({
    name: 'claude_plugin_marketplace_add',
    requires: [['harnesses:update', 'global'], ['harnesses:read', 'global']],
    enabled: s => !!s.harnessSettings?.claudePlugins,
    description: 'Add a Git or GitHub Claude Code plugin marketplace on Main (no local paths) and return the saved marketplace list.',
    detail: 'Uncertain results are checked again with the same commandId without repeating the addition.',
    inputSchema: ClaudePluginMarketplaceAddInputSchema, outputSchema: ClaudePluginMarketplaceAddResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: (context, input) => context.services.harnessSettings!.claudePlugins!.addMarketplace(context.principal, input, 'mcp'),
  }),
]
