'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createPick, rowsFor, siblings, PICK_MAX, SHOWN_MAX } = require('./pick.js')

// A parent folder with the conductor's own repo `me`, the git repos `a` and `b` (b's .git is a file, as in a worktree), a plain folder, a file, and a link
// to a repo that sits elsewhere.
function tree() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-pick-')))
  const at = (...p) => path.join(root, 'code', ...p)
  for (const d of ['me/.git', 'a/.git', 'plain', 'b']) fs.mkdirSync(at(d), { recursive: true })
  fs.writeFileSync(at('b', '.git'), 'gitdir: elsewhere\n')
  fs.writeFileSync(at('file'), '')
  fs.mkdirSync(path.join(root, 'away', 'far', '.git'), { recursive: true })
  fs.symlinkSync(path.join(root, 'away', 'far'), at('linked'))
  return { root, at, far: path.join(root, 'away', 'far') }
}
// A fake VS Code: `answer` gets the items and the options and returns what showQuickPick resolves; `hold` keeps the list up until the token is cancelled.
function vs(answer, { hold = false } = {}) {
  const shown = []
  const vscode = {
    CancellationTokenSource: class {
      constructor() { this.token = { onCancel: undefined } }
      cancel() { this.token.onCancel?.() }
      dispose() {}
    },
    window: {
      showQuickPick: (items, options, token) => {
        shown.push({ items, options })
        return hold ? new Promise((r) => { token.onCancel = () => r(undefined) }) : Promise.resolve(answer(items))
      },
    },
  }
  return { vscode, shown }
}

test('siblings: the direct children that are real directories holding a .git entry, sorted, never the folder itself, a plain folder, a file or a link', async () => {
  const t = tree()
  assert.deepEqual(await siblings(t.at('me')), [t.at('a'), t.at('b')])
  assert.deepEqual(await siblings(path.join(t.root, 'missing', 'x')), [])
})

test('the rows in a one-folder window with nothing saved: the sibling repos, unticked', async () => {
  const t = tree()
  assert.deepEqual(await rowsFor(t.at('me'), [t.at('me')], []), [{ folder: t.at('a'), picked: false, inWindow: false }, { folder: t.at('b'), picked: false, inWindow: false }])
})

test('the rows with nothing saved: the window\'s other folders ticked and first, then the siblings unticked, each once and by its real path', async () => {
  const t = tree()
  // The window lists a repo elsewhere through a link, and a sibling.
  const rows = await rowsFor(t.at('me'), [t.at('me'), t.at('linked'), t.at('b'), '/no/such/folder'], [])
  assert.deepEqual(rows, [{ folder: t.far, picked: true, inWindow: true }, { folder: t.at('b'), picked: true, inWindow: true }, { folder: t.at('a'), picked: false, inWindow: false }])
})

test('the rows with a saved list: the saved repos that still exist ticked, the window\'s folders and the siblings unticked below', async () => {
  const t = tree()
  const rows = await rowsFor(t.at('me'), [t.at('me'), t.at('b')], [t.at('a'), '/gone/repo', t.at('me')])
  assert.deepEqual(rows, [{ folder: t.at('a'), picked: true, inWindow: false }, { folder: t.at('b'), picked: false, inWindow: true }])
})

test('the conductor\'s own folder is never offered, also when it is reached through a link; a folder that does not resolve offers nothing', async () => {
  const t = tree()
  fs.symlinkSync(t.at('me'), path.join(t.root, 'me-link'))
  const rows = await rowsFor(path.join(t.root, 'me-link'), [path.join(t.root, 'me-link'), t.at('me')], [])
  assert.deepEqual(rows.map((r) => r.folder), [t.at('a'), t.at('b')])
  assert.deepEqual(await rowsFor('/no/such/folder', ['/no/such/folder'], []), [])
})

test(`at most ${SHOWN_MAX} rows are shown`, async () => {
  const t = tree()
  for (let i = 0; i < SHOWN_MAX + 5; i++) fs.mkdirSync(t.at(`r${String(i).padStart(3, '0')}`, '.git'), { recursive: true })
  assert.equal((await rowsFor(t.at('me'), [t.at('me')], [])).length, SHOWN_MAX)
})

test('pick: a multi-select list that keeps focus, each row its name and path, answered with the folders ticked', async () => {
  const t = tree()
  const v = vs((items) => items.filter((i) => i.label !== 'b'))
  const pick = createPick({ vscode: v.vscode, windowFolders: () => [t.at('me'), t.at('b')] })
  assert.deepEqual(await pick(t.at('me'), []), [t.at('a')])
  const { items, options } = v.shown[0]
  assert.deepEqual(items.map((i) => [i.label, i.description, i.picked]), [['b', `${t.at('b')} (in this window)`, true], ['a', t.at('a'), false]])
  assert.equal(options.canPickMany, true)
  assert.equal(options.ignoreFocusOut, true)
})

test('pick: Escape, or Enter with nothing ticked, is cancelled; more than the limit is too-many; nothing to offer shows no list', async () => {
  const t = tree()
  const run = (answer, folder = t.at('me')) => createPick({ vscode: vs(answer).vscode, windowFolders: () => [] })(folder, [])
  await assert.rejects(run(() => undefined), /^Error: cancelled$/)
  await assert.rejects(run(() => []), /^Error: cancelled$/)
  await assert.rejects(run(() => Array.from({ length: PICK_MAX + 1 }, (_, i) => ({ folder: `/r${i}` }))), /^Error: too-many$/)
  assert.equal((await run(() => Array.from({ length: PICK_MAX }, (_, i) => ({ folder: `/r${i}` })))).length, PICK_MAX)
  const lone = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-pick-lone-'))), 'only')
  fs.mkdirSync(lone)
  const v = vs(() => assert.fail('no list'))
  await assert.rejects(createPick({ vscode: v.vscode, windowFolders: () => [lone] })(lone, []), /^Error: no-folders$/)
  assert.equal(v.shown.length, 0)
})

test('pick: the list closes itself at its time limit and answers timeout', async () => {
  const t = tree()
  const v = vs(undefined, { hold: true })
  await assert.rejects(createPick({ vscode: v.vscode, windowFolders: () => [], ms: 20 })(t.at('me'), []), /^Error: timeout$/)
  assert.equal(v.shown.length, 1)
})
