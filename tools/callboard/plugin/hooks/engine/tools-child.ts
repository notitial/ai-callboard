// The child tools and the lead-only ones: one cue path (rename, start, resume), one stop body (park, retire, terminate), create, open, unpark, adopt, list.
// Stubs: each refuses `not-built` until it is built.
import type { CueVerb, StopVerb } from '../core/model.ts'
import { notBuilt } from './tools-any.ts'

export async function cueVerbCall(_$: any, _e: any, _next: any, _verb: CueVerb) {
  return notBuilt()
}
export async function stopVerbCall(_$: any, _e: any, _next: any, _verb: StopVerb) {
  return notBuilt()
}
export async function laneCreateCall(_$: any, _e: any, _next: any) {
  return notBuilt()
}
export async function laneOpenCall(_$: any, _e: any, _next: any) {
  return notBuilt()
}
export async function laneUnparkCall(_$: any, _e: any, _next: any) {
  return notBuilt()
}
export async function laneAdoptCall(_$: any, _e: any, _next: any) {
  return notBuilt()
}
export async function laneListCall(_$: any, _e: any, _next: any) {
  return notBuilt()
}
