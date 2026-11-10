import { describe, expect, it } from 'vitest'
import { checkForUpdate, isNewer } from '../src/main/updates'

const reply = (body: object, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch

describe('update check', () => {
  it('compares versions numerically', () => {
    expect(isNewer('v0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('0.1.0', '0.1.0')).toBe(false)
    expect(isNewer('v0.1.0', '0.2.0')).toBe(false)
  })

  it('returns newer published releases only, and never throws', async () => {
    const url = 'https://github.com/x/y/releases/tag/v0.2.0'
    expect(await checkForUpdate('0.1.0', reply({ tag_name: 'v0.2.0', html_url: url }))).toEqual({ version: '0.2.0', url })
    expect(await checkForUpdate('0.2.0', reply({ tag_name: 'v0.2.0', html_url: url }))).toBeNull()
    expect(await checkForUpdate('0.1.0', reply({ tag_name: 'v0.2.0', html_url: url, prerelease: true }))).toBeNull()
    expect(await checkForUpdate('0.1.0', reply({}, false))).toBeNull()
    const boom = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await checkForUpdate('0.1.0', boom)).toBeNull()
  })
})
