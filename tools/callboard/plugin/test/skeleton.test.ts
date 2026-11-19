import { expect, test } from 'claude-code/testing'
import { TOOLS } from '../hooks/core/model.ts'

const NOT_BUILT = 'callboard: not-built'
const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
// The engine beneath the plugin: it answers the session start and a tool's registration.
const engine = (on: any, registered: string[] = []) => {
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', (_: any, e: any) => {
    registered.push(`/${e.name}`)
    return { value: { command: e.name } }
  })
  on('tool.register', (_: any, e: any) => {
    registered.push(e.name)
    return { value: { tool: e.name } }
  })
}

test('every tool and the three commands are registered at the session start, and each tool refuses not-built', async ($, on) => {
  const registered: string[] = []
  engine(on, registered)
  await start($)
  expect(registered.sort()).toEqual([...TOOLS, '/callboard', '/rest', '/unattended'].sort())
  for (const name of TOOLS) expect((await $.tool.call({ tool: `mcp__callboard__${name}` } as any)).deny).toBe(NOT_BUILT)
})

test('the commands answer not-built', async ($, on) => {
  engine(on)
  await start($)
  for (const command of ['callboard', 'rest', 'unattended']) expect((await $.command.run({ command, args: '' } as any)).text).toBe(NOT_BUILT)
})
