import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { WorkspaceRootPolicySchema } from '@foreman-code/contracts/workspace-root-policies'
import { computerNameKey } from '../src/modules/computers/names.js'
import { sourceSha256 } from '../src/modules/sources/manifest.js'
import { placementDiscoveryFixture } from './helpers/placementDiscoveryFixture.js'

it('offers the current binding once per computer and folder despite old roots and matching profiles', async () => {
  const f = await placementDiscoveryFixture()
  try {
    const root = (await f.roots()).items.find(value => value.selection.hostRef.kind === 'device')!
    const policy = WorkspaceRootPolicySchema.parse((await f.pool.query<{ record: unknown }>(
      'select record from workspace_root_policies where root_policy_id=$1 and root_policy_revision=$2',
      [root.selection.rootPolicyId, root.selection.rootPolicyRevision])).rows[0]!.record)
    const host = policy.hostRef
    if (host.kind !== 'device') throw new Error('Expected a Worker root')
    await f.pool.query('insert into computer_names(host_key,name,updated_by) values($1,$2,$3)',
      [computerNameKey(host.mainId, host.deviceId), 'Studio', f.native.base.writer.principal.id])
    const historical = []
    for (let index = 0; index < 9; index++) {
      await f.addMatchingWorkerProfile()
      const olderPolicy = WorkspaceRootPolicySchema.parse({ ...policy, rootPolicyId: randomUUID() })
      const older = SourceRootRecordSchema.parse({ ...root,
        selection: { ...root.selection, rootPolicyId: olderPolicy.rootPolicyId },
        binding: { ...root.binding, rootId: randomUUID(),
          canonicalPath: `${policy.managedRuntimeRoot}/source-materializations/${olderPolicy.rootPolicyId}` },
        // A recent refresh of an obsolete binding must not outrank the current folder selection.
        boundAt: '2099-01-01T00:00:00.000Z',
      })
      historical.push(older)
      await f.pool.query(`insert into workspace_root_policies(root_policy_id,root_policy_revision,workspace_id,
        host_scope,location_revision,record,revoked_at) values($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [olderPolicy.rootPolicyId, olderPolicy.rootPolicyRevision, policy.workspaceId,
        `${host.mainId}:${host.deviceId}`, policy.locationRevision, JSON.stringify(olderPolicy),
        index === 0 ? null : new Date()])
      await f.pool.query(`insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision)
        values($1,$2,$3,$4)`, [older.binding.rootId, policy.workspaceId,
        sourceSha256(Buffer.from(older.binding.rootId)), older.binding.bindingRevision])
      await f.pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
        values($1,$2,$3,$4,$5::jsonb)`, [older.binding.rootId, older.binding.bindingRevision,
        policy.workspaceId, older.source.snapshotId, JSON.stringify(older)])
    }

    for (const via of ['http', 'mcp'] as const) {
      const result = await f.read(via)
      expect(result.choices).toHaveLength(2)
      expect(result.choices.filter(choice => choice.placement.hostRef.kind === 'device')).toEqual([
        expect.objectContaining({ label: 'Studio · project', availability: 'ready', reason: null,
          placement: expect.objectContaining({ projectRoot: policy.canonicalProjectRoot,
            rootBinding: { rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision } }) }),
      ])
    }

    await f.pool.query('update workspace_root_policies set revoked_at=now() where root_policy_id=$1',
      [policy.rootPolicyId])
    const unavailable = await f.read('http')
    expect(unavailable.choices).toHaveLength(2)
    expect(unavailable.choices.find(choice => choice.placement.hostRef.kind === 'device')).toMatchObject({
      label: 'Studio · project', availability: 'unavailable',
      reason: 'The exact authorized root policy is missing or revoked.',
      placement: { rootBinding: { rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision } },
    })
    expect((await f.roots()).items).toEqual(expect.arrayContaining(historical))
  } finally { await f.close() }
}, 120_000)
