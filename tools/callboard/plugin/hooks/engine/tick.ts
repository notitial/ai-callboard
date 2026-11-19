// The session start and end, the tool registration and the 2 s tick. Stubs: the start registers every tool so each can refuse `not-built`, and the end passes on.
import { TOOLS } from '../core/model.ts'
import { TOOL_SCHEMAS } from '../tool-schemas.ts'

export async function sessionStart($: any, e: any, next: any) {
  for (const name of TOOLS) await $.tool.register({ name, description: `${name}: not built yet`, inputSchema: TOOL_SCHEMAS[name].input })
  return next(e)
}
export async function sessionEnd(_$: any, e: any, next: any) {
  return next(e)
}
