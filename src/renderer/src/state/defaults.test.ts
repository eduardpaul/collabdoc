import { describe, expect, it } from 'vitest'
import { defaultAgentId, defaultAgents, withInstallIds } from './defaults'
import { migrateAgent } from '../lib/persist'

describe('per-install agent ids', () => {
  it('two installs get different starter agents; ids are stable for one install', () => {
    const pm = defaultAgents('11111111-aaaa-4000-8000-000000000001')
    const architect = defaultAgents('22222222-bbbb-4000-8000-000000000002')
    expect(pm.map((a) => a.id)).toEqual(['agent_11111111_writer', 'agent_11111111_reviewer'])
    expect(architect.map((a) => a.id)).not.toEqual(pm.map((a) => a.id))
    expect(defaultAgents('11111111-aaaa-4000-8000-000000000001')).toEqual(pm)
  })

  it('migrates the shared legacy ids to this install and re-keys a provisional id', () => {
    const legacy = migrateAgent({
      id: 'agent_writer',
      name: 'Writer',
      role: 'writer',
      persona: '',
      skills: []
    })!
    const migrated = withInstallIds([legacy], '11111111-aaaa-4000-8000-000000000001')
    expect(migrated[0].id).toBe('agent_11111111_writer')
    expect(migrated[0].name).toBe('Writer')

    const provisional = defaultAgents('99999999-prov-4000-8000-000000000009')
    const rekeyed = withInstallIds(
      provisional,
      '11111111-aaaa-4000-8000-000000000001',
      '99999999-prov-4000-8000-000000000009'
    )
    expect(rekeyed.map((a) => a.id)).toEqual(['agent_11111111_writer', 'agent_11111111_reviewer'])
    // A user-created agent keeps its own id whatever the profile does.
    const custom = { ...provisional[0], id: 'agent_custom1' }
    expect(withInstallIds([custom], 'x', 'y')[0].id).toBe('agent_custom1')
    expect(defaultAgentId('', 'writer')).toBe('agent_local_writer')
  })
})
