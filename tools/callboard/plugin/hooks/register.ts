// The hooks the plugin registers, in the order the engine sees them: the bodies are in engine/, one area to a file. This file only wires: it decides nothing and
// holds no state. It names every hook and tool the plugin has.
import type { Register } from 'claude-code'
import { CUE_VERBS, STOP_VERBS } from './core/model.ts'
import { sessionStart, sessionEnd, postToolHook } from './engine/tick.ts'
import { commandRun, commandComplete, promptCompose } from './engine/commands.ts'
import { presetRun } from './engine/preset.ts'
import { toolCheck, permissionRequest, doneHook } from './engine/ask-hook.ts'
import { requestCompactCall, turnComplete, promptSubmit, turnStart, postCompact } from './engine/upkeep.ts'
import { cueVerbCall, stopVerbCall, laneCreateCall, laneOpenCall, laneUnparkCall, laneAdoptCall, laneListCall } from './engine/tools-child.ts'
import { promptListCall, promptAnswerCall, goRequestCall, goStatusCall } from './engine/tools-ask.ts'
import { restCall } from './engine/tools-any.ts'
import { prWatchCall } from './engine/pr.ts'
import { usageMeasure } from './engine/usage.ts'


export const register: Register = (on) => {
  on('session.start', sessionStart).catch(($, e, next) => next(e))
  on('session.end', sessionEnd).catch(($, e, next) => next(e))
  on('session.measure', usageMeasure).catch(($, e, next) => next(e))

  on('command.run', { command: 'callboard' }, ($, e) => commandRun($, e)).catch(() => ({ text: 'Callboard hit an error. Run /callboard status.' }))
  on('command.run', { command: 'rest' }, ($, e) => commandRun($, { ...e, args: 'rest' })).catch(() => ({ text: 'Callboard hit an error. Run /callboard status.' }))
  on('command.run', { command: 'unattended' }, ($, e) => commandRun($, { ...e, args: `unattended ${typeof (e as { args?: unknown }).args === 'string' ? (e as { args: string }).args : ''}` })).catch(() => ({ text: 'Callboard hit an error. Run /callboard status.' }))
  on('command.run', presetRun)
  on('prompt.autocomplete', commandComplete).catch(($, e, next) => next(e))
  on('prompt.compose', promptCompose).catch(($, e, next) => next(e))
  on('prompt.submit', promptSubmit).catch(($, e, next) => next(e))
  on('turn.start', turnStart).catch(($, e, next) => next(e))
  on('turn.complete', turnComplete).catch(($, e, next) => next(e))

  for (const verb of CUE_VERBS) on('tool.call', { tool: `mcp__callboard__lane_${verb}` }, ($, e, next) => cueVerbCall($, e, next, verb)).catch(() => ({ deny: `lane_${verb} failed closed.` }))
  for (const verb of STOP_VERBS) on('tool.call', { tool: `mcp__callboard__lane_${verb}` }, ($, e, next) => stopVerbCall($, e, next, verb)).catch(() => ({ deny: `lane_${verb} failed closed.` }))
  on('tool.call', { tool: 'mcp__callboard__lane_create' }, laneCreateCall).catch(() => ({ deny: 'lane_create failed closed.' }))
  on('tool.call', { tool: 'mcp__callboard__lane_open' }, laneOpenCall).catch(() => ({ deny: 'lane_open failed closed.' }))
  on('tool.call', { tool: 'mcp__callboard__lane_unpark' }, laneUnparkCall).catch(() => ({ deny: 'lane_unpark failed closed.' }))
  on('tool.call', { tool: 'mcp__callboard__lane_adopt' }, laneAdoptCall).catch(() => ({ deny: 'lane_adopt failed closed.' }))
  on('tool.call', { tool: 'mcp__callboard__lane_list' }, laneListCall).catch(() => ({ deny: 'lane_list failed closed.' }))
  on('tool.call', { tool: 'mcp__callboard__prompt_list' }, promptListCall).catch(() => ({ deny: 'prompt_list failed closed.' }))
  on('tool.call', { tool: 'mcp__callboard__prompt_answer' }, promptAnswerCall).catch(() => ({ deny: 'prompt_answer failed closed.' }))
  on('tool.call', { tool: 'mcp__callboard__go_request' }, goRequestCall).catch(() => ({ deny: 'go_request failed closed.' }))
  on('tool.call', { tool: 'mcp__callboard__go_status' }, goStatusCall).catch(() => ({ deny: 'go_status failed closed.' }))
  on('tool.call', { tool: 'mcp__callboard__pr_watch' }, prWatchCall).catch(() => ({ deny: 'pr_watch failed closed.' }))
  on('tool.call', { tool: 'mcp__callboard__request_compact' }, requestCompactCall).catch(() => ({ deny: 'request_compact failed closed.' }))
  on('tool.call', { tool: 'mcp__callboard__rest' }, restCall).catch(() => ({ deny: 'rest failed closed.' }))

  on('tool.check', toolCheck).catch(($, e, next) => next(e))
  on('classic.PermissionRequest', permissionRequest).catch(($, e, next) => next(e))
  on('classic.PostToolUse', postToolHook).catch(($, e, next) => next(e))
  on('classic.PostToolUseFailure', postToolHook).catch(($, e, next) => next(e))
  on('classic.PermissionDenied', doneHook).catch(($, e, next) => next(e))
  on('classic.PostCompact', postCompact).catch(($, e, next) => next(e))
}
