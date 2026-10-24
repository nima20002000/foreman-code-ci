import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

import type { AppMcpServices } from '../mcp/app/types.js'
import type { OperatorServices } from '../mcp/operator/types.js'
import { registerForemanMcp, type ForemanMcpServices } from '../mcp/unified/transport.js'
import { requirePrincipal } from '../modules/access/http.js'
import type { LocalHumanAccess } from '../modules/access/localHuman.js'
import type { PostgresAccessService } from '../modules/access/postgres.js'
import { registerCircleAccountRoutes, registerHostCiRoutes } from '../modules/ci/http.js'
import { registerDeviceManagementRoutes } from '../modules/devices/management.js'
import { registerTrustedConnectionRoutes, type TrustedConnectionManagementService } from '../modules/devices/trustedConnectionManagement.js'
import type { ProductionFileStorage } from '../modules/files/production.js'
import type { FileRetentionService } from '../modules/files/retention.js'
import { registerFileToolsMcp } from '../modules/files/tools/mcp.js'
import { registerHarnessRegistryRoutes } from '../modules/harnesses/registryManagement.js'
import type { McpDetectionService } from '../modules/harnesses/mcpDetection.js'
import type { JobRuntimeProfiles } from '../modules/jobs/runtimeProfiles.js'
import type { CiRuntimeProvisioner } from '../modules/ci/types.js'
import { registerNodePlacementChoicesRoutes, registerRunPlacementRoutes } from '../modules/placement/transports.js'
import type { ProductionWorkflowArtifacts } from '../modules/runs/remote/workflowArtifactProduction.js'
import { registerWorkspaceRootRoutes } from '../modules/workspace-roots/transports.js'
import { registerAgentChatRoutes } from './agentChat.js'
import { registerAppErrorRoutes } from './appErrors.js'
import { registerProductionBrowserRoutes } from './browserComposition.js'
import { registerBugReportRoutes } from './bugReports.js'
import { registerBuildComputerRoutes } from './buildComputers.js'
import { registerComputerAccountsRoutes } from './computerAccounts.js'
import { registerComputerActivityRoutes } from './computerActivity.js'
import { registerComputerMaintenanceRoutes } from './computerMaintenance.js'
import { registerComputerSyncRoutes } from './computerSync.js'
import { registerFileReferenceRoutes } from './fileReferences.js'
import { registerFileRetentionRoutes } from './fileRetention.js'
import { registerFileRoutes } from './files.js'
import { registerHealthRoutes, type HealthRouteServices } from './health.js'
import { registerJobRoutes } from './jobs.js'
import { registerJobRuntimeProfileRoutes } from './jobRuntimeProfiles.js'
import { registerManagementRoutes } from './management.js'
import { registerMcpDetectionRoute } from './mcpDetection.js'
import { registerMemoryBoardRoutes } from './memoryBoards.js'
import { registerProductRoutes, type ProductServices } from './product.js'
import { registerProviderAccountRoutes } from './providerAccounts.js'
import { registerResourceTelemetryRoutes } from './resourceTelemetry.js'
import { registerResourceTelemetrySelectorRoutes } from './resourceTelemetrySelector.js'
import { registerRunGraphRoutes } from './runGraph.js'
import { registerSourceRoutes } from './sources.js'
import { registerUserInteractions } from './userInteractions.js'
import { registerWorkflowChatRoutes } from './workflowChat.js'
import { registerWorkflowExecutionChatRoutes } from './workflowExecutionChat.js'
import { registerWorkflowHierarchyRoutes } from './workflowHierarchy.js'
import { registerWorkflowKanbanRoutes } from './workflowKanban.js'
import { registerWorkflowScheduleRoutes } from './workflowSchedules.js'
import { registerWorkspaceRepositoryRoutes } from './workspaceRepository.js'

/** Route groups that only the production composition mounts. Some exist only after startup. */
export interface ProductionRouteServices {
  fileRetention?: FileRetentionService
  files?: ProductionFileStorage
  workflowArtifacts?: ProductionWorkflowArtifacts
  trustedConnections?: TrustedConnectionManagementService
  resourceTelemetry?: NonNullable<OperatorServices['resourceTelemetry']>
  jobRuntimeProfiles?: { profiles: JobRuntimeProfiles; ciRuntime?: CiRuntimeProvisioner }
}

export interface ApiRouteServices extends HealthRouteServices {
  localHuman?: LocalHumanAccess
  browserOrigin?: string
  product?: ProductServices
  operator?: { access: PostgresAccessService; services: OperatorServices }
  appMcp?: AppMcpServices
  workerArtifacts?: ForemanMcpServices['workerArtifacts']
  mcpDetection?: { pool: pg.Pool; service: McpDetectionService }
  production?: ProductionRouteServices
}

const registeredGroups = new WeakMap<FastifyInstance, Set<string>>()

/**
 * The one place that mounts HTTP routes. Each group is registered once per app, as soon as its
 * service is available: callers repeat this call when startup publishes more services.
 */
export function registerApiRoutes(app: FastifyInstance, services: ApiRouteServices): void {
  const registered = registeredGroups.get(app) ?? new Set<string>()
  registeredGroups.set(app, registered)
  const group = (name: string, register: () => void): void => {
    if (registered.has(name)) return
    registered.add(name)
    register()
  }
  const { operator, product, appMcp, production } = services
  const operatorServices = operator?.services

  group('health', () => registerHealthRoutes(app, services))

  if (operator && operatorServices?.browser) {
    const browser = operatorServices.browser
    group('browser', () => registerProductionBrowserRoutes(app, browser, { access: operator.access,
      localHuman: services.localHuman, browserOrigin: services.browserOrigin, runtimeIdentity: services.runtimeIdentity }))
  }
  if (operatorServices?.memoryBoards) {
    const memoryBoards = operatorServices.memoryBoards
    group('memory-boards', () => registerMemoryBoardRoutes(app, memoryBoards))
  }
  if (operatorServices) {
    group('host-ci', () => registerHostCiRoutes(app, { services: operatorServices, principal: requirePrincipal }))
    group('management', () => registerManagementRoutes(app, operatorServices))
    group('app-errors', () => registerAppErrorRoutes(app))
    registerOperatorGroups(app, operatorServices, group)
  }
  if (operator && services.mcpDetection) {
    const { service } = services.mcpDetection, locations = operator.services.locations
    group('mcp-detection', () => registerMcpDetectionRoute(app, locations, service, operator.services.harnessSettings?.mcp))
  }
  if (operatorServices?.workflowChat) {
    const workflowChat = operatorServices.workflowChat
    group('workflow-chat', () => registerWorkflowChatRoutes(app, workflowChat))
  }
  if (operatorServices?.agentChat) {
    const agentChat = operatorServices.agentChat
    group('agent-chat', () => registerAgentChatRoutes(app, agentChat))
  }
  if (operator && product?.interactions) {
    const interactions = product.interactions
    group('user-interactions', () => registerUserInteractions(app, interactions))
  }
  if (product) group('product', () => registerProductRoutes(app, product, operatorServices))
  if (operator || appMcp) group('mcp', () => {
    const bugReports = appMcp?.bugReports ?? operatorServices?.bugReports
    const commands = appMcp?.commands ?? operatorServices?.commands
    registerForemanMcp(app, {
      access: (operator?.access ?? appMcp?.access)!,
      ...(operator ? { operator: Object.assign(operator.services, { workerToolsMcpImplemented: Boolean(appMcp) }) } : {}),
      ...(appMcp ? { interactions: appMcp.interactions } : {}),
      ...(appMcp?.references ? { references: appMcp.references } : {}),
      ...(bugReports ? { bugReports } : {}),
      ...(commands ? { commands } : {}),
      ...(services.workerArtifacts ? { workerArtifacts: services.workerArtifacts } : {}),
    })
  })
  if (production) registerProductionGroups(app, production, operatorServices, group)
}

type Group = (name: string, register: () => void) => void

/** Operator management groups; startup publishes several of these services later. */
function registerOperatorGroups(app: FastifyInstance, services: OperatorServices, group: Group): void {
  const principal = async (request: Parameters<typeof requirePrincipal>[0]) => requirePrincipal(request)
  const { circleAccounts, bugReports, harnessRegistry, computerActivity, computerAccounts, computerMaintenance,
    computerSync, buildComputers, devices, workspaceRepositories, workspaceRoots, sources, jobs, providerAccounts,
    runPlacements, placementChoices, workflowHierarchy, executionChat, runGraph } = services
  if (circleAccounts) group('circle-accounts', () => registerCircleAccountRoutes(app, { service: circleAccounts, principal: requirePrincipal }))
  if (bugReports) group('bug-reports', () => registerBugReportRoutes(app, bugReports))
  if (harnessRegistry) group('harness-registry', () => registerHarnessRegistryRoutes(app, harnessRegistry, principal))
  if (computerActivity) group('computer-activity', () => registerComputerActivityRoutes(app, computerActivity))
  if (computerAccounts) group('computer-accounts', () => registerComputerAccountsRoutes(app, computerAccounts))
  if (computerMaintenance) group('computer-maintenance', () => registerComputerMaintenanceRoutes(app, computerMaintenance))
  if (computerSync) group('computer-sync', () => registerComputerSyncRoutes(app, computerSync))
  if (buildComputers) group('build-computers', () => registerBuildComputerRoutes(app, buildComputers))
  if (devices) group('devices', () => registerDeviceManagementRoutes(app, devices, principal))
  if (workspaceRepositories) group('workspace-repositories', () => registerWorkspaceRepositoryRoutes(app, workspaceRepositories))
  if (workspaceRoots) group('workspace-roots', () => registerWorkspaceRootRoutes(app, workspaceRoots))
  if (sources) group('sources', () => registerSourceRoutes(app, sources))
  if (jobs) group('jobs', () => registerJobRoutes(app, jobs))
  if (providerAccounts) group('provider-accounts', () => registerProviderAccountRoutes(app, providerAccounts))
  if (runPlacements) group('run-placements', () => registerRunPlacementRoutes(app, runPlacements))
  if (placementChoices) group('placement-choices', () => registerNodePlacementChoicesRoutes(app, placementChoices))
  const schedules = services.workflows?.schedules, kanban = services.workflows?.kanban
  if (schedules) group('workflow-schedules', () => registerWorkflowScheduleRoutes(app, schedules))
  if (kanban) group('workflow-kanban', () => registerWorkflowKanbanRoutes(app, kanban))
  if (workflowHierarchy) group('workflow-hierarchy', () => registerWorkflowHierarchyRoutes(app, workflowHierarchy))
  if (executionChat) group('execution-chat', () => registerWorkflowExecutionChatRoutes(app, executionChat))
  if (runGraph) group('run-graph', () => registerRunGraphRoutes(app, runGraph,
    (principalId, code, route) => services.commands.recordDenied(principalId, 'http', code, route)))
}

function registerProductionGroups(app: FastifyInstance, production: ProductionRouteServices,
  operator: OperatorServices | undefined, group: Group): void {
  const { fileRetention, files, workflowArtifacts, trustedConnections, resourceTelemetry, jobRuntimeProfiles } = production
  if (fileRetention) group('file-retention', () => registerFileRetentionRoutes(app, fileRetention))
  if (files) group('files', () => {
    registerFileRoutes(app, files.service)
    registerFileReferenceRoutes(app, files.references)
    registerFileToolsMcp(app, files.tools)
  })
  if (workflowArtifacts) group('workflow-artifacts', () => workflowArtifacts.registerRoutes(app))
  if (trustedConnections) group('trusted-connections', () => registerTrustedConnectionRoutes(app, trustedConnections,
    async request => request.reauthorizeOperator ? request.reauthorizeOperator() : requirePrincipal(request)))
  if (jobRuntimeProfiles) group('job-runtime-profiles', () =>
    registerJobRuntimeProfileRoutes(app, jobRuntimeProfiles.profiles, jobRuntimeProfiles.ciRuntime))
  const commands = operator?.commands
  if (resourceTelemetry && commands) group('resource-telemetry', () => {
    registerResourceTelemetryRoutes(app, resourceTelemetry.reads, {
      record: (principalId, source, selectorKey) => commands.recordDenied(principalId, source, 'resource_telemetry_read', selectorKey),
    })
    registerResourceTelemetrySelectorRoutes(app, resourceTelemetry.selectors, {
      record: (principalId, source, selectorKey) => commands.recordDenied(principalId, source, 'resource_telemetry_selector_get', selectorKey),
    })
  })
}
