import type pg from 'pg'
import type { AgentConfigurationVersion, AssignedSkill } from '@foreman-code/contracts'
import type { NodeSkillOverride } from '@foreman-code/contracts/wave25'
import { resolveAssignedSkills } from './catalog.js'
import { DomainError } from '../errors.js'

/** A workflow node's skills for one execution start: the Agent's assigned skills minus the removed ones,
 * then each added skill at its workspace head version, resolved into an instruction snapshot. */
export async function configurationWithNodeSkills(client: pg.ClientBase, configuration: AgentConfigurationVersion,
  override: NodeSkillOverride): Promise<AgentConfigurationVersion> {
  const removed = new Set(override.remove ?? [])
  const kept = (configuration.assignedSkills ?? []).filter(skill => !removed.has(skill.skillId))
  const added: AssignedSkill[] = []
  for (const skillId of override.add ?? []) {
    const head = (await client.query<{ head_version: string }>(
      'select head_version from workspace_skills where workspace_id=$1 and skill_id=$2', [configuration.workspaceId, skillId])).rows[0]
    if (!head) throw new DomainError('SKILL_VERSION_NOT_FOUND', `Skill '${skillId}' is not in this workspace's skills.`, 409)
    added.push({ skillId, version: head.head_version })
  }
  const references = [...kept, ...added]
  const resolved = await resolveAssignedSkills(client, configuration.workspaceId, references, configuration.assignedSkills ?? [])
  return { ...configuration, assignedSkills: references, resolvedSkills: resolved }
}
