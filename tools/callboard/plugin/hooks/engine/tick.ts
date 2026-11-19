// The session start and end, the tool and command registration and the 2 s tick. Stubs: the start registers every tool and the three commands, so each can be
// seen to refuse `not-built` (the built start gives a tool only to a session that may use it: `cap` in tool-schemas.ts), and the end passes on. This plugin and the
// mod share the name `callboard` and the `mcp__callboard__` tool prefix, so only one of them is loaded at a time.
import { TOOLS } from '../core/model.ts'
import { TOOL_SCHEMAS } from '../tool-schemas.ts'

export async function sessionStart($: any, e: any, next: any) {
  for (const name of TOOLS) await $.tool.register({ name, description: `${name}: not built yet`, inputSchema: TOOL_SCHEMAS[name].input })
  await $.command.register({ name: 'callboard', description: 'Callboard: not built yet' })
  await $.command.register({ name: 'rest', description: 'Same as /callboard rest: not built yet' })
  await $.command.register({ name: 'unattended', description: 'Same as /callboard unattended: not built yet' })
  return next(e)
}
export async function sessionEnd(_$: any, e: any, next: any) {
  return next(e)
}
