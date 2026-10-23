import { JobRuntimeApprovalRecordSchema, JobRuntimeProfileRecordSchema, JobRuntimeProfileListRecordSchema,
  JobRuntimeProfileSaveRecordSchema, JobRuntimeQualificationReadRecordSchema }
  from '@foreman-code/contracts/job-verification-runtime'
import type { McpServer, ServerContext, StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { JobRuntimeQualificationRequestSchema, JobRuntimeQualificationCommandSchema } from '@foreman-code/contracts/job-runtime'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import { hasAction, isAuthorized, type AuthorizedResource } from '../../../modules/access/policy.js'
import type { JobRuntimeProfiles } from '../../../modules/jobs/runtimeProfiles.js'
import type { CiEnrollment, CiRuntimeProvisioner } from '../../../modules/ci/types.js'
import { CI_ENROLLMENT_TOOL_SPECS, COMPUTER_PREPARATION_TOOL_SPECS, ciToolInputSchema, type CiToolSpec }
  from '../../../modules/ci/tools.js'
import type { PostgresCommandCoordinator } from '../../../modules/commands/postgres.js'
import { DomainError } from '../../../modules/errors.js'
import { toolFailure, toolResult } from '../../shared/results.js'
export const JOB_RUNTIME_TOOLS=['job_runtime_profile_list','job_runtime_profile_save','job_runtime_qualification_request','job_runtime_qualification_run','job_runtime_qualification_get','build_computer_prepare','build_computer_prepare_get','ci_enrollment_get','ci_enrollment_update'] as const
export type JobRuntimeToolName=typeof JOB_RUNTIME_TOOLS[number]
interface Context {principal:ManagementPrincipal;services:{jobRuntimeProfiles?:JobRuntimeProfiles;ciRuntime?:CiRuntimeProvisioner;ciEnrollment?:CiEnrollment;commands:PostgresCommandCoordinator}}
const action=(name:JobRuntimeToolName)=>name==='job_runtime_profile_list'||name==='job_runtime_qualification_get'||name==='build_computer_prepare_get'?'job_definitions:read' as const:'job_definitions:write' as const
// CI's own tools among these: workspace CI enrollment and Main's legacy runtime preparation.
const ciSpecs: readonly CiToolSpec<never>[] = [...CI_ENROLLMENT_TOOL_SPECS, ...COMPUTER_PREPARATION_TOOL_SPECS]
const ciSpec = (name: JobRuntimeToolName) => ciSpecs.find(spec => spec.name === name)
function requiredActions(name: JobRuntimeToolName): ManagementAction[] {
  const spec = ciSpec(name)
  if (spec) return [...spec.requires]
  if (name === 'job_runtime_profile_save') return [action(name), 'sources:read', 'source_roots:read']
  return [action(name)]
}
export function jobRuntimeToolAvailable(context:Context,name:JobRuntimeToolName,resource:AuthorizedResource={}) {
  if (name.startsWith('ci_enrollment_') && !context.services.ciEnrollment) return false
  if (name.startsWith('build_computer_prepare') && !context.services.ciRuntime) return false
  return !!context.services.jobRuntimeProfiles && requiredActions(name).every(required =>
    Object.keys(resource).length ? isAuthorized(context.principal, required, resource) : hasAction(context.principal, required))
}
export function jobRuntimeCapabilities(context:Context,resource:AuthorizedResource) {
  return JOB_RUNTIME_TOOLS.filter(name=>jobRuntimeToolAvailable(context,name,resource)).map(name=>({
    name, actions: requiredActions(name), detail: jobRuntimeCapabilityDetail(name),
  }))
}
function jobRuntimeCapabilityDetail(name: JobRuntimeToolName): string {
  const detail = ciSpec(name)?.detail
  if (detail) return detail
  if (name === 'job_runtime_profile_list') {
    return 'Read CI policy profiles and readiness without probing or installing. Authorized writers can use '
      + 'build_computer_prepare for Main’s legacy runtime; paired Workers use Host CI through ci_run.'
  }
  return 'Read/save existing-root CI policy metadata, capture an installed candidate on a paired, authorized '
    + 'computer and run or reconcile its qualification with the original command. GET performs no probe or installation.'
}
async function invoke(context:Context,name:JobRuntimeToolName,work:()=>Promise<unknown>) {
  try{return toolResult(await work())}catch(error){
    if(error instanceof DomainError&&error.status===403)await context.services.commands.recordDenied(context.principal.id,'mcp',name,`mcp:${name}`)
    return toolFailure(error)
  }
}
export function registerJobRuntimeTools(server:McpServer,context:Context) {
  const service=context.services.jobRuntimeProfiles
  if(!service)return
  const scope=z.object({workspaceId:z.string().min(1)}).strict(),approval=scope.extend({approvalId:z.string().uuid()})
  const read={readOnlyHint:true,idempotentHint:true,openWorldHint:false},write={readOnlyHint:false,idempotentHint:true,openWorldHint:false}
  registerCiSpecs(server, context, CI_ENROLLMENT_TOOL_SPECS, context.services.ciEnrollment)
  if(jobRuntimeToolAvailable(context,'job_runtime_profile_list'))server.registerTool('job_runtime_profile_list',{description:'Read existing CI policy profiles, captured qualification fingerprints and metadata readiness without probing or installing. Qualifying and recovery-required operations include their original runCommandId and runPrincipalId; the original authorized principal retries that command with job_runtime_qualification_run. Authorized writers can use build_computer_prepare to prepare and refresh Main’s legacy CI runtime using approved workspace roots. Paired Workers use Host CI through ci_run and reject legacy runtime refresh. Preparation requires its own grants; arbitrary installer paths are unavailable through MCP.',inputSchema:scope,outputSchema:JobRuntimeProfileListRecordSchema,annotations:read},input=>invoke(context,'job_runtime_profile_list',()=>service.list(context.principal,input.workspaceId)))
  if(jobRuntimeToolAvailable(context,'job_runtime_profile_save'))server.registerTool('job_runtime_profile_save',{description:'Save a revisioned CI policy for an existing approved root. Build and verification records retain their formats. Verification saves the approved source commit, offline network policy and reviewed 24-hour lifetime; activation requires measured runtime resources. Caller cannot declare review, qualification evidence or readiness.',inputSchema:JobRuntimeProfileSaveRecordSchema.extend({workspaceId:z.string().min(1)}),outputSchema:z.object({profile:JobRuntimeProfileRecordSchema}),annotations:write},input=>invoke(context,'job_runtime_profile_save',async()=>{const{workspaceId,...body}=input;return {profile:await service.save(context.principal,'mcp',workspaceId,body)}}))
  if(jobRuntimeToolAvailable(context,'job_runtime_qualification_request'))server.registerTool('job_runtime_qualification_request',{description:'Capture the exact installed candidate on a paired, authorized computer; run job_runtime_qualification_run next, with no approval step. This does not probe or install the runtime. Verification candidates bind the saved source commit and profile; another commit requires a new capture. Native entry uses the original guarded runtime owner.',inputSchema:JobRuntimeQualificationRequestSchema.extend({workspaceId:z.string().min(1)}),outputSchema:z.object({approval:JobRuntimeApprovalRecordSchema}),annotations:write},input=>invoke(context,'job_runtime_qualification_request',async()=>{const{workspaceId,...body}=input;return {approval:await service.requestQualification(context.principal,'mcp',workspaceId,body)}}))
  if(jobRuntimeToolAvailable(context,'job_runtime_qualification_run'))server.registerTool('job_runtime_qualification_run',{description:'Run the captured qualification through its guarded host owner. Verification qualification requires jobs:start and job_artifacts:read in addition to job_definitions:write, and retains ordinary-suite and interruption reports as readable canonical Jobs. Long operations retain their start and result in the worker journal. Retry the same command as its original authorized principal to reconcile its result and cleanup, including after candidate expiry or a profile edit. Reconciliation retains the original lease and does not launch another diagnostic; expired or superseded evidence cannot replace current readiness.',inputSchema:approval.extend({commandId:JobRuntimeQualificationCommandSchema.shape.commandId}),outputSchema:z.object({profile:JobRuntimeProfileRecordSchema}),annotations:write},input=>invoke(context,'job_runtime_qualification_run',async()=>({profile:await service.qualify(context.principal,'mcp',input.workspaceId,input.commandId,input.approvalId)})))
  if(jobRuntimeToolAvailable(context,'job_runtime_qualification_get'))server.registerTool('job_runtime_qualification_get',{description:'Read the requested qualification candidate, retained Main native admission and historical measured evidence separately from the current profile and its metadata readiness. A Worker clock offset greater than 2 minutes blocks qualification/readiness with its reason in readback. Current readiness uses profile.measurement, which can belong to a newer qualification. Failed suites retain the exit code and report Job executionId in readiness reasons; read those reports with job_artifacts_list and job_artifact_read. Admission records ownership and is not qualification evidence.',inputSchema:approval,outputSchema:JobRuntimeQualificationReadRecordSchema,annotations:read},input=>invoke(context,'job_runtime_qualification_get',()=>service.getQualification(context.principal,input.workspaceId,input.approvalId)))
  registerCiSpecs(server, context, COMPUTER_PREPARATION_TOOL_SPECS, context.services.ciRuntime)
}

function registerCiSpecs<Service>(server: McpServer, context: Context, specs: readonly CiToolSpec<Service>[],
  service: Service | undefined): void {
  if (!service) return
  for (const spec of specs) {
    const name = spec.name as JobRuntimeToolName
    if (!jobRuntimeToolAvailable(context, name)) continue
    server.registerTool(name, {
      description: spec.description,
      inputSchema: ciToolInputSchema(spec, context.principal.audience) as StandardSchemaWithJSON,
      outputSchema: spec.outputSchema as StandardSchemaWithJSON,
      annotations: spec.annotations,
    }, (input: unknown, extra: ServerContext) => invoke(context, name, () =>
      spec.run(service, context.principal, input, { signal: extra.mcpReq.signal })))
  }
}

export async function unavailableJobRuntimeToolCall(context:Context,body:unknown) {
  const call=z.object({jsonrpc:z.literal('2.0'),id:z.union([z.string(),z.number().int()]),method:z.literal('tools/call'),params:z.object({name:z.enum(JOB_RUNTIME_TOOLS)}).passthrough()}).passthrough().safeParse(body)
  if(!call.success||jobRuntimeToolAvailable(context,call.data.params.name))return undefined
  return {jsonrpc:'2.0' as const,id:call.data.id,result:await invoke(context,call.data.params.name,async()=>{throw new DomainError(context.services.jobRuntimeProfiles?'ACCESS_DENIED':'JOB_RUNTIME_UNAVAILABLE','CI runtime metadata or the required grant is unavailable.',context.services.jobRuntimeProfiles?403:503)})}
}
