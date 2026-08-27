import type { Config } from '../../src/types/config.ts'
import { DEFAULT_CONFIG } from '../../src/types/config.ts'
import { composeActiveSets } from '../../src/permission/compose.ts'
import { evaluate } from '../../src/permission/evaluate.ts'

function baseConfig(permissionSets: Config['permissionSets']): Config {
  return { ...DEFAULT_CONFIG, permissionSets }
}

describe('composeActiveSets', () => {
  it('returns empty ruleset (Phase 1: new cascade model replaces priority-based composition)', () => {
    const cfg = baseConfig({
      s1: {
        permissions: {
          tools: { bash: 'allow' },
        },
      },
    })
    const rs = composeActiveSets(['s1'], cfg)
    expect(rs).toHaveLength(0)
  })

  it('returns empty ruleset for multiple active sets', () => {
    const cfg = baseConfig({
      low: { permissions: { tools: { bash: 'allow' } } },
      high: { permissions: { tools: { bash: 'deny' } } },
    })
    const rs = composeActiveSets(['low', 'high'], cfg)
    expect(rs).toHaveLength(0)
  })
})
