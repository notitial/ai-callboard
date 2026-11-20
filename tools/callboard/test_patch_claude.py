"""Tests for patch-claude.py. Run: /usr/bin/python3 -I tools/callboard/test_patch_claude.py

Each case builds a small stand-in for the Claude Code extension's minified file in a temporary folder (one variant with the
names of 2.1.327, one with other minified names, as in 2.1.328) and runs the script on it, so nothing outside the
temporary folder is touched."""
import contextlib
import glob
import hashlib
import importlib.util
import io
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
    'function Act(c){{{vs}.window.registerWebviewPanelSerializer("claudeVSCodePanel",{{deserializeWebviewPanel:(w,T)=>nL(()=>{{c.notePanelRevived();'
    'let C=T,A=c.restoredTabSetup(C??{{}},w.title),k=A.fullEditor,x=sw(A.openSession)?A.openSession:void 0;c.setupPanel(w,x,void 0,k);'
    'let R=typeof C?.sessionID==="string"?C.sessionID:x;if(sw(R)&&ice(R,C?.sessionUpdatedAt))c.registerPanelSession(R,w)}})}})}}'
    'x.push(Wp("claude-vscode.editor.open",async({a},{b},{c},{d},{e},{f})=>{{let O=F({{programmatic:{f}?.programmatic}});'
    'if(O.target==="sidebar"){{let M=c.activateInSidebar({a},{b});try{{await rl("claude-vscode.sidebar.focus")}}catch(V){{throw c.clearPendingSidebarActivation(M),V}}return}}'
    'let{{startedInNewColumn:L,shownInSidebar:N}}=await c.createPanel({a},{b},{c},{d},{e},O.focusInput);if(L)await kS();'
    'if(O.updatePreferredLocationToPanel&&N!==!0)as(n.setPreferredLocation("panel"))}}));'
    'x.push(Wp("claude-vscode.editor.openLast",async()=>{{await rl("claude-vscode.editor.open")}}));'
    '{grp}'
    '{html}'
)
# The registration of the stock add-to-group command, inside a push call of the activation, with the provider's name `pv`.
GROUP = (
    'x.push({vs}.commands.registerCommand("claude-vscode.addSessionTabToGroup",async()=>{{if(!await {pv}.addActiveSessionTabToGroup())'
    '{vs}.window.showInformationMessage("No active Claude Code session tab to add to a group.")}}),{vs}.commands.registerCommand("claude-vscode.toggleFocusView",()=>1));'
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
    commands: { registerCommand: (id, fn) => { H[id] = fn; return {} } },
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
  const sp = (cwd) => r.ctx.W.prototype.setupPanel.call(Object.assign(Object.create(r.ctx.W.prototype), { panelFullEditor: new Map() }), 1, 2, 3, 4, 5, false, cwd)
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
V327 = dict(nc="nC", vs="$e", a="w", b="A", c="C", d="T", e="R", f="x", pv="G")
V328 = dict(nc="$v", vs="Pe", a="w", b="T", c="C", d="A", e="k", f="z", pv="Gq")
PKG = {"name": "claude-code", "publisher": "Anthropic", "version": "2.1.328"}


def build(variant, html=HTML, grp=GROUP):
    return TEMPLATE.format(html=html.format(), grp=grp.format(**variant), **variant).encode("utf-8")


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


# The pie's code in the shipped webview script, in the shape of the stock composer footer (ring, pie component, and the bar that passes the window); the names are
# minified and differ by version (sv: the ring, pc: the pie component, tf: the threshold function).
PIE_JS = (
    'var MBn={{50:"M7"}};function {sv}({{percentage:e,className:t}}){{let n=PBn(e),i=MBn[n];return k("svg",{{width:"20",height:"20",viewBox:"0 0 20 20",fill:"none",'
    'xmlns:"http://www.w3.org/2000/svg",className:t,style:{{display:"block"}},children:[i&&m("path",{{d:i,stroke:"currentColor",strokeOpacity:"0.15",strokeWidth:"1.5",'
    'strokeLinecap:"round"}}),m("path",{{d:DBn[n],stroke:"var(--app-claude-clay-button-orange)",strokeWidth:"1.5",strokeLinecap:"round"}})]}})}}'
    'function {pc}({{usedTokens:e,contextWindow:t,onCompact:n,buttonClassName:i}}){{let o=t>0?Math.min(e/t*100,100):0,r=100-o;if(t===0)return null;if(r>=50)return null;'
    'return m(FBn,{{percentageUsed:o,onCompact:n,buttonClassName:i}})}}'
    'function Bar(e){{return k("div",{{children:[m("button",{{}}),m({pc},{{usedTokens:e.usageData.value.totalTokens,'
    'contextWindow:{tf}(e.usageData.value.contextWindow,e.usageData.value.maxOutputTokens),onCompact:a,buttonClassName:ia.usageButtonV2}}),m(BFt,{{session:e}})]}})}}'
)
JS329 = dict(sv="tBt", pc="nBt", tf="NFt")
JS328 = dict(sv="SFt", pc="kFt", tf="tFt")
# A stand-in for the shipped webview, carrying the tokens the width piece checks and the pie's code, and what a stock extension folder then holds.
WEB = {"index.css": ".inputWrapper_a1,.permissionsContainer_b2,.inputContainer_c3{max-width:680px}", "index.js": PIE_JS.format(**JS329)}
STOCK = ["extension.js", "package.json", "webview"]


class Case(unittest.TestCase):
    def setUp(self):
        self.t = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.t, True)
        self.ext = self.make(V327)

    def make(self, variant, name="ext", raw=None, pkg=PKG, web=WEB):
        d = os.path.join(self.t, name)
        os.makedirs(os.path.join(d, "webview"))
        for n, text in web.items():
            with open(os.path.join(d, "webview", n), "w") as f:
                f.write(text)
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

    def older(self, ext, **attrs):
        """Patches ext in this process with a stand-in for an older script: the module's own apply, with some of its constants changed."""
        mod = load_module()
        for k, v in attrs.items():
            setattr(mod, k, v)
        with contextlib.redirect_stdout(io.StringIO()):
            mod.apply(ext)

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
        self.assertEqual(new.count(b"cbCwd"), 6)
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
        self.assertEqual(sorted(os.listdir(self.ext)), STOCK)
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
        for failing in ("index.js", "extension.js", "callboard-cwd-patch.json"):
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
            self.assertEqual(sorted(os.listdir(ext)), STOCK, failing)

    def test_every_anchor_must_match_once_on_the_bytes_that_are_written(self):
        mod = load_module()
        raw = build(V327)
        self.assertEqual(mod.patched(raw, (b"", b""))[0].count(b"cbCwd"), 6)
        doubled = raw + raw[raw.index(b"x.push(Wp("):raw.index(b'x.push(Wp("claude-vscode.editor.openLast')]
        with self.assertRaises(SystemExit):
            mod.patched(doubled, (b"", b""))

    def test_a_corrupt_marker_reads_as_leftovers_and_undo_recovers_from_the_backup(self):
        orig = self.js()
        self.run_script(self.ext, "--apply")
        with open(os.path.join(self.ext, "callboard-cwd-patch.json"), "w") as f:
            f.write("{")
        self.run_script(self.ext)
        self.assertEqual((self.rc, self.out.split(":")[0]), (1, "leftovers 2.1.328"))
        self.run_script(self.ext, "--undo")
        self.assertEqual((self.rc, self.js()), (0, orig))
        self.assertEqual(sorted(os.listdir(self.ext)), STOCK)

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
        self.assertEqual(sorted(os.listdir(self.ext)), STOCK)

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
const vs = { commands: { registerCommand: () => ({}) }, window: {} }
const ctx = vm.createContext({ require: () => ({}), x: [], Wp: () => {}, F: () => ({}), $e: vs, Pe: vs })
vm.runInContext(fs.readFileSync(process.argv[1], 'utf8') + ';globalThis.Hp=Hp', ctx)
console.log(JSON.stringify(ctx.Hp('/a.css', 'mono')))
"""


class Css(Case):
    """The CSS pieces are optional style blocks of their own in the webview page, each checked against the shipped webview; the folder patch never depends on them."""

    def applied(self, raw, name="css", web=WEB):
        ext = self.make(V327, name=name, raw=raw, web=web)
        self.run_script(ext, "--apply")
        return ext, json.loads(slurp(os.path.join(ext, "callboard-cwd-patch.json")))

    def test_each_block_goes_in_front_of_the_font_tag_once(self):
        mod = load_module()
        ext, marker = self.applied(build(V327))
        self.assertEqual((self.rc, marker["width"], marker["pie"], "chip" in marker), (0, True, True, False))
        self.assertEqual(self.out.count("warning"), 0)
        new = self.js(ext).decode("utf-8")
        self.assertEqual((new.count('<style id="callboard-width">'), new.count('<style id="callboard-pie">')), (1, 1))
        self.assertIn('rel="stylesheet">\n        <style id="callboard-width">' + mod.WIDTH_CSS + '</style><style id="callboard-pie">' + mod.PIE_CSS
                      + '</style><style id="claude-font-configuration">', new)

    def test_the_css_is_safe_inside_a_template_literal_and_the_remote_control_chip_is_left_alone(self):
        mod = load_module()
        for bad in ("`", "\\", "${"):
            self.assertNotIn(bad, mod.WIDTH_CSS)
        for bad in ("`", "\\"):
            self.assertNotIn(bad, mod.PIE_CSS)
        self.assertEqual(mod.PIE_CSS.count("${"), 1)
        for part in ("inputWrapper_", "permissionsContainer_", "inputContainer_", "max-width:none"):
            self.assertIn(part, mod.WIDTH_CSS)
        self.assertFalse(hasattr(mod, "CHIP_CSS"))
        self.assertNotIn("aria-label", slurp(SCRIPT).decode())

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_the_patched_page_builder_still_runs_and_carries_the_blocks(self):
        mod = load_module()
        ext, _ = self.applied(build(V327), name="page")
        p = subprocess.run(["node", "-e", PAGE, os.path.join(ext, "extension.js")], capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        page = json.loads(p.stdout)
        self.assertIn('<link href="/a.css" rel="stylesheet">', page)
        self.assertIn(mod.WIDTH_CSS, page)
        self.assertIn(":root{--callboard-compact:0}", page, "no settings are readable in the stand-in: no level")
        self.assertIn("--vscode-editor-font-family: mono", page)

    def test_a_missing_or_linked_webview_leaves_out_the_pieces_that_need_it(self):
        ext = self.make(V327, name="noweb", web={})
        os.symlink(os.path.join(self.t, "elsewhere.js"), os.path.join(ext, "webview", "index.js"))
        self.run_script(ext, "--apply")
        marker = json.loads(slurp(os.path.join(ext, "callboard-cwd-patch.json")))
        self.assertEqual((self.rc, marker["width"], marker["pie"], marker["restore"]), (0, False, False, True))
        self.assertIn("the panel width is not in (the webview lacks", self.out)
        self.assertIn("the context pie is not in (pie anchor pie component (no match))", self.out)

    def test_a_webview_that_lacks_a_token_costs_only_the_width(self):
        ext, marker = self.applied(build(V327), name="tok", web={"index.js": WEB["index.js"]})
        self.assertEqual((self.rc, marker["width"], marker["pie"]), (0, False, True))
        self.assertIn("is not in (the webview lacks", self.out)
        self.assertNotIn(b"callboard-width", self.js(ext))
        self.assertIn(b"callboard-pie", self.js(ext))

    def test_a_missing_font_tag_costs_only_the_css_pieces(self):
        misses = {
            "no builder": "",
            "no font tag": HTML.replace("claude-font-configuration", "font-config"),
            "two builders": HTML + HTML.replace("Hp", "Hq"),
        }
        for label, html in misses.items():
            raw = build(V327, html)
            ext = self.make(V327, name="miss%d" % len(os.listdir(self.t)), raw=raw)
            before = snap(ext)
            self.run_script(ext)
            self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "unpatched-patchable 2.1.328"), label)
            self.assertIn("warning: the panel width would be left out (font tag anchor (", self.out, label)
            self.assertIn("warning: the context pie would be left out (font tag anchor (", self.out, label)
            self.assertEqual(snap(ext), before, label)
            self.run_script(ext, "--apply")
            self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "patched 2.1.328"), label)
            self.assertIn("warning: the panel width is not in (font tag anchor (", self.out, label)
            new = self.js(ext)
            self.assertEqual(new.count(b"cbCwd"), 6, label)
            self.assertNotIn(b"callboard-width", new, label)
            marker = json.loads(slurp(os.path.join(ext, "callboard-cwd-patch.json")))
            self.assertEqual((marker["width"], marker["pie"]), (False, False), label)
            self.assertEqual(slurp(os.path.join(ext, "webview", "index.js")), WEB["index.js"].encode(), label)
            self.assertFalse(os.path.exists(os.path.join(ext, "webview", "index.js.callboard-orig")), label)
            self.run_script(ext)
            self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "patched 2.1.328"), label)
            self.assertIn("warning: the panel width is not in this patch.", self.out, label)
            self.run_script(ext, "--undo")
            self.assertEqual((self.rc, self.js(ext)), (0, raw), label)
            self.assertEqual(sorted(os.listdir(ext)), STOCK, label)

    def test_a_page_that_already_has_a_block_keeps_it_and_takes_the_other(self):
        raw = build(V327, HTML.replace("<head>", '<head><style id="callboard-width"></style>'))
        ext, marker = self.applied(raw, name="have")
        self.assertEqual((self.rc, marker["width"], marker["pie"]), (0, False, True))
        self.assertEqual(self.js(ext).count(b"callboard-width"), 1)
        self.assertIn("the file already contains callboard-width", self.out)

    def test_undo_takes_the_blocks_out_with_the_rest(self):
        raw = build(V327)
        ext, _ = self.applied(raw, name="undo")
        self.assertIn(b"callboard-pie", self.js(ext))
        self.run_script(ext, "--undo")
        self.assertEqual((self.rc, self.js(ext)), (0, raw))
        self.assertEqual(slurp(os.path.join(ext, "webview", "index.js")), WEB["index.js"].encode())
        self.assertEqual(sorted(os.listdir(ext)), STOCK)
        self.assertEqual(sorted(os.listdir(os.path.join(ext, "webview"))), ["index.css", "index.js"])


# Runs the patched stand-in's group command against a fake provider that keeps the group list the way Claude's settings do, and prints what it did.
GROUPS_RUNNER = r"""
const vm = require('vm'), fs = require('fs')
const code = fs.readFileSync(process.argv[1], 'utf8')
const start = JSON.parse(process.argv[2])
async function run(groups, sid, name) {
  const H = {}, saved = []
  const provider = { settings: { getSessionGroups: () => groups, getArchivedSessionIds: () => start.archived || [] }, persistGroupsFromHost: (g) => saved.push(g), addActiveSessionTabToGroup: async () => true, activePanelSessionId: () => 'sid-front' }
  const fake = { workspace: {}, window: {}, commands: { registerCommand: (id, fn) => { H[id] = fn; return {} } } }
  const ctx = vm.createContext({ x: [], Wp: () => {}, F: () => ({}), G: provider, Gq: provider, $e: fake, Pe: fake, require: (m) => (m === 'crypto' ? { randomUUID: () => 'new-id' } : fake) })
  vm.runInContext(code, ctx)
  const result = await H['callboard assign group'](sid, name)
  return { result, saved, front: H['callboard active session'](), stock: typeof H['claude-vscode.addSessionTabToGroup'], other: typeof H['claude-vscode.toggleFocusView'] }
}
;(async () => {
  const out = []
  for (const [sid, name] of start.calls) out.push(await run(JSON.parse(JSON.stringify(start.groups)), sid, name))
  console.log(JSON.stringify(out))
})()
"""
G1 = {"id": "g1", "name": "LANES", "collapsed": True, "sessionIds": ["s0"]}
G2 = {"id": "g2", "name": "LEAD", "collapsed": False, "sessionIds": ["s9"]}


class Groups(Case):
    """The group command is one optional registration next to the stock add-to-group command; the folder patch never depends on it."""

    def applied(self, raw, name="grp"):
        ext = self.make(V327, name=name, raw=raw)
        self.run_script(ext, "--apply")
        return ext, json.loads(slurp(os.path.join(ext, "callboard-cwd-patch.json")))

    def drive(self, ext, groups, *calls, archived=()):
        p = subprocess.run(["node", "-e", GROUPS_RUNNER, os.path.join(ext, "extension.js"), json.dumps({"groups": groups, "calls": calls, "archived": archived})], capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)

    def test_both_variants_patch_with_the_marker_still_at_one(self):
        for variant in (V327, V328):
            ext = self.make(variant, name="v%s" % variant["pv"])
            self.run_script(ext)
            self.assertEqual((self.rc, self.out.splitlines()), (0, ["unpatched-patchable 2.1.328"]))
            self.run_script(ext, "--apply")
            self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "patched 2.1.328"))
            self.assertEqual(self.out.count("warning"), 0)
            marker = json.loads(slurp(os.path.join(ext, "callboard-cwd-patch.json")))
            self.assertEqual((marker["patch"], marker["width"], marker["pie"], marker["groups"], marker["session"]), (1, True, True, True, True))
            new = self.js(ext)
            self.assertEqual((new.count(b"callboard assign group"), new.count(b"callboard active session")), (1, 1))
            self.assertEqual(new.count(b"cbCwd"), 6)

    def test_the_command_goes_in_front_of_the_stock_one_inside_its_push_call(self):
        ext, _ = self.applied(build(V328), name="front")
        new = self.js(ext).decode("utf-8")
        i, j = new.index("Pe.commands.registerCommand(\"callboard assign group\""), new.index("Pe.commands.registerCommand(\"claude-vscode.addSessionTabToGroup\"")
        self.assertLess(i, j)
        self.assertEqual(new[i:j].count("registerCommand"), 2, "the group command, then the session command")
        self.assertTrue(new[:i].endswith("x.push("))
        self.assertTrue(new[i:j].endswith('Pe.commands.registerCommand("callboard active session",()=>Gq.activePanelSessionId()),'))

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_the_command_puts_a_session_in_a_group_by_name_creates_a_missing_one_and_leaves_a_grouped_session(self):
        for variant in (V327, V328):
            ext = self.make(variant, name="run%s" % variant["pv"])
            self.run_script(ext, "--apply")
            r = self.drive(ext, [G1, G2], ["s1", "Lanes"], ["s2", "Conductor"], ["s0", "Lead"], ["s9", "lanes"], [5, "Lead"], ["s3", ""], ["s1", "lead"])
            joined = lambda g, sid, n: {**g, "sessionIds": g["sessionIds"] + [sid]}
            self.assertEqual(r[0]["saved"], [[joined(G1, "s1", 0), G2]], "a name in another letter case finds the group")
            self.assertEqual(r[1]["saved"], [[G1, G2, {"id": "new-id", "name": "Conductor", "collapsed": False, "sessionIds": ["s2"]}]], "a missing group is created")
            self.assertEqual((r[2]["result"], r[2]["saved"]), (True, []), "a session already in a group stays where it is")
            self.assertEqual((r[3]["result"], r[3]["saved"]), (True, []))
            self.assertEqual([(x["result"], x["saved"]) for x in r[4:6]], [(False, []), (False, [])], "bad arguments do nothing")
            self.assertEqual(r[6]["saved"], [[G1, joined(G2, "s1", 0)]])
            self.assertEqual([x["result"] for x in (r[0], r[1], r[6])], [True, True, True])
            self.assertEqual((r[0]["stock"], r[0]["other"]), ("function", "function"), "the stock commands are still registered")
            self.assertEqual(r[0]["front"], "sid-front", "the session command returns the provider's panel in front")

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_the_command_refuses_an_archived_session_and_the_stock_list_limits(self):
        ext = self.make(V327, name="refuse")
        self.run_script(ext, "--apply")
        arch = self.drive(ext, [G1], ["s1", "Lanes"], archived=["s1"])
        self.assertEqual((arch[0]["result"], arch[0]["saved"]), (False, []), "the provider's save would drop an archived id")
        full = [{"id": "g%d" % i, "name": "N%d" % i, "collapsed": False, "sessionIds": []} for i in range(100)]
        r = self.drive(ext, full, ["s1", "Lanes"], ["s1", "n5"])
        self.assertEqual((r[0]["result"], r[0]["saved"]), (False, []), "100 groups: no new one")
        self.assertEqual(r[1]["result"], True, "an existing group still takes the session")
        crowded = [{"id": "g1", "name": "A", "collapsed": False, "sessionIds": ["x%d" % i for i in range(1000)]}, G2]
        r = self.drive(ext, crowded, ["s1", "A"])
        self.assertEqual((r[0]["result"], r[0]["saved"]), (False, []), "1000 sessions: no more")

    def test_a_missing_or_doubled_anchor_costs_only_the_group_command(self):
        stock = GROUP.replace("addSessionTabToGroup", "addSessionToGroup")
        twice = GROUP + GROUP.replace("toggleFocusView", "toggleFocusView2")
        for label, grp in (("no registration", ""), ("renamed command", stock), ("two registrations", twice), ("another provider call", GROUP.replace(".addActiveSessionTabToGroup()", ".addTab()"))):
            raw = build(V327, grp=grp)
            ext = self.make(V327, name="miss%d" % len(os.listdir(self.t)), raw=raw)
            before = snap(ext)
            self.run_script(ext)
            self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "unpatched-patchable 2.1.328"), label)
            self.assertIn("warning: the group command would be left out (groups anchor (", self.out, label)
            self.assertEqual(snap(ext), before, label)
            self.run_script(ext, "--apply")
            self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "patched 2.1.328"), label)
            self.assertIn("warning: the group command is not in (groups anchor (", self.out, label)
            new = self.js(ext)
            self.assertEqual((new.count(b"cbCwd"), new.count(b"callboard assign group")), (6, 0), label)
            marker = json.loads(slurp(os.path.join(ext, "callboard-cwd-patch.json")))
            self.assertEqual((marker["patch"], marker["groups"], marker["width"]), (1, False, True), label)
            self.run_script(ext)
            self.assertIn("warning: the group command is not in this patch", self.out, label)
            self.run_script(ext, "--undo")
            self.assertEqual((self.rc, self.js(ext)), (0, raw), label)

    def test_a_file_that_already_has_the_command_is_left_alone(self):
        raw = build(V327, grp=GROUP + 'x.push(Wp("callboard assign group",()=>1));')
        ext, marker = self.applied(raw, name="have")
        self.assertEqual((self.rc, marker["groups"]), (0, False))
        self.assertEqual(self.js(ext).count(b"callboard assign group"), 1)

    def test_a_patch_from_before_the_command_reads_outdated_and_update_brings_it_in(self):
        mod = load_module()
        ext = self.make(V327, name="old")
        with contextlib.redirect_stdout(io.StringIO()):
            old = load_module()
            old.GROUPS_ANCHOR = rb"(NO)(MATCH)(HERE)"
            old.apply(ext)
        self.assertNotIn(b"callboard assign group", self.js(ext))
        self.assertEqual(json.loads(slurp(os.path.join(ext, "callboard-cwd-patch.json")))["groups"], False)
        self.assertUnchanged(ext)
        self.assertEqual((self.rc, self.out.splitlines()[0]), (1, "outdated 2.1.328: the group command is not in"))
        self.run_script(ext, "--update")
        self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "updated 2.1.328"))
        self.assertEqual(self.js(ext), mod.patched(slurp(os.path.join(ext, "extension.js.callboard-orig")), mod.webview(ext))[0])
        self.assertEqual(json.loads(slurp(os.path.join(ext, "callboard-cwd-patch.json")))["groups"], True)
        self.assertUnchanged(ext)
        self.assertEqual((self.rc, self.out), (0, "patched 2.1.328\n"))

    def test_undo_takes_the_command_out_with_the_rest(self):
        raw = build(V328)
        ext, _ = self.applied(raw, name="undo")
        self.assertIn(b"callboard assign group", self.js(ext))
        self.run_script(ext, "--undo")
        self.assertEqual((self.rc, self.js(ext)), (0, raw))
        self.assertEqual(sorted(os.listdir(ext)), STOCK)

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_a_patched_copy_of_each_installed_claude_extension_still_parses(self):
        """Reads the installed extensions (their original file, or the live one when never patched) and patches copies in the temp folder; the install is not changed."""
        found = []
        for d in sorted(glob.glob(os.path.expanduser("~/.vscode/extensions/anthropic.claude-code-*"))):
            src = os.path.join(d, "extension.js.callboard-orig")
            src = src if os.path.isfile(src) else os.path.join(d, "extension.js")
            if os.path.isfile(src) and os.path.isfile(os.path.join(d, "package.json")):
                found.append((d, src))
        if not found:
            self.skipTest("no installed Claude Code extension")
        for i, (d, src) in enumerate(found):
            ext = os.path.join(self.t, "real%d" % i)
            os.makedirs(ext)
            shutil.copy(src, os.path.join(ext, "extension.js"))
            shutil.copy(os.path.join(d, "package.json"), ext)
            shutil.copytree(os.path.join(d, "webview"), os.path.join(ext, "webview"), ignore=shutil.ignore_patterns("fonts"))
            raw = slurp(os.path.join(ext, "extension.js"))
            self.run_script(ext, "--apply")
            if self.rc != 0:
                continue
            marker = json.loads(slurp(os.path.join(ext, "callboard-cwd-patch.json")))
            self.assertEqual(marker["patch"], 1)
            if marker["groups"]:
                self.assertEqual(self.js(ext).count(b"callboard assign group"), 1, d)
                for member in (b".settings.getSessionGroups()", b".settings.getArchivedSessionIds()", b"persistGroupsFromHost("):
                    self.assertIn(member, raw, "%s: the members the command uses" % d)
            if marker["session"]:
                self.assertIn(b"activePanelSessionId(){", raw, "%s: the member the session command uses" % d)
            p = subprocess.run(["node", "--check", os.path.join(ext, "extension.js")], capture_output=True, text=True, timeout=120)
            self.assertEqual(p.returncode, 0, "%s: %s" % (d, p.stderr))
            self.run_script(ext, "--undo")
            self.assertEqual(self.js(ext), raw)


class Update(Case):
    """An install made by an older script reads outdated; --update rebuilds it from the backup original and never leaves a half patch."""

    def current(self, raw):
        mod = load_module()
        return mod.patched(raw, mod.webview(self.ext))[0]

    def test_an_up_to_date_install_reads_patched_and_update_has_nothing_to_do(self):
        self.run_script(self.ext, "--apply")
        self.assertUnchanged(self.ext)
        self.assertEqual((self.rc, self.out), (0, "patched 2.1.328\n"))
        self.assertUnchanged(self.ext, "--update")
        self.assertEqual((self.rc, self.out), (0, "already patched 2.1.328\n"))

    def test_an_install_made_by_an_older_script_reads_outdated_and_apply_refuses_it(self):
        for name, attrs, why in (
            ("code", dict(WIDTH_CSS='[class*="x_"]{margin:0!important}'), "the patch code differs from this script's"),
            ("width", dict(CSS_ANCHOR=b"<no-such-tag>"), "the panel width is not in"),
        ):
            ext = self.make(V327, name=name)
            self.older(ext, **attrs)
            self.assertUnchanged(ext)
            self.assertEqual((self.rc, self.out.splitlines()[0]), (1, "outdated 2.1.328: " + why), name)
            self.assertIn("--update", self.out)
            self.assertUnchanged(ext, "--apply")
            self.assertEqual(self.rc, 1)
            self.assertIn("run --update", self.err)

    def test_update_brings_it_to_the_current_bytes_and_keeps_the_backup_byte_identical(self):
        orig = self.js()
        self.older(self.ext, WIDTH_CSS="a{b:c}")
        backup = slurp(os.path.join(self.ext, "extension.js.callboard-orig"))
        self.run_script(self.ext, "--update")
        self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "updated 2.1.328"))
        self.assertEqual(self.js(), self.current(orig))
        self.assertEqual(slurp(os.path.join(self.ext, "extension.js.callboard-orig")), backup)
        self.assertEqual(backup, orig)
        marker = json.loads(slurp(os.path.join(self.ext, "callboard-cwd-patch.json")))
        self.assertEqual((marker["width"], marker["original_sha256"], marker["patched_sha256"]),
                         (True, hashlib.sha256(orig).hexdigest(), hashlib.sha256(self.js()).hexdigest()))
        self.assertEqual(sorted(os.listdir(self.ext)), ["callboard-cwd-patch.json", "extension.js", "extension.js.callboard-orig", "package.json", "webview"])
        self.assertUnchanged(self.ext)
        self.assertEqual((self.rc, self.out), (0, "patched 2.1.328\n"))

    def test_an_install_with_the_chip_hiding_block_reads_outdated_and_update_takes_it_out(self):
        orig = self.js()
        self.run_script(self.ext, "--apply")
        chip = b'<style id="callboard-chip">[aria-label="Remote Control"],[aria-label^="Connecting to claude.ai"]{display:none!important}</style>'
        old = self.js().replace(b'<style id="callboard-pie">', chip + b'<style id="callboard-pie">')
        self.assertNotEqual(old, self.js())
        mp = os.path.join(self.ext, "callboard-cwd-patch.json")
        marker = json.loads(slurp(mp))
        marker.update(chip=True, patched_sha256=hashlib.sha256(old).hexdigest())
        for path, data in ((os.path.join(self.ext, "extension.js"), old), (mp, json.dumps(marker).encode())):
            with open(path + ".t", "wb") as f:
                f.write(data)
            os.replace(path + ".t", path)
        self.run_script(self.ext)
        self.assertEqual((self.rc, self.out.splitlines()[0]), (1, "outdated 2.1.328: the patch code differs from this script's"))
        self.run_script(self.ext, "--update")
        self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "updated 2.1.328"))
        self.assertEqual(self.js(), self.current(orig))
        self.assertNotIn(b"callboard-chip", self.js())
        self.assertNotIn(b"Remote Control", self.js())
        self.assertEqual(self.js(), slurp(os.path.join(self.ext, "extension.js")))
        self.assertNotIn("chip", json.loads(slurp(mp)))
        self.assertEqual(slurp(os.path.join(self.ext, "extension.js.callboard-orig")), orig)
        self.assertUnchanged(self.ext)
        self.assertEqual((self.rc, self.out), (0, "patched 2.1.328\n"))

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_the_updated_code_still_runs(self):
        self.older(self.ext, WIDTH_CSS="a{b:c}")
        self.run_script(self.ext, "--update")
        p = subprocess.run(["node", "-e", RUNNER, os.path.join(self.ext, "extension.js")], capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(json.loads(p.stdout)["setup"], ["/b", "/a", "/a"])

    def test_undo_after_an_update_restores_the_original_byte_for_byte(self):
        orig = self.js()
        self.older(self.ext, WIDTH_CSS="a{b:c}")
        self.run_script(self.ext, "--update")
        self.run_script(self.ext, "--undo")
        self.assertEqual((self.rc, self.js()), (0, orig))
        self.assertEqual(sorted(os.listdir(self.ext)), STOCK)

    def test_an_update_this_script_cannot_build_changes_nothing(self):
        orig = self.js()
        self.older(self.ext, WIDTH_CSS="a{b:c}")
        mod = load_module()
        mod.ANCHORS = mod.ANCHORS + (("extra anchor", rb"zzz", lambda m: b""),)
        before = snap(self.ext)
        self.assertEqual(mod.state(self.ext)[::2], ("outdated", "this script no longer fits the backup: extra anchor (no match)"))
        with self.assertRaises(SystemExit) as cm:
            mod.update(self.ext)
        self.assertEqual(cm.exception.code, 1)
        self.assertEqual(snap(self.ext), before)
        self.assertEqual(slurp(os.path.join(self.ext, "extension.js.callboard-orig")), orig)

    def test_check_and_update_agree_when_the_names_collide(self):
        self.older(self.ext, WIDTH_CSS="a{b:c}")
        mod = load_module()
        mod.NAME = "é".encode("utf-8")
        before = snap(self.ext)
        self.assertEqual(mod.state(self.ext)[::2], ("outdated", "this script no longer fits the backup: the file already contains é"))
        with self.assertRaises(SystemExit) as cm:
            mod.update(self.ext)
        self.assertEqual((cm.exception.code, snap(self.ext)), (1, before))

    def test_without_a_matching_backup_the_marker_decides(self):
        self.older(self.ext, WIDTH_CSS="a{b:c}")
        os.unlink(os.path.join(self.ext, "extension.js.callboard-orig"))
        self.assertUnchanged(self.ext)
        self.assertEqual((self.rc, self.out), (0, "patched 2.1.328\n"))

    def test_a_spare_link_left_by_a_killed_update_goes_with_the_next_update_or_undo(self):
        orig = self.js()
        for last in ("--update", "--undo"):
            ext = self.make(V327, name="spare" + last)
            self.older(ext, WIDTH_CSS="a{b:c}")
            os.link(os.path.join(ext, "extension.js.callboard-orig"), os.path.join(ext, "extension.js.callboard-prev"))
            self.run_script(ext, last)
            self.assertEqual(self.rc, 0, last)
            self.assertNotIn("extension.js.callboard-prev", os.listdir(ext), last)
        self.assertEqual(self.js(ext), orig)

    def test_a_failed_write_keeps_the_previous_patch_intact(self):
        for failing in ("extension.js", "callboard-cwd-patch.json"):
            ext = self.make(V327, name="f-" + failing)
            self.older(ext, WIDTH_CSS="a{b:c}")
            before = snap(ext)
            mod = load_module()
            real = mod.put

            def put(path, content, mode, failing=failing, real=real):
                if os.path.basename(path) == failing:
                    raise OSError(28, "No space left on device")
                real(path, content, mode)

            mod.put = put
            with self.assertRaises(SystemExit) as cm:
                mod.update(ext)
            self.assertEqual(cm.exception.code, 1, failing)
            self.assertEqual(snap(ext), before, failing)
            self.run_script(ext)
            self.assertEqual((self.rc, self.out.split(":")[0]), (1, "outdated 2.1.328"), failing)
            self.run_script(ext, "--undo")
            self.assertEqual((self.rc, sorted(os.listdir(ext))), (0, STOCK), failing)


# Runs the patched stand-in's panel serializer and setupPanel under a fake vscode, with a real config folder, and prints the folder each panel was set up in.
RESTORE_RUNNER = r"""
const vm = require('vm'), fs = require('fs'), path = require('path')
const [file, cfg, ...folders] = process.argv.slice(1)
const code = fs.readFileSync(file, 'utf8')
const SB = process.env.SID_B, SA = process.env.SID_A
function boot(list) {
  const fake = { workspace: { workspaceFolders: list.map((f) => ({ name: path.basename(f), uri: { fsPath: f } })) },
    commands: { registerCommand: () => ({}) },
    window: { registerWebviewPanelSerializer: (id, h) => { fake.serializer = h } } }
  const ctx = vm.createContext({ x: [], Wp: () => {}, F: () => ({}), $e: fake, Pe: fake, process: { env: { CLAUDE_CONFIG_DIR: cfg } },
    nL: (f) => f(), sw: (v) => typeof v === 'string', ice: () => true,
    require: (m) => (m === 'vscode' ? fake : require(m)) })
  vm.runInContext(code + ';globalThis.W=W;globalThis.Act=Act', ctx)
  const seen = []
  const c = Object.create(ctx.W.prototype)
  c.panelFullEditor = new Map()
  Object.assign(c, { notePanelRevived() {}, registerPanelSession() {}, restoredTabSetup: (st) => ({ fullEditor: false, openSession: st.openedFor }) })
  const real = ctx.W.prototype.setupPanel
  c.setupPanel = function (...a) { seen.push(real.apply(this, a)) }
  ctx.Act(c)
  return { c, fake, seen, real: (...a) => real.apply(c, a) }
}
const restore = (list, state) => { const b = boot(list); b.fake.serializer.deserializeWebviewPanel({ title: 't' }, state); return b.seen[0] }
const out = {}
out.inB = restore(folders, { sessionID: SB })
out.inA = restore(folders, { sessionID: SA })
out.none = restore(folders, { sessionID: '00000000-0000-4000-8000-000000000000' })
out.opened = restore(folders, { openedFor: SB })
out.noState = restore(folders, undefined)
out.single = restore([folders[1]], { sessionID: SB })
out.bad = restore(folders, { sessionID: 'x/../' + SB })
const b = boot(folders)
out.create = [b.real(1, SB, 3, 4, 5, false, undefined), b.real(1, SB, 3, 4, 5, false, folders[0]), b.real(1, undefined, 3, 4, 5, false, undefined)]
out.method = [b.c.cbFolderOf(SB), b.c.cbFolderOf(7), b.c.cbFolderOf('x'), boot([folders[1]]).c.cbFolderOf(SB)]
console.log(JSON.stringify(out))
"""


class Restore(Case):
    """The restore fix is one optional group of three edits: a restored or reopened panel finds the window folder that holds its session's transcript."""

    SID_A = "11111111-1111-4111-8111-111111111111"
    SID_B = "22222222-2222-4222-8222-222222222222"

    def applied(self, raw=None, name="restore"):
        ext = self.make(V327, name=name, raw=raw if raw is not None else build(V327))
        self.run_script(ext, "--apply")
        return ext, json.loads(slurp(os.path.join(ext, "callboard-cwd-patch.json")))

    def test_the_three_edits_go_in_once_and_the_marker_says_so(self):
        ext, marker = self.applied()
        self.assertEqual((self.rc, marker["restore"], marker["width"]), (0, True, True))
        self.assertEqual(self.out.count("warning"), 0)
        new = self.js(ext)
        self.assertEqual(new.count(b"cbFolderOf(cbrS){"), 1)
        self.assertEqual(new.count(b"cbCwd??=this.cbFolderOf(t);"), 1)
        self.assertEqual(new.count(b",void 0,!1,c.cbFolderOf(R));"), 1)
        self.assertLess(new.index(b"let R=typeof C?.sessionID"), new.index(b"c.setupPanel(w,x,void 0,k,void 0,!1"))
        self.assertIn(b"}cbFolderOf(cbrS){", new)
        self.assertIn(b"}setupPanel(e,t,n,r,o,s=!1,cbCwd){cbCwd??=this.cbFolderOf(t);this.panelFullEditor.set", new)

    def test_other_minified_names_still_match(self):
        raw = build(V328).replace(b"nL(", b"qZ(").replace(b"(c)", b"(Q9)").replace(b"c.notePanelRevived", b"Q9.notePanelRevived").replace(b"c.restoredTabSetup", b"Q9.restoredTabSetup")
        raw = raw.replace(b"c.setupPanel(w,x,void 0,k)", b"Q9.setupPanel(w,x,void 0,k)").replace(b"let C=T", b"let Z=T").replace(b"C?.sessionID", b"Z?.sessionID").replace(b"C.sessionID", b"Z.sessionID")
        raw = raw.replace(b"C??{}", b"Z??{}").replace(b"C?.sessionUpdatedAt", b"Z?.sessionUpdatedAt").replace(b"c.registerPanelSession", b"Q9.registerPanelSession").replace(b"let R=", b"let Y=").replace(b":x;if(sw(R)&&ice(R,", b":x;if(sw(Y)&&ice(Y,").replace(b"registerPanelSession(R,w)", b"registerPanelSession(Y,w)")
        ext, marker = self.applied(raw, name="names")
        self.assertEqual((self.rc, marker["restore"]), (0, True))
        self.assertIn(b"Q9.setupPanel(w,x,void 0,k,void 0,!1,Q9.cbFolderOf(Y));", self.js(ext))

    def test_a_missing_restore_anchor_costs_only_the_restore_fix(self):
        raw = build(V327)
        misses = {
            "no serializer": raw.replace(b"c.setupPanel(w,x,void 0,k);", b"c.setupPanel(w,x,void 0,k,1);"),
            "id read differently": raw.replace(b'typeof C?.sessionID==="string"', b'C?.sessionID!==void 0'),
            "two serializers": raw + raw[raw.index(b"function Act"):raw.index(b'x.push(Wp("claude-vscode.editor.open"')].replace(b"Act", b"Act2"),
        }
        for label, bad in misses.items():
            ext = self.make(V327, name="m%d" % len(os.listdir(self.t)), raw=bad)
            before = snap(ext)
            self.run_script(ext)
            self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "unpatched-patchable 2.1.328"), label)
            self.assertIn("warning: the restore fix would be left out (restore anchor ", self.out, label)
            self.assertEqual(snap(ext), before, label)
            self.run_script(ext, "--apply")
            self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "patched 2.1.328"), label)
            self.assertIn("warning: the restore fix is not in (restore anchor ", self.out, label)
            new = self.js(ext)
            self.assertNotIn(b"cbFolderOf", new, label)
            self.assertEqual(new.count(b"cbCwd"), 5, label)
            self.assertIn(b"callboard-width", new, label)
            marker = json.loads(slurp(os.path.join(ext, "callboard-cwd-patch.json")))
            self.assertEqual((marker["restore"], marker["width"]), (False, True), label)
            self.run_script(ext)
            self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "patched 2.1.328"), label)
            self.assertIn("warning: the restore fix is not in this patch.", self.out, label)
            self.run_script(ext, "--undo")
            self.assertEqual((self.rc, self.js(ext)), (0, bad), label)
            self.assertEqual(sorted(os.listdir(ext)), STOCK, label)

    def test_a_file_that_already_has_the_method_is_left_alone(self):
        raw = build(V327).replace(b"class W{", b"class W{cbFolderOf(){}")
        ext, marker = self.applied(raw, name="have")
        self.assertEqual((self.rc, marker["restore"]), (0, False))
        self.assertEqual(self.js(ext).count(b"cbFolderOf("), 1)
        self.assertIn("the file already contains cbFolderOf", self.out)

    def test_undo_takes_the_restore_fix_out_with_the_rest(self):
        raw = build(V327)
        ext, _ = self.applied(raw, name="undo")
        self.run_script(ext, "--undo")
        self.assertEqual((self.rc, self.js(ext)), (0, raw))
        self.assertEqual(sorted(os.listdir(ext)), STOCK)

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_a_restored_or_reopened_panel_starts_in_the_folder_of_its_transcript(self):
        ext, _ = self.applied(name="run")
        fa, fb = os.path.join(self.t, "repo-a"), os.path.join(self.t, "repo b.x")
        cfg = os.path.join(self.t, "cfg")
        for folder, sid in ((fa, self.SID_A), (fb, self.SID_B)):
            os.makedirs(folder)
            d = os.path.join(cfg, "projects", "".join(c if c.isalnum() and c.isascii() else "-" for c in folder))
            os.makedirs(d)
            open(os.path.join(d, sid + ".jsonl"), "w").close()
        env = dict(os.environ, SID_A=self.SID_A, SID_B=self.SID_B)
        p = subprocess.run(["node", "-e", RESTORE_RUNNER, os.path.join(ext, "extension.js"), cfg, fa, fb], capture_output=True, text=True, timeout=60, env=env)
        self.assertEqual(p.returncode, 0, p.stderr)
        got = json.loads(p.stdout)
        self.assertEqual((got["inB"], got["inA"]), (fb, fa))
        self.assertEqual((got["none"], got["noState"], got["bad"]), (fa, fa, fa))
        self.assertEqual(got["opened"], fb)
        self.assertEqual(got["single"], fb)
        self.assertEqual(got["create"], [fb, fa, fa])
        self.assertEqual(got["method"], [fb, None, None, None])

    def test_an_install_made_by_an_older_script_reads_outdated_and_update_brings_the_restore_fix_in(self):
        mod = load_module()
        ext = self.make(V327, name="older")
        with contextlib.redirect_stdout(io.StringIO()):
            mod.PIECES = mod.PIECES[:2]
            mod.apply(ext)
        orig = self.js(ext)
        self.assertNotIn("restore", json.loads(slurp(os.path.join(ext, "callboard-cwd-patch.json"))))
        self.assertNotIn(b"cbFolderOf", orig)
        self.assertUnchanged(ext)
        self.assertEqual((self.rc, self.out.splitlines()[0]), (1, "outdated 2.1.328: the restore fix is not in"))
        self.run_script(ext, "--update")
        self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "updated 2.1.328"))
        self.assertEqual(self.js(ext).count(b"cbFolderOf(cbrS)"), 1)
        self.assertTrue(json.loads(slurp(os.path.join(ext, "callboard-cwd-patch.json")))["restore"])
        self.run_script(ext)
        self.assertEqual((self.rc, self.out), (0, "patched 2.1.328\n"))
        self.run_script(ext, "--undo")
        self.assertEqual(self.js(ext), build(V327))

    def test_a_restore_fix_that_cannot_go_in_does_not_make_an_up_to_date_install_outdated(self):
        raw = build(V327).replace(b"c.setupPanel(w,x,void 0,k);", b"c.setupPanel(w,x,void 0,k,1);")
        ext, marker = self.applied(raw, name="stay")
        self.assertFalse(marker["restore"])
        self.run_script(ext)
        self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "patched 2.1.328"))


# Runs the patched stand-in of the webview script under fakes: the composer's pie component, the ring and the bar that passes the window, with the level the
# page carries as a CSS variable.
WEB_RUNNER = r"""
const vm = require('vm'), fs = require('fs')
const [file, level, sv, pc] = process.argv.slice(1)
const m = (t, p) => ({ t, p }), k = (t, p) => ({ t, p })
const stock = (w, o) => w - Math.min(o, 20000) - 13000
const ctx = vm.createContext({ m, k, FBn: 'FBn', BFt: 'BFt', ia: { usageButtonV2: 'u' }, a: 'compact', PBn: () => 50, DBn: { 50: 'd' }, NFt: stock, tFt: stock,
  getComputedStyle: () => ({ getPropertyValue: (n) => (n === '--callboard-compact' ? level : '') }), document: { documentElement: {} } })
vm.runInContext(fs.readFileSync(file, 'utf8') + ';globalThis.F = { sv: ' + sv + ', pc: ' + pc + ', Bar }', ctx)
const props = (used, w, o = 20000) => ctx.F.Bar({ usageData: { value: { totalTokens: used, contextWindow: w, maxOutputTokens: o } } }).p.children[1].p
const used = (u, w) => { const r = ctx.F.pc(props(u, w)); return r && r.p.percentageUsed }
const ring = (x) => ctx.F.sv({ percentage: x, className: 'c' }).p.children.map((c) => c && { r: c.p.r, d: c.p.strokeDasharray, s: c.p.stroke })
console.log(JSON.stringify({ window: [props(1, 1000000).contextWindow, props(1, 400000).contextWindow, props(1, 1000000, 8000).contextWindow], used: [used(1000, 1000000), used(233500, 1000000), used(900000, 1000000)],
  ring: [ring(0), ring(50), ring(150), ring(NaN), ring(undefined)] }))
"""
CIRC = 2 * 3.141592653589793 * 7.25
# What an older script that had no pie amounts to: anchors that match nothing, so the piece is left out.
NO_PIE = (("pie component", rb"no such code", lambda m: b""),)


class Pie(Case):
    """The context pie: one optional piece that edits webview/index.js (kept as webview/index.js.callboard-orig) and puts the autocompact level into the page."""

    WEBJS = os.path.join("webview", "index.js")
    BAK = os.path.join("webview", "index.js.callboard-orig")

    def marker(self, ext):
        return json.loads(slurp(os.path.join(ext, "callboard-cwd-patch.json")))

    def shown(self, ext, level, names=JS329):
        p = subprocess.run(["node", "-e", WEB_RUNNER, os.path.join(ext, self.WEBJS), level, names["sv"], names["pc"]], capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)

    def test_the_patch_edits_the_three_places_once_keeps_the_shipped_script_and_undo_puts_it_back(self):
        for names in (JS329, JS328):
            web = dict(WEB, **{"index.js": PIE_JS.format(**names)})
            ext = self.make(V327, name="pie" + names["pc"], web=web)
            orig = slurp(os.path.join(ext, self.WEBJS))
            self.run_script(ext, "--apply")
            self.assertEqual((self.rc, self.out.count("warning")), (0, 0), self.out)
            new, marker = slurp(os.path.join(ext, self.WEBJS)), self.marker(ext)
            self.assertEqual(slurp(os.path.join(ext, self.BAK)), orig)
            self.assertEqual((marker["pie"], marker["web_original_sha256"], marker["web_patched_sha256"]), (True, hashlib.sha256(orig).hexdigest(), hashlib.sha256(new).hexdigest()))
            self.assertEqual((new.count(b"cbpCap("), new.count(b"cbpN;"), new.count(b"<circle"), new.count(b'"circle"')), (2, 1, 0, 2))
            self.assertNotIn(b"if(r>=50)return null", new)
            self.assertNotIn(b'"path"', new)
            self.assertEqual(sorted(os.listdir(ext)), sorted(STOCK + ["callboard-cwd-patch.json", "extension.js.callboard-orig"]))
            self.run_script(ext)
            self.assertEqual((self.rc, self.out), (0, "patched 2.1.328\n"))
            self.run_script(ext, "--undo")
            self.assertEqual((self.rc, slurp(os.path.join(ext, self.WEBJS))), (0, orig))
            self.assertEqual((sorted(os.listdir(ext)), sorted(os.listdir(os.path.join(ext, "webview")))), (STOCK, ["index.css", "index.js"]))

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_the_pie_always_shows_against_the_level_and_the_ring_is_continuous(self):
        for names in (JS329, JS328):
            web = dict(WEB, **{"index.js": PIE_JS.format(**names)})
            ext = self.make(V327, name="run" + names["pc"], web=web)
            self.run_script(ext, "--apply")
            got = self.shown(ext, " 500000", names)
            self.assertEqual(got["window"], [467000, 367000, 467000 + 12000], "the level caps the window; a smaller window stays; the output limit still counts")
            self.assertEqual(got["used"], [1000 / 467000 * 100, 50, 100], "shown from the first token, against the level, never past full")
            track, ring = got["ring"][1]
            self.assertEqual((track["r"], ring["r"], track.get("d")), ("7.25", "7.25", None))
            self.assertAlmostEqual(float(ring["d"].split()[0]), CIRC / 2, places=6)
            self.assertEqual(got["ring"][0][1], False, "no arc at zero")
            self.assertAlmostEqual(float(got["ring"][2][1]["d"].split()[0]), CIRC, places=6)
            self.assertEqual(got["ring"][3][1], False)
            self.assertEqual(got["ring"][4][1], False)
            for none in ("", " 0", " garbage", " -5"):
                self.assertEqual(self.shown(ext, none, names)["window"][0], 967000, "no usable level: the stock window")
            self.assertEqual(self.shown(ext, " 5000000", names)["window"][0], 967000, "a level above the window changes nothing")

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_the_page_carries_the_level_from_the_settings_of_the_config_folder(self):
        ext, _ = Css.applied(self, build(V327), name="page")
        cfg = os.path.join(self.t, "cfg")
        os.makedirs(cfg)
        script = PAGE.replace("require: () => ({})", "require, process: { env: { CLAUDE_CONFIG_DIR: process.argv[2] } }")
        for text, want in (('{"autoCompactWindow": 500000}', 500000), ('{"autoCompactWindow": "500000"}', 0), ('{"autoCompactWindow": -1}', 0), ('{"autoCompactWindow": 1.5}', 0), ("{}", 0), ("[", 0), (None, 0)):
            if text is None:
                os.path.exists(os.path.join(cfg, "settings.json")) and os.unlink(os.path.join(cfg, "settings.json"))
            else:
                with open(os.path.join(cfg, "settings.json"), "w") as f:
                    f.write(text)
            p = subprocess.run(["node", "-e", script, os.path.join(ext, "extension.js"), cfg], capture_output=True, text=True, timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertIn(":root{--callboard-compact:%d}" % want, json.loads(p.stdout), text)

    def test_an_anchor_that_misses_or_doubles_costs_only_the_pie(self):
        mod = load_module()
        js = WEB["index.js"]
        cases = {
            "threshold": js.replace("e.usageData.value.contextWindow,e.usageData", "e.usageData.value.window,e.usageData", 1),
            "pie component": js.replace("if(r>=50)return null;", "", 1),
            "drawing": js.replace('strokeOpacity:"0.15"', 'strokeOpacity:"0.2"', 1),
            "doubled": js + js[js.index("function nBt"):js.index("function Bar")],
        }
        for label, bad in cases.items():
            ext = self.make(V327, name="miss" + label.replace(" ", ""), web=dict(WEB, **{"index.js": bad}))
            before = snap(ext)
            self.run_script(ext)
            self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "unpatched-patchable 2.1.328"), label)
            self.assertIn("warning: the context pie would be left out (pie anchor ", self.out, label)
            self.assertEqual(snap(ext), before, label)
            self.run_script(ext, "--apply")
            self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "patched 2.1.328"), label)
            self.assertIn("warning: the context pie is not in (pie anchor ", self.out, label)
            self.assertEqual(slurp(os.path.join(ext, self.WEBJS)), bad.encode(), label)
            self.assertFalse(os.path.exists(os.path.join(ext, self.BAK)), label)
            marker = self.marker(ext)
            self.assertEqual((marker["pie"], marker["width"], marker["restore"], "web_patched_sha256" in marker), (False, True, True, False), label)
            self.assertNotIn(b"callboard-pie", self.js(ext), label)
            self.run_script(ext)
            self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "patched 2.1.328"), label)
            self.assertIn("warning: the context pie is not in this patch.", self.out, label)
            self.run_script(ext, "--undo")
            self.assertEqual((self.rc, sorted(os.listdir(ext))), (0, STOCK), label)
        self.assertEqual(len(mod.PIE_ANCHORS), 3)

    def test_the_pie_is_left_out_whole_when_the_page_builder_cannot_take_its_block(self):
        raw = build(V327, "")
        ext = self.make(V327, name="nofont", raw=raw)
        self.run_script(ext, "--apply")
        self.assertIn("the context pie is not in (font tag anchor (", self.out)
        self.assertEqual(slurp(os.path.join(ext, self.WEBJS)), WEB["index.js"].encode())
        self.assertFalse(os.path.exists(os.path.join(ext, self.BAK)))

    def test_an_install_from_before_the_pie_reads_outdated_and_update_brings_it_in(self):
        mod = load_module()
        ext = self.make(V327, name="old")
        orig_js = slurp(os.path.join(ext, self.WEBJS))
        self.older(ext, PIE_ANCHORS=NO_PIE)
        self.assertEqual(slurp(os.path.join(ext, self.WEBJS)), orig_js)
        self.run_script(ext)
        self.assertEqual((self.rc, self.out.splitlines()[0]), (1, "outdated 2.1.328: the context pie is not in"))
        self.run_script(ext, "--update")
        self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "updated 2.1.328"))
        self.assertEqual((slurp(os.path.join(ext, self.BAK)), self.marker(ext)["pie"]), (orig_js, True))
        self.assertNotEqual(slurp(os.path.join(ext, self.WEBJS)), orig_js)
        self.run_script(ext)
        self.assertEqual((self.rc, self.out), (0, "patched 2.1.328\n"))
        self.run_script(ext, "--update")
        self.assertEqual(self.out, "already patched 2.1.328\n")
        self.run_script(ext, "--undo")
        self.assertEqual((slurp(os.path.join(ext, self.WEBJS)), sorted(os.listdir(os.path.join(ext, "webview")))), (orig_js, ["index.css", "index.js"]))

    def test_update_follows_the_pie_out_when_the_script_can_no_longer_build_it(self):
        mod = load_module()
        ext = self.make(V327, name="out")
        orig_js = slurp(os.path.join(ext, self.WEBJS))
        self.run_script(ext, "--apply")
        mod.PIE_ANCHORS = NO_PIE
        self.assertEqual(mod.state(ext)[:2], ("outdated", "2.1.328"))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(mod.update(ext), 0)
        self.assertEqual(slurp(os.path.join(ext, self.WEBJS)), orig_js)
        self.assertEqual((self.marker(ext)["pie"], "web_patched_sha256" in self.marker(ext), os.path.exists(os.path.join(ext, self.BAK))), (False, False, False))
        self.assertEqual(mod.state(ext)[0], "patched")

    def test_a_failed_update_puts_the_webview_script_back_too(self):
        mod = load_module()
        for failing in ("index.js", "extension.js", "callboard-cwd-patch.json"):
            ext = self.make(V327, name="uf-" + failing)
            self.older(ext, PIE_ANCHORS=NO_PIE)
            before = snap(ext)
            mod = load_module()
            real = mod.put

            def put(path, content, mode, failing=failing, real=real):
                if os.path.basename(path) == failing:
                    raise OSError(28, "No space left on device")
                real(path, content, mode)

            mod.put = put
            with self.assertRaises(SystemExit) as cm:
                mod.update(ext)
            self.assertEqual(cm.exception.code, 1, failing)
            self.assertEqual(snap(ext), before, failing)

    def test_an_update_that_died_after_the_pie_went_in_leaves_leftovers_that_undo_clears(self):
        for name, pie_in in (("linked", False), ("piein", True)):
            ext = self.make(V327, name="die-" + name)
            orig_main, orig_js = self.js(ext), slurp(os.path.join(ext, self.WEBJS))
            self.older(ext, PIE_ANCHORS=NO_PIE)
            mod = load_module()
            if pie_in:
                mod.set_web(ext, orig_js, mod.pie_web(orig_js))
                self.assertNotEqual(slurp(os.path.join(ext, self.WEBJS)), orig_js)
            else:
                os.link(os.path.join(ext, self.WEBJS), os.path.join(ext, self.BAK))
            self.assertEqual(self.marker(ext).get("web_original_sha256"), None)
            self.run_script(ext)
            self.assertEqual((self.rc, self.out.splitlines()[0].split(":")[0]), (1, "leftovers 2.1.328"), name)
            for flag in ("--apply", "--update"):
                self.assertUnchanged(ext, flag)
                self.assertEqual(self.rc, 1, name)
                self.assertIn("run --undo first", self.err, name)
            self.run_script(ext, "--undo")
            self.assertEqual((self.rc, self.js(ext), slurp(os.path.join(ext, self.WEBJS)), sorted(os.listdir(ext))), (0, orig_main, orig_js, STOCK), name)
            self.assertEqual(sorted(os.listdir(os.path.join(ext, "webview"))), ["index.css", "index.js"], name)

    def test_a_failed_update_that_takes_the_pie_out_puts_it_back(self):
        ext = self.make(V327, name="out-fail")
        self.run_script(ext, "--apply")
        before = snap(ext)
        mod = load_module()
        mod.PIE_ANCHORS = NO_PIE
        real = mod.put

        def put(path, content, mode):
            if os.path.basename(path) == "extension.js":
                raise OSError(28, "No space left on device")
            real(path, content, mode)

        mod.put = put
        with self.assertRaises(SystemExit) as cm:
            mod.update(ext)
        self.assertEqual((cm.exception.code, snap(ext)), (1, before))

    def test_undo_still_refuses_an_unrecorded_webview_backup_when_the_script_is_neither_it_nor_the_pie_of_it(self):
        ext = self.make(V327, name="die-odd")
        self.older(ext, PIE_ANCHORS=NO_PIE)
        os.link(os.path.join(ext, self.WEBJS), os.path.join(ext, self.BAK))
        os.unlink(os.path.join(ext, self.WEBJS))
        with open(os.path.join(ext, self.WEBJS), "w") as f:
            f.write("something else")
        self.assertUnchanged(ext, "--undo")
        self.assertEqual(self.rc, 1)
        self.assertIn("index.js.callboard-orig does not match the marker's recorded original", self.err)

    def test_an_update_whose_writes_and_webview_rollback_all_fail_still_puts_both_files_back(self):
        ext = self.make(V327, name="rb")
        self.older(ext, PIE_ANCHORS=NO_PIE)
        before = snap(ext)
        mod = load_module()
        real, puts = mod.put, []

        def put(path, content, mode):
            if os.path.basename(path) == "index.js" and not puts:
                puts.append(path)
                return real(path, content, mode)
            if os.path.basename(path) in ("index.js", "extension.js"):
                raise OSError(28, "No space left on device")
            real(path, content, mode)

        mod.put = put
        with self.assertRaises(SystemExit) as cm:
            mod.update(ext)
        self.assertEqual((cm.exception.code, len(puts), snap(ext)), (1, 1, before))

    def test_a_webview_script_that_is_not_the_one_patched_reads_as_leftovers_and_undo_recovers(self):
        ext = self.make(V327, name="lo")
        orig_js = slurp(os.path.join(ext, self.WEBJS))
        self.run_script(ext, "--apply")
        with open(os.path.join(ext, self.WEBJS), "w") as f:
            f.write("something else")
        self.run_script(ext)
        self.assertEqual((self.rc, self.out.splitlines()[0]), (1, "leftovers 2.1.328: callboard-cwd-patch.json, extension.js.callboard-orig, webview/index.js.callboard-orig"))
        self.assertUnchanged(ext, "--apply")
        self.assertEqual(self.rc, 1)
        self.run_script(ext, "--undo")
        self.assertEqual((self.rc, slurp(os.path.join(ext, self.WEBJS)), sorted(os.listdir(ext))), (0, orig_js, STOCK))

    def test_undo_refuses_when_the_webview_backup_is_gone_and_leaves_both_files_alone(self):
        ext = self.make(V327, name="gone")
        self.run_script(ext, "--apply")
        os.unlink(os.path.join(ext, self.BAK))
        self.assertUnchanged(ext, "--undo")
        self.assertEqual(self.rc, 1)
        self.assertIn("the backup of webview/index.js is gone", self.err)

    def test_a_corrupt_webview_backup_reads_outdated_and_update_refuses_it(self):
        ext = self.make(V327, name="corrupt")
        self.run_script(ext, "--apply")
        with open(os.path.join(ext, self.BAK), "w") as f:
            f.write("truncated")
        self.run_script(ext)
        self.assertEqual((self.rc, self.out.splitlines()[0]), (1, "outdated 2.1.328: webview/index.js.callboard-orig does not match the marker's recorded original"))
        self.assertUnchanged(ext, "--update")
        self.assertEqual(self.rc, 1)
        self.assertIn("nothing was changed", self.err)

    def test_a_linked_webview_folder_leaves_the_pie_out(self):
        ext = self.make(V327, name="lw")
        shutil.move(os.path.join(ext, "webview"), os.path.join(self.t, "real-webview"))
        os.symlink(os.path.join(self.t, "real-webview"), os.path.join(ext, "webview"))
        self.run_script(ext, "--apply")
        self.assertEqual(self.rc, 0)
        self.assertIn("the context pie is not in (", self.out)
        self.assertEqual(slurp(os.path.join(self.t, "real-webview", "index.js")), WEB["index.js"].encode())

    def test_undo_refuses_a_webview_backup_that_is_not_the_recorded_original(self):
        ext = self.make(V327, name="bad")
        self.run_script(ext, "--apply")
        with open(os.path.join(ext, self.BAK), "w") as f:
            f.write("not the original")
        self.assertUnchanged(ext, "--undo")
        self.assertEqual(self.rc, 1)
        self.assertIn("index.js.callboard-orig does not match the marker's recorded original", self.err)


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
