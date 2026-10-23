/**
 * Deployed installation and saved wire names. This is the frozen boundary for the
 * code rename, not a compatibility/alias map. Change these values only during an
 * owner-authorized installation cutover; migrations and historical evidence stay fixed.
 */
export const INSTALLATION_NAMES = /** @type {const} */ ({
  "environment": {
    "API_ENV_FILE": "GRAPHQL_API_ENV_FILE",
    "APP_MCP_DIRECTORY": "GRAPHQL_APP_MCP_DIRECTORY",
    "APP_MCP_TOKEN": "GRAPHQL_APP_MCP_TOKEN",
    "APP_TOKEN": "GRAPHQL_APP_TOKEN",
    "BROWSER_ORIGIN": "GRAPHQL_BROWSER_ORIGIN",
    "DENSE_IDLE_TIMEOUT_MS": "GRAPHQL_DENSE_IDLE_TIMEOUT_MS",
    "DENSE_ITEM_TIMEOUT_MS": "GRAPHQL_DENSE_ITEM_TIMEOUT_MS",
    "DENSE_UNIT_WORKERS": "GRAPHQL_DENSE_UNIT_WORKERS",
    "DEVICE_LISTENER_ENABLED": "GRAPHQL_DEVICE_LISTENER_ENABLED",
    "DEV_BROWSER_ACCESS": "GRAPHQL_DEV_BROWSER_ACCESS",
    "DEV_BROWSER_ORIGIN": "GRAPHQL_DEV_BROWSER_ORIGIN",
    "ENABLE_EXPERIMENTAL_CLAUDE_SDK": "GRAPHQL_ENABLE_EXPERIMENTAL_CLAUDE_SDK",
    "ENABLE_EXPERIMENTAL_CODEX_APP_SERVER": "GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER",
    "HEAVY_BASE_TMPDIR": "GRAPHQL_HEAVY_BASE_TMPDIR",
    "HEAVY_JOB_COMMON": "GRAPHQL_HEAVY_JOB_COMMON",
    "HEAVY_JOB_TOKEN": "GRAPHQL_HEAVY_JOB_TOKEN",
    "INTEGRATION_ARCHIVE_BYTES": "FOREMAN_CODE_INTEGRATION_ARCHIVE_BYTES",
    "INTEGRATION_DURATIONS": "FOREMAN_CODE_INTEGRATION_DURATIONS",
    "INTEGRATION_DURATIONS_OUTPUT": "FOREMAN_CODE_INTEGRATION_DURATIONS_OUTPUT",
    "INTEGRATION_FAILED_LOG": "GRAPHQL_INTEGRATION_FAILED_LOG",
    "INTEGRATION_LOG_BYTES": "FOREMAN_CODE_INTEGRATION_LOG_BYTES",
    "INTEGRATION_REPORT_BYTES": "FOREMAN_CODE_INTEGRATION_REPORT_BYTES",
    "INTEGRATION_SHARDS": "GRAPHQL_INTEGRATION_SHARDS",
    "INTEGRATION_START_AT": "GRAPHQL_INTEGRATION_START_AT",
    "INTEGRATION_TEST_NAME_PATTERN": "FOREMAN_CODE_INTEGRATION_TEST_NAME_PATTERN",
    "INTEGRATION_TEST_RESULTS_OUTPUT": "FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT",
    "JOB_INPUT_MANIFEST": "GRAPHQL_JOB_INPUT_MANIFEST",
    "LAPTOP_EXECUTION_ENABLED": "GRAPHQL_LAPTOP_EXECUTION_ENABLED",
    "LOCAL_PRODUCTION": "GRAPHQL_LOCAL_PRODUCTION",
    "MCP_TOKEN": "GRAPHQL_MCP_TOKEN",
    "OPERATOR_MCP_TOKEN": "GRAPHQL_OPERATOR_MCP_TOKEN",
    "OPERATOR_TOKEN": "GRAPHQL_OPERATOR_TOKEN",
    "PRODUCTION_DB_PASSWORD": "GRAPHQL_PRODUCTION_DB_PASSWORD",
    "TEST_OWNER": "FOREMAN_CODE_TEST_OWNER",
    "TEST_PROFILE_PATH": "GRAPHQL_TEST_PROFILE_PATH",
    "TEST_ROOT": "FOREMAN_CODE_TEST_ROOT",
    "TEST_WORKER_RELEASE": "FOREMAN_CODE_TEST_WORKER_RELEASE",
    "WEB_DIST": "GRAPHQL_WEB_DIST",
    "WEB_PORT": "GRAPHQL_WEB_PORT",
    "WORKER_ARTIFACT_DIRECTORY": "FOREMAN_CODE_WORKER_ARTIFACT_DIRECTORY",
    "WORKER_BUILD_COMMIT": "GRAPHQL_WORKER_BUILD_COMMIT",
    "WORKER_CODEX_BINARY": "FOREMAN_CODE_WORKER_CODEX_BINARY"
  },
  "fields": {
    "agentTools": "graphqlTools",
    "claudeMcp": "graphqlMcp",
    "nodeTools": "nodeGraphqlTools"
  },
  "desktopClass": "graphql-production",
  "compose": {
    "development": "graphql",
    "production": "graphql-local-production",
    "test": "graphql-tests",
    "developmentVolume": "graphql-postgres-data",
    "productionVolume": "graphql-production-postgres",
    "productionLabel": "io.graphql.environment=production"
  },
  "database": {
    "development": "graphql",
    "production": "graphql_production",
    "testAdmin": "graphql_test_admin",
    "testPassword": "graphql_test_disposable_only",
    "testControl": "graphql_test_control"
  },
  "paths": {
    "storageDirectory": "graphql",
    "productionApp": ".local/lib/graphql-production",
    "productionCurrent": ".local/lib/graphql-production/current",
    "productionState": ".local/state/graphql-production",
    "productionData": ".local/share/graphql-production",
    "productionConfig": ".config/graphql-production",
    "productionLogs": ".local/state/graphql-production/logs",
    "productionBrowserRuntime": ".local/lib/graphql-production/browser-runtime",
    "mcpDirectory": ".local/share/graphql/mcp",
    "mcpLauncher": ".local/share/graphql/mcp/launcher.mjs",
    "productionMcp": ".local/state/graphql-production/mcp",
    "workerApp": ".local/lib/graphql-worker",
    "workerState": ".local/state/graphql-worker",
    "workerUnit": ".config/systemd/user/graphql-worker.service",
    "ciData": ".local/share/graphql-ci",
    "ciManagedData": ".local/share/graphql-ci/volume/managed",
    "rsyncSuffix": "/.local/share/graphql-tools/rsync/3.5.1/bin/rsync",
    "companionDesktop": ".local/share/applications/graphql-companion.desktop",
    "companionIcon": ".local/share/icons/hicolor/scalable/apps/graphql-companion.svg",
    "productionDesktop": "applications/graphql-production.desktop",
    "productionAutostart": "autostart/graphql-production.desktop",
    "productionIcon": "icons/hicolor/scalable/apps/graphql-production.svg",
    "jobInputs": ".graphql-job-inputs",
    "workflowRuntime": ".graphql-workflow-runtime.json",
    "workspaceRecord": ".graphql-workspace.json",
    "testOwner": ".graphql-test-owner.json",
    "testCleanup": ".graphql-test-cleanup",
    "ciRoot": "/opt/graphql-ci",
    "ciTools": "/opt/graphql-ci/tools/",
    "ciCodex": "/opt/graphql-ci/tools/codex",
    "verificationRunner": "/opt/graphql-ci/verification/verify-repository.mjs",
    "verificationObservation": "/opt/graphql-ci/verification-observation.mjs",
    "verificationContext": ".graphql-job-inputs/verification.json",
    "qualificationContext": ".graphql-job-inputs/qualification-context.json",
    "containerJobInputs": "/workspace/.graphql-job-inputs",
    "containerQualificationContext": "/workspace/.graphql-job-inputs/qualification-context.json",
    "privateGit": "/graphql-job-git"
  },
  "artifacts": {
    "mcpLauncher": "artifacts/graphql-mcp.mjs",
    "previousMcpLauncher": "previous/artifacts/graphql-mcp.mjs",
    "workerService": "artifacts/graphql-worker.service.in",
    "icon": "artifacts/graphql.svg"
  },
  "services": {
    "database": "graphql-production-db.service",
    "api": "graphql-operator-api.service",
    "worker": "graphql-worker.service",
    "previousWorker": "graphql-worker.service.previous"
  },
  "launchers": {
    "production": "graphql",
    "companion": "graphql-companion"
  },
  "mcp": {
    "server": "graphql",
    "app": "graphql-app",
    "operator": "graphql-operator",
    "files": "graphql-files",
    "artifactTransfers": "graphql-artifact-transfers",
    "artifactInputs": "graphql-artifact-inputs",
    "artifactPublications": "graphql-artifact-publications",
    "jobOutputs": "graphql-worker-job-outputs"
  },
  "protocol": {
    "apiService": "graphql-api",
    "workerAudience": "graphql-worker",
    "workerCredential": "graphql-worker-credential-v1",
    "mainAudience": "graphql-worker-main-v1",
    "enrollmentAudience": "graphql-worker-main-enrollment-v1",
    "pairSignature": "graphql-worker-pair-v1",
    "cancellationGrant": "graphql-job-cancellation-grant-v1",
    "cancellationClosure": "graphql-job-cancellation-closure-v1",
    "claudeMessage": "graphql-claude-message-v2",
    "companionSession": "x-graphql-companion-session",
    "permissionHandling": "graphql_routed",
    "toolRoleError": "GRAPHQL_TOOL_NOT_ALLOWED_FOR_ROLE",
    "editIntent": "graphql-edit-intent",
    "workflowNoticeStart": "BEGIN GRAPHQL WORKFLOW SYSTEM NOTICE",
    "workflowNoticeEnd": "END GRAPHQL WORKFLOW SYSTEM NOTICE",
    "harnessSettingsLock": "graphql:harness-mcp-settings"
  },
  "browserStorage": {
    "operatorOutbox": "graphql.operator-outbox.v1",
    "theme": "graphql-theme",
    "navigationCollapsed": "graphql-navigation-collapsed",
    "navigationWidth": "graphql-navigation-width",
    "identityEpoch": "graphql.identity-epoch",
    "identityChanged": "graphql:identity-changed",
    "chatPrefix": "graphql.chat:",
    "chatBinding": "graphql.chat-instance-binding"
  }
})

/** Embed the frozen names when shipping a standalone launcher or Worker script.
 * @param {string} source
 */
export function standaloneInstallationSource(source) {
  return source.replace(/^import \{ INSTALLATION_NAMES \} from ['"][^'"\n]*(?:installationNames\.mjs|installation-names)['"]\r?\n/m,
    `const INSTALLATION_NAMES = ${JSON.stringify(INSTALLATION_NAMES)}\n`)
}
