import assert from 'node:assert/strict'
import { it } from 'vitest'

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ')
}

it('normalizes an empty or whitespace-only label to an empty string', () => {
  assert.equal(normalizeLabel(''), '')
  assert.equal(normalizeLabel(' \t\n '), '')
})

it('trims and collapses whitespace in a label', () => {
  assert.equal(normalizeLabel('  release\t candidate\nnow  '), 'release candidate now')
})
