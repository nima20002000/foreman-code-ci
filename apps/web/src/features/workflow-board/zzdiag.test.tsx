import { nativeNode } from '../../shared/mocks/nativeFixtureTypes'
// @vitest-environment jsdom
import { createHash } from 'node:crypto'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { boardSearchForRun, canonicalGraphJson, RunExecutionDetailSchema, readRunInspectionKey, runInspectionKey } from '@foreman-code/contracts/wave25'
import { useGraphDraftStore } from '../graph/store'
import { nextDraftKey } from '../graph/nextDraft/state'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import {
  boardHref, installBoardTestLifecycle, measureBoardWire, mountMeasuredBoard, openRunDetails,
  type InspectionFixture,
} from './eng05D.testSupport'

installBoardTestLifecycle()
let fixture: InspectionFixture, serial = 0
beforeEach(async () => { fixture = await inspectionBoardFixture(`eng05d-inspect-${++serial}`) })

describe('diag', () => {
  it('dumps popover state', async () => {
    const owner = fixture.runs.before
    const expected = fixture.mock.inspection.get(owner.run.id)!.slice().reverse().find((item) => item.detail.acceptedResult.status === 'accepted')!.detail
    const id = expected.execution.executionId, nodeId = expected.execution.workflowNodeId
    measureBoardWire(fixture.mock)
    await mountMeasuredBoard(boardHref(owner.scope, { runNodeId: nodeId, runExchangeKey: runInspectionKey({ executionId: id }) }))
    await new Promise((r) => setTimeout(r, 3000))
    const pop = document.querySelector('.board-activities-popover')
    const chain: string[] = []
    for (let e = pop as Element | null; e; e = e.parentElement) {
      const s = getComputedStyle(e)
      chain.push(`${e.tagName}.${(e as HTMLElement).className}|d=${s.display}|v=${s.visibility}|h=${(e as HTMLElement).hidden}|ah=${e.getAttribute('aria-hidden')}|inert=${e.hasAttribute('inert')}`)
    }
    const labels = pop ? [...pop.querySelectorAll('[aria-label],summary,details')].map((e) => `${e.tagName}:${e.getAttribute('aria-label') ?? e.textContent?.slice(0, 50)}${e.tagName === 'DETAILS' ? ':open=' + (e as HTMLDetailsElement).open : ''}`) : []
    console.log('DIAG ' + JSON.stringify({ hasPopover: !!pop, popAttrs: pop?.getAttributeNames(), chain, labels, article: !!screen.queryByRole('article'), articleHidden: !!screen.queryByRole('article', { hidden: true }), btns: [...document.querySelectorAll('button[aria-label="Activities"]')].length, text: pop?.textContent?.slice(0, 600) }))
  }, 20_000)
})
