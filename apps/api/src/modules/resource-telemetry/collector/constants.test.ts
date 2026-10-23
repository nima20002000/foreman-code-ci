import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { hostConstantsFromAuxv, qualifyHostConstants } from './linuxProcfs.js'

const auxv = (entries: [number, number][], wordBytes: 4 | 8, littleEndian: boolean) => {
  const bytes = Buffer.alloc((entries.length + 1) * 2 * wordBytes)
  entries.flat().forEach((value, index) => {
    const offset = index * wordBytes
    if (wordBytes === 8 && littleEndian) bytes.writeBigUInt64LE(BigInt(value), offset)
    else if (wordBytes === 8) bytes.writeBigUInt64BE(BigInt(value), offset)
    else if (littleEndian) bytes.writeUInt32LE(value, offset)
    else bytes.writeUInt32BE(value, offset)
  })
  return bytes
}

it.runIf(process.platform === 'linux')('reads the same clock tick rate and page size as getconf', async () => {
  const getconf = (name: string) => BigInt(execFileSync('/usr/bin/getconf', [name], { encoding: 'utf8' }).trim())
  expect(await qualifyHostConstants(new AbortController().signal))
    .toEqual({ clockTicksPerSecond: getconf('CLK_TCK'), pageSize: getconf('PAGESIZE') })
})

it.each([[8, true], [8, false], [4, true], [4, false]] as const)('parses %i-byte auxiliary vectors (little-endian %s)', (wordBytes, littleEndian) => {
  expect(hostConstantsFromAuxv(auxv([[33, 7], [6, 16384], [17, 250]], wordBytes, littleEndian), wordBytes, littleEndian))
    .toEqual({ clockTicksPerSecond: 250n, pageSize: 16384n })
})

it('rejects a missing or zero constant and ignores entries after the terminator', () => {
  expect(() => hostConstantsFromAuxv(auxv([[6, 4096], [17, 0]], 8, true), 8, true)).toThrow('invalid-counter')
  expect(() => hostConstantsFromAuxv(auxv([[6, 4096]], 8, true), 8, true)).toThrow('invalid-counter')
  const terminated = Buffer.concat([auxv([[6, 4096]], 8, true), auxv([[17, 100]], 8, true)])
  expect(() => hostConstantsFromAuxv(terminated, 8, true)).toThrow('invalid-counter')
})

it('stops before reading when initialization is already canceled', async () => {
  const controller = new AbortController()
  controller.abort(new Error('canceled'))
  await expect(qualifyHostConstants(controller.signal)).rejects.toThrow('canceled')
})
