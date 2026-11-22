// The 19 tools: who is given each, and its input schema. `cap` is 'any' for the tools every session gets and 'parent' for the thirteen a session gets only when it
// holds the lead capability or is the manager. Data only: the tool descriptions are texts (`tool.<name>`).
import type { ToolName } from './core/model.ts'
import { LANE_EFFORTS, LANE_MODELS } from './core/model.ts'

type Schema = { type: 'object'; properties: Record<string, unknown>; required?: string[] }
const text = { type: 'string' }
const lane: Schema = { type: 'object', properties: { lane: text }, required: ['lane'] }
const none: Schema = { type: 'object', properties: {} }

export const TOOL_SCHEMAS: Record<ToolName, { cap: 'any' | 'parent'; input: Schema }> = {
  lane_rename: { cap: 'parent', input: { type: 'object', properties: { lane: text, name: text }, required: ['lane', 'name'] } },
  lane_start: { cap: 'parent', input: lane },
  lane_resume: { cap: 'parent', input: lane },
  lane_park: { cap: 'parent', input: lane },
  lane_retire: { cap: 'parent', input: lane },
  lane_terminate: { cap: 'parent', input: lane },
  lane_unpark: { cap: 'parent', input: lane },
  lane_list: { cap: 'parent', input: none },
  lane_create: { cap: 'parent', input: { type: 'object', properties: { name: text, folder: text, brief: text, model: { type: 'string', enum: [...LANE_MODELS] }, effort: { type: 'string', enum: [...LANE_EFFORTS] }, role: { type: 'string', enum: ['lane', 'lead'] } }, required: ['name', 'folder', 'brief'] } },
  lane_open: { cap: 'parent', input: lane },
  lane_adopt: { cap: 'parent', input: { type: 'object', properties: { name: text }, required: ['name'] } },
  prompt_list: { cap: 'parent', input: none },
  prompt_answer: { cap: 'parent', input: { type: 'object', properties: { id: text, decision: { type: 'string', enum: ['allow', 'deny', 'answer', 'escalate'] }, note: text, option: { type: 'integer', minimum: 1, maximum: 4 } }, required: ['id', 'decision'] } },
  go_request: { cap: 'any', input: { type: 'object', properties: { text }, required: ['text'] } },
  go_status: { cap: 'any', input: none },
  pr_watch: { cap: 'any', input: { type: 'object', properties: { owner: text, repo: text, number: { type: 'integer' } }, required: ['owner', 'repo', 'number'] } },
  request_compact: { cap: 'any', input: { type: 'object', properties: { focus: text, continuation: text }, required: ['focus', 'continuation'] } },
  request_handover: { cap: 'any', input: { type: 'object', properties: { file: text, continuation: text }, required: ['file', 'continuation'] } },
  rest: { cap: 'any', input: none },
}
