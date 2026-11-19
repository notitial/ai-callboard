// request_compact, compaction, PostCompact, turn marks, keepalive and nudge sends. Stubs: the tool refuses `not-built`; a hook that cannot refuse passes on to
// the chain beneath.
import { notBuilt } from './tools-any.ts'

export async function requestCompactCall(_$: any, _e: any, _next: any) {
  return notBuilt()
}
export async function turnComplete(_$: any, e: any, next: any) {
  return next(e)
}
export async function promptSubmit(_$: any, e: any, next: any) {
  return next(e)
}
export async function turnStart(_$: any, e: any, next: any) {
  return next(e)
}
export async function postToolHook(_$: any, e: any, next: any) {
  return next(e)
}
export async function postCompact(_$: any, e: any, next: any) {
  return next(e)
}
