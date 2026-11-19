// `/callboard`, `/rest`, `/unattended`, typeahead and the prompt composer. Stubs: the commands answer `not-built`; typeahead and the composer pass on.
import { NOT_BUILT } from './tools-any.ts'

export async function commandRun(_$: any, _e: any) {
  return { text: NOT_BUILT }
}
export async function commandComplete(_$: any, e: any, next: any) {
  return next(e)
}
export async function promptCompose(_$: any, e: any, next: any) {
  return next(e)
}
