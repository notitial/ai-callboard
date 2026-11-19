// The tools every session has (`rest`) and the one refusal the stubs share. Stub: refuses `not-built` until it is built.
export const NOT_BUILT = 'callboard: not-built'
export function notBuilt() {
  return { deny: NOT_BUILT }
}

export async function restCall(_$: any, _e: any, _next: any) {
  return notBuilt()
}
