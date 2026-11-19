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
    '{html}'
)
# The webview page builder, as the extension's host writes it: the stylesheet link, then the font configuration style tag, inside a template literal.
HTML = (
    'function Hp(u,S){{return`<!DOCTYPE html>\n      <head>\n        <link href="${{u}}" rel="stylesheet">\n        <style id="claude-font-configuration">\n'
    '          :root {{\n            --vscode-editor-font-family: ${{S}} !important;\n          }}\n        </style>\n      </head>`}}'
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


def build(variant, html=HTML):
    return TEMPLATE.format(html=html.format(), **variant).encode("utf-8")


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
        self.assertEqual(mod.patched(raw)[0].count(b"cbCwd"), 5)
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


# Runs the page builder of a patched stand-in and prints the page it returns.
PAGE = r"""
const vm = require('vm'), fs = require('fs')
const ctx = vm.createContext({ require: () => ({}), x: [], Wp: () => {}, F: () => ({}) })
vm.runInContext(fs.readFileSync(process.argv[1], 'utf8') + ';globalThis.Hp=Hp', ctx)
console.log(JSON.stringify(ctx.Hp('/a.css', 'mono')))
"""


class Look(Case):
    """The panel look is one optional style block in the webview page; the folder patch never depends on it."""

    def applied(self, raw, name="look"):
        ext = self.make(V327, name=name, raw=raw)
        self.run_script(ext, "--apply")
        return ext, json.loads(slurp(os.path.join(ext, "callboard-cwd-patch.json")))

    def test_the_block_goes_between_the_stylesheet_and_the_font_tag_once(self):
        mod = load_module()
        ext, marker = self.applied(build(V327))
        self.assertEqual((self.rc, marker["look"]), (0, True))
        self.assertEqual(self.out.count("warning"), 0)
        new = self.js(ext).decode("utf-8")
        self.assertEqual(new.count('<style id="callboard-look">'), 1)
        self.assertIn('rel="stylesheet">\n        <style id="callboard-look">' + mod.LOOK_CSS + '</style>\n        <style id="claude-font-configuration">', new)

    def test_the_css_is_safe_inside_a_template_literal_and_covers_the_three_things(self):
        mod = load_module()
        for bad in ("`", "\\", "${"):
            self.assertNotIn(bad, mod.LOOK_CSS)
        for part in ('inputWrapper_', 'permissionsContainer_', 'inputContainer_', 'max-width:none', '[aria-label="Remote Control"] svg{display:block', '[aria-label="Remote Control"] span{display:none'):
            self.assertIn(part, mod.LOOK_CSS)

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_the_patched_page_builder_still_runs_and_carries_the_block(self):
        mod = load_module()
        ext, _ = self.applied(build(V327), name="page")
        p = subprocess.run(["node", "-e", PAGE, os.path.join(ext, "extension.js")], capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        page = json.loads(p.stdout)
        self.assertIn('<link href="/a.css" rel="stylesheet">', page)
        self.assertIn(mod.LOOK_CSS, page)
        self.assertIn("--vscode-editor-font-family: mono", page)

    def test_a_renamed_expression_and_other_whitespace_still_match(self):
        html = HTML.replace("${{u}}", "${{n.cssUri}}").replace('rel="stylesheet">\n        <style', 'rel="stylesheet"><style')
        ext, marker = self.applied(build(V327, html), name="tol")
        self.assertEqual((self.rc, marker["look"]), (0, True))
        self.assertIn(b'rel="stylesheet"><style id="callboard-look">', self.js(ext))

    def test_a_missing_look_anchor_costs_only_the_look(self):
        misses = {
            "no builder": "",
            "no font tag": HTML.replace("claude-font-configuration", "font-config"),
            "link after the tag": HTML.replace('<link href="${{u}}" rel="stylesheet">', '<link rel="stylesheet" href="${{u}}">'),
            "two builders": HTML + HTML.replace("Hp", "Hq"),
        }
        for label, html in misses.items():
            raw = build(V327, html)
            ext = self.make(V327, name="miss%d" % len(os.listdir(self.t)), raw=raw)
            before = snap(ext)
            self.run_script(ext)
            self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "unpatched-patchable 2.1.328"), label)
            self.assertIn("warning: the panel look would be left out (look anchor (", self.out, label)
            self.assertEqual(snap(ext), before, label)
            self.run_script(ext, "--apply")
            self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "patched 2.1.328"), label)
            self.assertIn("warning: the panel look is not in (look anchor (", self.out, label)
            new = self.js(ext)
            self.assertEqual(new.count(b"cbCwd"), 5, label)
            self.assertNotIn(b"callboard-look", new, label)
            self.assertEqual(json.loads(slurp(os.path.join(ext, "callboard-cwd-patch.json")))["look"], False, label)
            self.run_script(ext)
            self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "patched 2.1.328"), label)
            self.assertIn("warning: the panel look is not in this patch.", self.out, label)
            self.run_script(ext, "--undo")
            self.assertEqual((self.rc, self.js(ext)), (0, raw), label)
            self.assertEqual(sorted(os.listdir(ext)), ["extension.js", "package.json"], label)

    def test_a_page_that_already_has_the_block_is_left_alone(self):
        raw = build(V327, HTML.replace("<head>", '<head><style id="callboard-look"></style>'))
        ext, marker = self.applied(raw, name="have")
        self.assertEqual((self.rc, marker["look"]), (0, False))
        self.assertEqual(self.js(ext).count(b"callboard-look"), 1)
        self.assertIn("the file already contains callboard-look", self.out)

    def test_undo_takes_the_block_out_with_the_rest(self):
        raw = build(V327)
        ext, _ = self.applied(raw, name="undo")
        self.assertIn(b"callboard-look", self.js(ext))
        self.run_script(ext, "--undo")
        self.assertEqual((self.rc, self.js(ext)), (0, raw))
        self.assertEqual(sorted(os.listdir(ext)), ["extension.js", "package.json"])


# The composer footer of the webview bundle, as the extension writes it: the fit stage on the footer, then the element list.
WEB_TEMPLATE = (
    'var q="é";function F({e},{st},{m},{k}){{return {k}("div",{{className:"f","data-fit-stage":{st},children:[{m}(rFt,{{}}),{m}(aFt,{{session:{e}}}),'
    '{e}.remoteControlState.value.status!=="disconnected"&&({e}.remoteControlState.value.status==="connected"||{e}.remoteControlAvailable.value!==!1)'
    '&&{m}(CFt,{{session:{e}}}),qe&&{m}(sFt,{{session:{e},onOpen:l}}),{st}!==2&&{m}(nAe,{{...Vt}}),{m}(pFt,{{}})]}})}}'
)
W1 = dict(e="e", st="_", m="m", k="k")
W2 = dict(e="$s", st="$t", m="$j", k="$k")
# Runs the footer of a patched stand-in for a folder and a fit stage and prints its element list and the pill.
FOOTER = r"""
const vm = require('vm'), fs = require('fs')
const ctx = vm.createContext({ rFt: 'rFt', aFt: 'aFt', CFt: 'CFt', sFt: 'sFt', nAe: 'nAe', pFt: 'pFt', qe: true, l: 0, Vt: {} })
vm.runInContext(fs.readFileSync(process.argv[1], 'utf8') + ';globalThis.F=F', ctx)
const j = (c, p) => ({ c, p }), k = (c, p) => p.children
const out = {}
for (const [name, cwd] of Object.entries({ unix: '/a/b/proj', win: 'C:\\x\\y\\win', slash: '/a/b/', none: undefined })) {
  for (const stage of [0, 1, 2]) {
    const sess = { cwd: { value: cwd }, remoteControlAvailable: { value: true }, remoteControlState: { value: { status: 'connected' } } }
    const kids = ctx.F(sess, stage, j, k).filter(Boolean)
    const pill = kids.find((x) => x.p && x.p['data-callboard'])
    out[name + stage] = { order: kids.map((x) => x.c), text: pill ? pill.p.children : null, title: pill ? pill.p.title : null }
  }
}
console.log(JSON.stringify(out))
"""


class Pill(Case):
    """The opt-in folder pill: a second file, its own marker field, and a miss that costs only the pill."""

    def web(self, ext, variant=W1, raw=None):
        os.makedirs(os.path.join(ext, "webview"), exist_ok=True)
        with open(os.path.join(ext, "webview", "index.js"), "wb") as f:
            f.write(raw if raw is not None else WEB_TEMPLATE.format(**variant).encode("utf-8"))
        return ext

    def webjs(self, ext=None):
        return slurp(os.path.join(ext or self.ext, "webview", "index.js"))

    def marker(self, ext=None):
        return json.loads(slurp(os.path.join(ext or self.ext, "callboard-cwd-patch.json")))

    def test_a_plain_apply_never_touches_the_webview(self):
        self.web(self.ext)
        web = self.webjs()
        self.run_script(self.ext, "--apply")
        self.assertEqual((self.rc, self.webjs(), "pill" in self.marker()), (0, web, False))
        self.assertFalse(os.path.exists(os.path.join(self.ext, "webview", "index.js.callboard-orig")))

    def test_apply_with_the_pill_patches_both_files_and_one_undo_removes_both(self):
        self.web(self.ext)
        orig, web = self.js(), self.webjs()
        self.run_script(self.ext, "--apply", "--with-pill")
        self.assertEqual(self.rc, 0, self.err)
        self.assertEqual(self.out.splitlines()[0], "patched 2.1.328")
        self.assertIn("pill in: webview/index.js", self.out)
        new = self.webjs()
        self.assertEqual(new.count(b"data-callboard"), 1)
        self.assertIn("é".encode("utf-8"), new)
        self.assertEqual(slurp(os.path.join(self.ext, "webview", "index.js.callboard-orig")), web)
        m = self.marker()
        self.assertEqual(m["pill"], {"original_sha256": hashlib.sha256(web).hexdigest(), "patched_sha256": hashlib.sha256(new).hexdigest()})
        self.assertEqual(m["patched_sha256"], hashlib.sha256(self.js()).hexdigest(), "the main file's fields are what they were")
        self.assertEqual(os.stat(os.path.join(self.ext, "webview", "index.js")).st_mode & 0o777, os.stat(os.path.join(self.ext, "webview", "index.js.callboard-orig")).st_mode & 0o777)
        self.run_script(self.ext)
        self.assertEqual((self.rc, self.out.splitlines()), (0, ["patched 2.1.328", "pill: in"]))
        self.assertUnchanged(self.ext, "--apply", "--with-pill")
        self.assertEqual((self.rc, self.out), (0, "already patched 2.1.328\npill already in\n"))
        self.run_script(self.ext, "--undo")
        self.assertEqual(self.rc, 0)
        self.assertIn("the original extension.js and webview/index.js are back", self.out)
        self.assertEqual((self.js(), self.webjs()), (orig, web))
        self.assertEqual(sorted(os.listdir(self.ext)), ["extension.js", "package.json", "webview"])
        self.assertEqual(os.listdir(os.path.join(self.ext, "webview")), ["index.js"])

    def test_the_pill_can_be_added_later_and_touches_only_the_webview_then(self):
        self.web(self.ext)
        self.run_script(self.ext, "--apply")
        main = self.js()
        self.run_script(self.ext, "--with-pill")
        self.assertEqual((self.rc, self.out.splitlines()[-1]), (0, "pill: --apply --with-pill would add it"))
        self.run_script(self.ext, "--apply", "--with-pill")
        self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "already patched 2.1.328"))
        self.assertEqual(self.js(), main)
        self.assertIn(b"data-callboard", self.webjs())
        self.run_script(self.ext, "--undo")
        self.assertEqual(sorted(os.listdir(self.ext)), ["extension.js", "package.json", "webview"])

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_the_patched_footer_shows_the_folder_name_and_leaves_at_the_narrowest_stage(self):
        for variant in (W1, W2):
            ext = self.web(self.make(V327, name="w" + variant["e"].strip("$")), variant)
            self.run_script(ext, "--apply", "--with-pill")
            self.assertEqual(self.rc, 0, self.err)
            p = subprocess.run(["node", "-e", FOOTER, os.path.join(ext, "webview", "index.js")], capture_output=True, text=True, timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr)
            got = json.loads(p.stdout)
            full = ["rFt", "aFt", "span", "CFt", "sFt", "nAe", "pFt"]
            self.assertEqual(got["unix0"], {"order": full, "text": "proj", "title": "/a/b/proj"}, "after the context meter, before the Remote Control chip")
            self.assertEqual(got["unix1"]["order"], full)
            self.assertEqual(got["unix2"], {"order": ["rFt", "aFt", "CFt", "sFt", "pFt"], "text": None, "title": None}, "gone at the narrowest stage, like the model pill")
            self.assertEqual((got["win0"]["text"], got["win0"]["title"]), ("win", "C:\\x\\y\\win"))
            self.assertEqual(got["slash0"]["text"], "b")
            for stage in "012":
                self.assertNotIn("span", got["none" + stage]["order"], "no folder known yet: no pill")

    def test_a_pill_miss_refuses_only_the_pill(self):
        base = WEB_TEMPLATE.format(**W1)
        misses = {
            "anchor gone": base.replace('"disconnected"&&', '"gone"&&'),
            "stage gone": base.replace('"data-fit-stage"', '"data-fit"'),
            "two footers": base + base.replace("function F", "function G"),
            "already there": base + 'var z="data-callboard";',
        }
        for label, raw in misses.items():
            ext = self.web(self.make(V327, name="pm%d" % len(os.listdir(self.t))), raw=raw.encode("utf-8"))
            self.run_script(ext, "--with-pill")
            self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "unpatched-patchable 2.1.328"), label)
            self.assertIn("pill: would be refused (", self.out, label)
            self.run_script(ext, "--apply", "--with-pill")
            self.assertEqual(self.rc, 1, label)
            self.assertEqual(self.out.splitlines()[0], "patched 2.1.328", label)
            self.assertIn("pill refused: ", self.out, label)
            self.assertEqual(self.js(ext).count(b"cbCwd"), 5, label)
            self.assertEqual(self.webjs(ext), raw.encode("utf-8"), label)
            self.assertNotIn("pill", self.marker(ext), label)
            self.assertFalse(os.path.exists(os.path.join(ext, "webview", "index.js.callboard-orig")), label)
            self.run_script(ext)
            self.assertEqual((self.rc, self.out), (0, "patched 2.1.328\n"), label)
            self.run_script(ext, "--undo")
            self.assertEqual((self.rc, self.webjs(ext)), (0, raw.encode("utf-8")), label)

    def test_no_webview_file_refuses_only_the_pill(self):
        self.run_script(self.ext, "--apply", "--with-pill")
        self.assertEqual((self.rc, self.out.splitlines()[0]), (1, "patched 2.1.328"))
        self.assertIn("pill refused: webview/index.js is missing", self.out)
        self.assertEqual(self.js().count(b"cbCwd"), 5)

    def test_a_failed_pill_write_puts_the_webview_and_the_marker_back_and_keeps_the_patch(self):
        for failing in ("index.js", "callboard-cwd-patch.json"):
            ext = self.web(self.make(V327, name="pf-" + failing))
            mod = load_module()
            self.assertEqual(mod.apply(ext), 0)
            web, marker, main = self.webjs(ext), slurp(os.path.join(ext, "callboard-cwd-patch.json")), self.js(ext)
            real = mod.put

            def put(path, content, mode, failing=failing, real=real):
                if os.path.basename(path) == failing:
                    raise OSError(28, "No space left on device")
                real(path, content, mode)

            mod.put = put
            self.assertEqual(mod.add_pill(ext), 1, failing)
            self.assertEqual((self.webjs(ext), slurp(os.path.join(ext, "callboard-cwd-patch.json")), self.js(ext)), (web, marker, main), failing)
            self.assertEqual(sorted(os.listdir(os.path.join(ext, "webview"))), ["index.js"], failing)
            self.assertEqual(sorted(os.listdir(ext)), ["callboard-cwd-patch.json", "extension.js", "extension.js.callboard-orig", "package.json", "webview"], failing)

    def test_a_webview_that_no_longer_matches_the_marker_is_reported(self):
        self.web(self.ext)
        self.run_script(self.ext, "--apply", "--with-pill")
        with open(os.path.join(self.ext, "webview", "index.js"), "ab") as f:
            f.write(b"//")
        self.run_script(self.ext)
        self.assertEqual(self.rc, 0)
        self.assertIn("warning: the pill is not in (webview/index.js does not match the marker).", self.out)

    def test_undo_checks_both_files_before_it_changes_either(self):
        self.web(self.ext)
        self.run_script(self.ext, "--apply", "--with-pill")
        os.unlink(os.path.join(self.ext, "webview", "index.js.callboard-orig"))
        self.assertUnchanged(self.ext, "--undo")
        self.assertEqual(self.rc, 1)
        self.assertIn(b"cbCwd", self.js())
        self.assertIn("backup is gone and webview/index.js is not known", self.err)

    def test_a_webview_backup_that_is_not_the_recorded_original_is_refused(self):
        self.web(self.ext)
        self.run_script(self.ext, "--apply", "--with-pill")
        with open(os.path.join(self.ext, "webview", "index.js.callboard-orig"), "ab") as f:
            f.write(b"x")
        self.assertUnchanged(self.ext, "--undo")
        self.assertEqual(self.rc, 1)

    def test_a_lone_webview_backup_is_a_leftover_and_undo_restores_from_it(self):
        self.web(self.ext)
        web = self.webjs()
        self.run_script(self.ext, "--apply", "--with-pill")
        os.unlink(os.path.join(self.ext, "callboard-cwd-patch.json"))
        self.run_script(self.ext)
        self.assertEqual((self.rc, self.out.split(":")[0]), (1, "leftovers 2.1.328"))
        self.run_script(self.ext, "--undo")
        self.assertEqual((self.rc, self.webjs()), (0, web))
        self.assertEqual(sorted(os.listdir(self.ext)), ["extension.js", "package.json", "webview"])

    def test_the_pill_flag_is_for_check_and_apply_only(self):
        for args in ([self.ext, "--undo", "--with-pill"], [self.ext, "--with-pill", "--with-pill"], [self.ext, "--apply", "--undo", "--with-pill"]):
            self.run_script(*args)
            self.assertEqual(self.rc, 2, args)


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
