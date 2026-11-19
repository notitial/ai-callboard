"""Tests for patch-claude.py. Run: /usr/bin/python3 -I tools/callboard/test_patch_claude.py

Each case builds a small stand-in for the Claude Code extension's minified file in a temporary folder (one variant with the
names of 2.1.327, one with other minified names, as in 2.1.328) and runs the script on it, so nothing outside the
temporary folder is touched."""
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "patch-claude.py")
PY = "/usr/bin/python3"

TEMPLATE = (
    'var q="é";function {nc}(e){{return e[0]}}class W{{async createPanel(e,t,n,r,o,s,i,a=!1){{if(e){{return 1}}let d=1,p=2,l=!1;'
    'if(this.setupPanel(d,e,t,p,s===!0,a),e)this.sessionPanels.set(e,d);return{{startedInNewColumn:l}}}}'
    'setupPanel(e,t,n,r,o,s=!1){{this.panelFullEditor.set(e,!!r);let i={vs}.workspace.workspaceFolders?.map((h)=>h.uri.fsPath)||[],'
    'a={nc}(i);return a}}}}'
    'x.push(Wp("claude-vscode.editor.open",async({a},{b},{c},{d},{e},{f})=>{{let O=F({{programmatic:{f}?.programmatic}});'
    'if(O.target==="sidebar"){{let M=c.activateInSidebar({a},{b});try{{await rl("claude-vscode.sidebar.focus")}}catch(V){{throw c.clearPendingSidebarActivation(M),V}}return}}'
    'let{{startedInNewColumn:L,shownInSidebar:N}}=await c.createPanel({a},{b},{c},{d},{e},O.focusInput);if(L)await kS();'
    'if(O.updatePreferredLocationToPanel&&N!==!0)as(n.setPreferredLocation("panel"))}}));'
    'x.push(Wp("claude-vscode.editor.openLast",async()=>{{await rl("claude-vscode.editor.open")}}));'
)
# Runs a patched stand-in under a fake vscode and prints what the folder rule and the open command did.
RUNNER = r"""
const vm = require('vm'), fs = require('fs')
const code = fs.readFileSync(process.argv[1], 'utf8')
function run(folders, pickResult, target = 'panel') {
  const calls = [], H = {}, picks = []
  const fake = { workspace: { workspaceFolders: folders.map((f) => ({ name: f.split('/').pop(), uri: { fsPath: f } })) },
    window: { showQuickPick: async (items) => { picks.push(items.map((i) => i.fsPath)); return pickResult } } }
  const ctx = vm.createContext({ x: [], Wp: (id, fn) => { H[id] = fn }, F: () => ({ target, focusInput: 1 }),
    c: { createPanel: async (...a) => { calls.push(a); return { startedInNewColumn: false } }, activateInSidebar: () => 1, clearPendingSidebarActivation: () => {} }, kS: async () => {}, rl: async () => {},
    $e: fake, Pe: fake, require: (m) => { if (m !== 'vscode') throw new Error(m); return fake } })
  vm.runInContext(code + ';globalThis.W=W', ctx)
  return { H, calls, picks, ctx }
}
const open = async (folders, pickResult, target, ...args) => {
  const q = run(folders, pickResult, target)
  await q.H['claude-vscode.editor.open'](...args)
  return { last: q.calls.map((a) => a[a.length - 1] ?? null), n: q.calls.length, picks: q.picks.length }
}
;(async () => {
  const r = run(['/a', '/b'])
  const sp = (cwd) => r.ctx.W.prototype.setupPanel.call({ panelFullEditor: new Map() }, 1, 2, 3, 4, 5, false, cwd)
  const out = { setup: [sp('/b'), sp('/x'), sp(undefined)] }
  out.cwdGiven = await open(['/a', '/b'], undefined, 'panel', undefined, undefined, undefined, undefined, true, { cwd: '/b' })
  out.picked = await open(['/a', '/b'], { fsPath: '/b' }, 'panel', undefined, undefined, undefined, undefined, true, {})
  out.cancel = await open(['/a', '/b'], undefined, 'panel', undefined, undefined, undefined, undefined, true, {})
  out.single = await open(['/a'], { fsPath: '/z' }, 'panel', undefined, undefined, undefined, undefined, true)
  out.resume = await open(['/a', '/b'], { fsPath: '/z' }, 'panel', 'sid', undefined, undefined, undefined, true)
  out.bare = await open(['/a', '/b'], { fsPath: '/z' }, 'panel')
  out.sidebar = await open(['/a', '/b'], { fsPath: '/z' }, 'sidebar', undefined, undefined, undefined, undefined, true, {})
  console.log(JSON.stringify(out))
})()
"""
V327 = dict(nc="nC", vs="$e", a="w", b="A", c="C", d="T", e="R", f="x")
V328 = dict(nc="$v", vs="Pe", a="w", b="T", c="C", d="A", e="k", f="z")
PKG = {"name": "claude-code", "publisher": "Anthropic", "version": "2.1.328"}


def build(variant):
    return TEMPLATE.format(**variant).encode("utf-8")


def slurp(path):
    with open(path, "rb") as f:
        return f.read()


def snap(root):
    out = {}
    for d, dirs, files in os.walk(root):
        for n in dirs + files:
            p = os.path.join(d, n)
            out[p] = ("link", os.readlink(p)) if os.path.islink(p) else ("file", slurp(p)) if os.path.isfile(p) else ("dir",)
    return out


def load_module():
    spec = importlib.util.spec_from_file_location("patch_claude", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Case(unittest.TestCase):
    def setUp(self):
        self.t = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.t, True)
        self.ext = self.make(V327)

    def make(self, variant, name="ext", raw=None, pkg=PKG):
        d = os.path.join(self.t, name)
        os.makedirs(d)
        with open(os.path.join(d, "extension.js"), "wb") as f:
            f.write(raw if raw is not None else build(variant))
        with open(os.path.join(d, "package.json"), "w") as f:
            json.dump(pkg, f)
        return d

    def run_script(self, *args):
        p = subprocess.run([PY, "-I", SCRIPT, *args], capture_output=True, text=True)
        self.out, self.err, self.rc = p.stdout, p.stderr, p.returncode
        return p

    def js(self, ext=None):
        return slurp(os.path.join(ext or self.ext, "extension.js"))

    def assertUnchanged(self, ext, *args):
        before = snap(ext)
        self.run_script(ext, *args)
        self.assertEqual(snap(ext), before)


class Check(Case):
    def test_patchable_with_both_naming_variants(self):
        for variant in (V327, V328):
            ext = self.make(variant, name="v%s" % variant["nc"].strip("$"))
            before = snap(ext)
            self.run_script(ext)
            self.assertEqual((self.rc, self.out), (0, "unpatched-patchable 2.1.328\n"))
            self.assertEqual(snap(ext), before)

    def test_each_missing_anchor_is_named_and_nothing_changes(self):
        breaks = {
            "createPanel signature": ("a=!1){if(e)", "a=!1,u=2){if(e)"),
            "setupPanel call": ("s===!0,a)", "s===!0,a,0)"),
            "setupPanel start": ("workspaceFolders?.map", "workspaceFolders.map"),
            "editor.open command": ("O.focusInput", "O.focusInputs"),
        }
        for label, (old, new) in breaks.items():
            raw = build(V328).decode("utf-8")
            self.assertEqual(raw.count(old), 1, label)
            ext = self.make(V328, name="m%d" % len(os.listdir(self.t)), raw=raw.replace(old, new).encode("utf-8"))
            self.run_script(ext)
            self.assertEqual(self.rc, 1)
            self.assertTrue(self.out.startswith("anchors-missing 2.1.328: "), self.out)
            self.assertIn(label.split()[0], self.out)
            self.assertIn("no match", self.out)
            self.assertUnchanged(ext, "--apply")
            self.assertEqual(self.rc, 1)
            self.assertFalse(os.path.exists(os.path.join(ext, "extension.js.callboard-orig")))

    def test_a_doubled_anchor_is_refused(self):
        raw = build(V327)
        ext = self.make(V327, name="dup", raw=raw + raw[raw.index(b"x.push(Wp("):raw.index(b"x.push(Wp(\"claude-vscode.editor.openLast")])
        self.run_script(ext)
        self.assertEqual(self.rc, 1)
        self.assertIn("editor.open command (2 matches)", self.out)

    def test_a_file_that_already_names_the_patch_is_refused(self):
        ext = self.make(V327, name="own", raw=build(V327) + b"var cbCwd=1;")
        self.run_script(ext)
        self.assertEqual(self.rc, 1)
        self.assertIn("already contains cbCwd", self.out)


class Apply(Case):
    def test_apply_backup_marker_idempotence_and_undo(self):
        orig = self.js()
        self.run_script(self.ext, "--apply")
        self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "patched 2.1.328"))
        new = self.js()
        self.assertEqual(new.count(b"cbCwd"), 5)
        for part in (b"a=!1,cbCwd){", b"s===!0,a,cbCwd)", b"s=!1,cbCwd){", b"nC(i.includes(cbCwd)?[cbCwd]:i)", b"if(cbqC===null)return;let{startedInNewColumn:L,shownInSidebar:N}=await c.createPanel(w,A,C,T,R,O.focusInput,void 0,!1,cbqC)"):
            self.assertIn(part, new)
        self.assertIn("é".encode("utf-8"), new)
        self.assertEqual(slurp(os.path.join(self.ext, "extension.js.callboard-orig")), orig)
        marker = json.loads(slurp(os.path.join(self.ext, "callboard-cwd-patch.json")))
        self.assertEqual((marker["patch"], marker["original_sha256"], marker["patched_sha256"]),
                         (1, hashlib.sha256(orig).hexdigest(), hashlib.sha256(new).hexdigest()))
        self.assertEqual(os.stat(os.path.join(self.ext, "extension.js")).st_mode & 0o777, os.stat(os.path.join(self.ext, "extension.js.callboard-orig")).st_mode & 0o777)

        self.assertUnchanged(self.ext)
        self.assertEqual((self.rc, self.out), (0, "patched 2.1.328\n"))
        self.assertUnchanged(self.ext, "--apply")
        self.assertEqual((self.rc, self.out), (0, "already patched 2.1.328\n"))

        self.run_script(self.ext, "--undo")
        self.assertEqual(self.rc, 0)
        self.assertEqual(self.js(), orig)
        self.assertEqual(sorted(os.listdir(self.ext)), ["extension.js", "package.json"])
        self.assertUnchanged(self.ext, "--undo")
        self.assertEqual((self.rc, self.out), (0, "nothing to undo\n"))

    def test_the_renamed_variant_patches_too(self):
        ext = self.make(V328, name="r")
        self.run_script(ext, "--apply")
        self.assertEqual(self.rc, 0)
        self.assertIn(b"$v(i.includes(cbCwd)?[cbCwd]:i)", self.js(ext))
        self.assertIn(b'typeof z?.cwd=="string")return z.cwd;if(w!==void 0||!z||cbqF.length<2)return;', self.js(ext))

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_the_patched_code_runs_the_picker_and_the_folder_rule(self):
        """Runs the patched stand-in in node with a fake vscode: the folder rule in setupPanel and every way the open command can start."""
        for variant in (V327, V328):
            ext = self.make(variant, name="run-" + variant["nc"].strip("$"))
            self.run_script(ext, "--apply")
            p = subprocess.run(["node", "-e", RUNNER, os.path.join(ext, "extension.js")], capture_output=True, text=True, timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr)
            got = json.loads(p.stdout)
            self.assertEqual(got["setup"], ["/b", "/a", "/a"], "a cwd of the window is taken; another one, or none, is the first folder")
            self.assertEqual(got["cwdGiven"], {"last": ["/b"], "n": 1, "picks": 0}, "callboard's {cwd} is passed and never prompts")
            self.assertEqual(got["picked"], {"last": ["/b"], "n": 1, "picks": 1}, "a fresh open in a two-folder window asks, and uses the answer")
            self.assertEqual(got["cancel"], {"last": [], "n": 0, "picks": 1}, "cancelling the list opens nothing")
            self.assertEqual(got["single"], {"last": [None], "n": 1, "picks": 0}, "one folder: no prompt, as before")
            self.assertEqual(got["resume"], {"last": [None], "n": 1, "picks": 0}, "resuming a session: no prompt")
            self.assertEqual(got["bare"], {"last": [None], "n": 1, "picks": 0}, "a bare call (the palette, Open, an @-mention) never asks")
            self.assertEqual(got["sidebar"], {"last": [], "n": 0, "picks": 0}, "the sidebar target never asks and opens no panel")

    def test_a_failed_write_puts_the_original_back_and_leaves_nothing(self):
        for failing in ("extension.js", "callboard-cwd-patch.json"):
            ext = self.make(V327, name="f-" + failing)
            mod = load_module()
            orig = self.js(ext)
            real = mod.put

            def put(path, content, mode, failing=failing, real=real):
                if os.path.basename(path) == failing:
                    raise OSError(28, "No space left on device")
                real(path, content, mode)

            mod.put = put
            with self.assertRaises(SystemExit) as cm:
                mod.apply(ext)
            self.assertEqual(cm.exception.code, 1, failing)
            self.assertEqual(self.js(ext), orig, failing)
            self.assertEqual(sorted(os.listdir(ext)), ["extension.js", "package.json"], failing)

    def test_every_anchor_must_match_once_on_the_bytes_that_are_written(self):
        mod = load_module()
        raw = build(V327)
        self.assertEqual(mod.patched(raw).count(b"cbCwd"), 5)
        doubled = raw + raw[raw.index(b"x.push(Wp("):raw.index(b'x.push(Wp("claude-vscode.editor.openLast')]
        with self.assertRaises(SystemExit):
            mod.patched(doubled)

    def test_a_corrupt_marker_reads_as_leftovers_and_undo_recovers_from_the_backup(self):
        orig = self.js()
        self.run_script(self.ext, "--apply")
        with open(os.path.join(self.ext, "callboard-cwd-patch.json"), "w") as f:
            f.write("{")
        self.run_script(self.ext)
        self.assertEqual((self.rc, self.out.split(":")[0]), (1, "leftovers 2.1.328"))
        self.run_script(self.ext, "--undo")
        self.assertEqual((self.rc, self.js()), (0, orig))
        self.assertEqual(sorted(os.listdir(self.ext)), ["extension.js", "package.json"])

    def test_leftovers_block_apply_and_undo_clears_them(self):
        orig = self.js()
        self.run_script(self.ext, "--apply")
        os.unlink(os.path.join(self.ext, "callboard-cwd-patch.json"))
        self.run_script(self.ext)
        self.assertEqual((self.rc, self.out.split(":")[0]), (1, "leftovers 2.1.328"))
        self.assertUnchanged(self.ext, "--apply")
        self.assertEqual(self.rc, 1)
        self.run_script(self.ext, "--undo")
        self.assertEqual((self.rc, self.js()), (0, orig))
        self.assertEqual(sorted(os.listdir(self.ext)), ["extension.js", "package.json"])

    def test_undo_refuses_a_backup_that_is_not_the_recorded_original(self):
        self.run_script(self.ext, "--apply")
        with open(os.path.join(self.ext, "extension.js.callboard-orig"), "ab") as f:
            f.write(b"x")
        self.assertUnchanged(self.ext, "--undo")
        self.assertEqual(self.rc, 1)

    def test_undo_without_a_backup_restores_nothing_unless_the_file_is_the_original(self):
        self.run_script(self.ext, "--apply")
        os.unlink(os.path.join(self.ext, "extension.js.callboard-orig"))
        self.assertUnchanged(self.ext, "--undo")
        self.assertEqual(self.rc, 1)


class Refusals(Case):
    def test_not_a_claude_extension_folder(self):
        for pkg in ({"name": "other", "publisher": "Anthropic", "version": "1.0.0"}, {"name": "claude-code", "publisher": "x", "version": "1.0.0"},
                    {"name": "claude-code", "publisher": "Anthropic", "version": "latest"}):
            ext = self.make(V327, name="n%d" % len(os.listdir(self.t)), pkg=pkg)
            for flag in ("--apply", "--undo"):
                self.assertUnchanged(ext, flag)
                self.assertEqual(self.rc, 1)

    def test_links_are_refused(self):
        link = os.path.join(self.t, "link")
        os.symlink(self.ext, link)
        self.run_script(link)
        self.assertEqual(self.rc, 1)
        other = os.path.join(self.t, "other.js")
        shutil.move(os.path.join(self.ext, "extension.js"), other)
        os.symlink(other, os.path.join(self.ext, "extension.js"))
        self.assertUnchanged(self.ext, "--apply")
        self.assertEqual(self.rc, 1)
        self.assertEqual(slurp(other), build(V327))

    def test_a_fifo_in_place_of_a_file_is_refused_and_does_not_hang(self):
        os.unlink(os.path.join(self.ext, "extension.js"))
        os.mkfifo(os.path.join(self.ext, "extension.js"))
        p = subprocess.run([PY, "-I", SCRIPT, self.ext], capture_output=True, text=True, timeout=20)
        self.assertEqual(p.returncode, 1)

    def test_a_missing_folder_and_a_missing_file(self):
        self.run_script(os.path.join(self.t, "none"))
        self.assertEqual(self.rc, 1)
        os.unlink(os.path.join(self.ext, "extension.js"))
        self.run_script(self.ext)
        self.assertEqual(self.rc, 1)

    def test_usage(self):
        for args in ([], [self.ext, "--apply", "--undo"], [self.ext, "--force"], [self.ext, self.ext]):
            self.run_script(*args)
            self.assertEqual(self.rc, 2, args)


if __name__ == "__main__":
    unittest.main()
