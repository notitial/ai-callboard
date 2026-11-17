// The repo token of a lead's pin (core's REPO_ID_FILE in the repo's own .git), read or minted at a grant, and the checks a restore in a moved folder runs
// before it asks the person (ADR 0002, Lead re-grant).
// Trust rules held here: .git is a real folder of the person's that is its own real path; the token file is a plain 0600 file of the person's with one link,
// never followed and never replaced; only an id the mod minted (repoid:<id> in $.store) counts. No git config, ref or object is read.
import * as c from '../core.ts'
import { run, statR, realR, readSmallR, gitRoot, rmF, INSTALL, TEE, logq } from './base.ts'
import { promptNewId } from './answer-hook.ts'

const LN = '/bin/ln'

// 'yes': <repo>/.git is a folder (lstat: not a link) of uid's and its own real path. 'error': a check that could not be made.
async function gitDirOk($: any, repo: string, uid: number): Promise<'yes' | 'no' | 'error'> {
  const dir = `${repo}/.git`
  const g = await statR($, dir)
  if (g === 'error') return 'error'
  if (g === 'absent' || g.kind !== 'dir' || g.uid !== uid) return 'no'
  const r = await realR($, dir)
  if (r === 'error') return 'error'
  return r !== 'absent' && r.path === dir ? 'yes' : 'no'
}

// The token file as it stands: its id; 'absent'; 'bad' (a link, another mode or owner, more than one link, a text that is no id); 'again' (a read that failed
// or changed under it, worth another try).
async function tokenRead($: any, repo: string, uid: number): Promise<{ id: string } | 'absent' | 'bad' | 'again'> {
  const path = `${repo}/.git/${c.REPO_ID_FILE}`
  const f = await statR($, path)
  if (f === 'error') return 'again'
  if (f === 'absent') return 'absent'
  const r = await readSmallR($, path, uid, c.REPO_ID_MAX)
  if (r.state === 'changed' || r.state === 'failed') return 'again'
  if (r.state !== 'ok') return 'bad'
  const id = c.parseRepoIdText(r.text)
  return id === undefined ? 'bad' : { id }
}

// Whether the mod minted this id; 'error' for a store read that failed.
async function minted($: any, id: string): Promise<boolean | 'error'> {
  try {
    return c.repoIdMarkOk(await $.store.get(`${c.REPO_ID_PREFIX}${id}`))
  } catch {
    return 'error'
  }
}

// A new token: its mark goes in the store first (a file never names an id the mod did not keep), then the file is linked into place with `ln -h`, which does
// not follow a link at the name and fails when the name exists. The file is read again after, so the loser of a race between two leads takes the winner's id.
async function mint($: any, repo: string, uid: number): Promise<{ id: string } | 'absent' | 'bad' | 'again'> {
  const id = await promptNewId($)
  await $.store.set(`${c.REPO_ID_PREFIX}${id}`, { at: await $.clock.now() })
  const tmp = `${repo}/.git/.${c.REPO_ID_FILE}.${id}.tmp`
  try {
    if ((await run($, [INSTALL, '-m', '600', '/dev/null', tmp])).exitCode !== 0) return 'again'
    const t = await statR($, tmp)
    if (t === 'error' || t === 'absent' || t.kind !== 'file' || t.uid !== uid || t.mode !== 0o600 || t.nlink !== 1) return 'again'
    if ((await run($, [TEE, '--', tmp], c.repoIdText(id))).exitCode !== 0) return 'again'
    // .git again, just before the link: a folder swapped for a link meanwhile gets nothing.
    if ((await gitDirOk($, repo, uid)) !== 'yes') return 'again'
    await run($, [LN, '-h', '--', tmp, `${repo}/.git/${c.REPO_ID_FILE}`])
  } finally {
    await rmF($, tmp)
  }
  // Nothing at the name after the link: the write did not land, which is no answer yet.
  const after = await tokenRead($, repo, uid)
  return after === 'absent' ? 'again' : after
}

// The token of the pin at a grant: read, or minted when there is none. { id }: a token the mod minted; { no }: none to save (logged); { again }: a check that
// could not be made, so a token saved before for the same pin may stand.
export async function repoIdFor($: any, sid: string, pin: string, uid: number): Promise<{ id: string } | { no: string } | { again: string }> {
  try {
    const d = await gitDirOk($, pin, uid)
    if (d === 'error') return { again: 'git-dir' }
    if (d === 'no') return { no: 'no-git-dir' }
    let t = await tokenRead($, pin, uid)
    if (t === 'absent') t = await mint($, pin, uid)
    if (t === 'again') return { again: 'token-read' }
    if (t === 'absent' || t === 'bad') {
      await logq($, sid, 'lead-repo-id', 'bad')
      return { no: 'bad' }
    }
    const m = await minted($, t.id)
    if (m === 'error') return { again: 'store' }
    if (!m) {
      await logq($, sid, 'lead-repo-id', 'foreign')
      return { no: 'foreign' }
    }
    return { id: t.id }
  } catch {
    await logq($, sid, 'lead-repo-id', 'error')
    return { again: 'error' }
  }
}

// A restore whose saved folder is not the session's: 'match' when the old folder is gone (or is a link to this one), this folder is one a lead grant would
// pin (a clean path that is its own real path, a git root with a .git folder), and its token is the saved one and the mod's own. { no }: a definite no (the
// restore is refused); { again }: a check that could not be made (tried again from the tick). The folder is read from $.session.root() itself.
export async function moveCheck($: any, hint: c.LeadHint, cwd: string, home: string, uid: number): Promise<'match' | { no: string } | { again: string }> {
  if (hint.repoId === undefined) return { no: 'wrong-folder' }
  let root: unknown
  try {
    root = await $.session.root()
  } catch {
    return { again: 'cwd-unreadable' }
  }
  if (root !== cwd) return { again: 'cwd-unreadable' }
  const old = await realR($, hint.pin)
  if (old === 'error') return { again: 'old-unreadable' }
  if (old !== 'absent' && old.path !== cwd) return { no: 'move-old-there' }
  if (c.pinRefusal(cwd, home) !== undefined) return { no: 'move-pin' }
  const r = await realR($, cwd)
  if (r === 'error') return { again: 'move-check-error' }
  if (r === 'absent' || r.path !== cwd) return { no: 'move-pin' }
  const g = await gitRoot($, cwd)
  if (g === 'error') return { again: 'move-check-error' }
  if (g === 'no') return { no: 'move-no-git' }
  const d = await gitDirOk($, cwd, uid)
  if (d === 'error') return { again: 'move-check-error' }
  if (d === 'no') return { no: 'move-no-git' }
  const t = await tokenRead($, cwd, uid)
  if (t === 'again') return { again: 'move-check-error' }
  if (t === 'absent' || t === 'bad' || t.id !== hint.repoId) return { no: 'move-token' }
  const m = await minted($, t.id)
  if (m === 'error') return { again: 'move-check-error' }
  return m ? 'match' : { no: 'move-token' }
}
