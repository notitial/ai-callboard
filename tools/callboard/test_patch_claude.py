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
import re
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
    'class P{{async processRequest({rq},t){{switch({rq}.request.type){{case"get_asset_uris":return 1;case"open_url":return await this.openURL({rq}.request.url),{{type:"open_url_response"}};case"x":return 2}}}}}}'
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
V327 = dict(nc="nC", vs="$e", a="w", b="A", c="C", d="T", e="R", f="x", pv="G", rq="e")
V328 = dict(nc="$v", vs="Pe", a="w", b="T", c="C", d="A", e="k", f="z", pv="Gq", rq="$n")
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


def mod_pill(js):
    """The stand-in webview script with only the pill put in, as the script builds it."""
    return load_module().pill_web(js.encode())


def load_module():
    spec = importlib.util.spec_from_file_location("patch_claude", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# The pie's and the pill's code in the shipped webview script, in the shape of the stock composer footer (ring, pie component, the bar that passes the window, and the
# footer's model pill and list); the names are minified and differ by version (sv: the ring, pc: the pie component, tf: the threshold function, st: the fit stage,
# mp: the model pill).
PIE_JS = (
    'function {sv}({{percentage:e,className:t}}){{let n=PBn(e),i=e/100,[o,r]=e<50?[Gap(0,i),Gap(i+Gt,1-Gt)]:[Arc[n],Cap[n]];return k("svg",{{width:"20",height:"20",viewBox:"0 0 20 20",fill:"none",'
    'xmlns:"http://www.w3.org/2000/svg",className:t,style:{{display:"block"}},children:[r&&m("path",{{d:r,stroke:"currentColor",strokeOpacity:"0.15",strokeWidth:"1.5",'
    'strokeLinecap:"round"}}),m("path",{{d:o,stroke:"var(--app-claude-clay-button-orange)",strokeWidth:"1.5",strokeLinecap:"round"}})]}})}}'
    'function {pc}({{usedTokens:e,contextWindow:t,threshold:n,onCompact:i,buttonClassName:o}}){{let r=t>0?Math.min(e/t*100,100):0;if(t===0||r<=n)return null;'
    'return m({fb},{{percentageUsed:r,onCompact:i,buttonClassName:o}})}}'
    'function {fb}({{percentageUsed:e,onCompact:t,buttonClassName:n}}){{let[i,o]=B(!1),r=100-e;return k("div",{{className:lv.host,children:[m("button",{{type:"button",className:`${{TAe.usage}} ${{n??""}}`,"aria-label":`${{Math.round(e)}}% context used — click to compact`,'
    'onClick:t,onMouseEnter:()=>o(!0),onMouseLeave:()=>o(!1),children:m({sv},{{percentage:e,className:TAe.pie}})}}),i&&m(VA,{{text:`${{Math.round(r)}}% of context remaining until auto-compact.`,hint:"Click to compact now."}})]}})}}'
    'function Bar(e,t){{return k("div",{{children:[m("button",{{}}),m({pc},{{usedTokens:e.usageData.value.totalTokens,'
    'contextWindow:{tf}(e.usageData.value.contextWindow,e.usageData.value.maxOutputTokens),threshold:t,onCompact:a,buttonClassName:ia.usageButtonV2}}),m(BFt,{{session:e}})]}})}}'
    'function Foot(e){{let Ft={{}},p={{isOpen:!1,onClose:0}},f=e.cwd.value,{st}=e.stage;return k("div",{{children:[m(BFt,{{session:e}}),{st}!==2&&m({mp},{{...Ft}}),'
    'm($Ft,{{isOpen:p.isOpen,onClose:p.onClose,availableModels:e.drawnClaudeConfig.value?.models,anchor:f}})]}})}}'
    'class Conn{{sendRequest(e,t){{return 1}}}}function Ask(e){{return e.getConnection().then((c)=>c.sendRequest(1))}}'
)
JS330 = dict(sv="$Bt", pc="jBt", tf="_Bt", fb="jzn", st="_", mp="fAe")
JSB = dict(sv="SFt", pc="kFt", tf="tFt", fb="dBn", st="U$", mp="Rr")
# A pie component whose threshold is fixed at 50 and not passed as a prop; the pie anchors must not match it.
PIE_JS_FIXED = PIE_JS.replace(
    "threshold:n,onCompact:i,buttonClassName:o}}){{let r=t>0?Math.min(e/t*100,100):0;if(t===0||r<=n)return null;",
    "onCompact:i,buttonClassName:o}}){{let r=t>0?Math.min(e/t*100,100):0;if(t===0)return null;if(r>=50)return null;",
).replace(",threshold:t,onCompact:a", ",onCompact:a")
# A stand-in for the shipped webview, carrying the tokens the width piece checks and the pie's code, and what a stock extension folder then holds.
WEB = {"index.css": ".inputWrapper_a1,.permissionsContainer_b2,.inputContainer_c3{max-width:680px}", "index.js": PIE_JS.format(**JS330)}
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
            self.assertEqual(slurp(os.path.join(ext, "webview", "index.js")), mod_pill(WEB["index.js"]), "only the pill, which needs no page block: " + label)
            self.assertEqual(slurp(os.path.join(ext, "webview", "index.js.callboard-orig")), WEB["index.js"].encode(), label)
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
async function run(groups, sid, name, order) {
  const H = {}, saved = []
  const provider = { settings: { getSessionGroups: () => groups, getArchivedSessionIds: () => start.archived || [] }, persistGroupsFromHost: (g) => saved.push(g), addActiveSessionTabToGroup: async () => true, activePanelSessionId: () => 'sid-front' }
  const fake = { workspace: {}, window: {}, commands: { registerCommand: (id, fn) => { H[id] = fn; return {} } } }
  const ctx = vm.createContext({ x: [], Wp: () => {}, F: () => ({}), G: provider, Gq: provider, $e: fake, Pe: fake, require: (m) => (m === 'crypto' ? { randomUUID: () => 'new-id' } : fake) })
  vm.runInContext(code, ctx)
  const result = await H['callboard file session'](sid, name, order)
  return { result, saved, front: H['callboard active session'](), stock: typeof H['claude-vscode.addSessionTabToGroup'], other: typeof H['claude-vscode.toggleFocusView'] }
}
;(async () => {
  const out = []
  for (const [sid, name, order] of start.calls) out.push(await run(JSON.parse(JSON.stringify(start.groups)), sid, name, order))
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
            self.assertEqual((new.count(b"callboard file session"), new.count(b"callboard active session")), (1, 1))
            self.assertEqual(new.count(b"cbCwd"), 6)

    def test_the_command_goes_in_front_of_the_stock_one_inside_its_push_call(self):
        ext, _ = self.applied(build(V328), name="front")
        new = self.js(ext).decode("utf-8")
        i, j = new.index("Pe.commands.registerCommand(\"callboard file session\""), new.index("Pe.commands.registerCommand(\"claude-vscode.addSessionTabToGroup\"")
        self.assertLess(i, j)
        self.assertEqual(new[i:j].count("registerCommand"), 2, "the group command, then the session command")
        self.assertTrue(new[:i].endswith("x.push("))
        self.assertTrue(new[i:j].endswith('Pe.commands.registerCommand("callboard active session",()=>Gq.activePanelSessionId()),'))

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_the_command_files_a_session_by_name_creates_a_missing_group_and_moves_a_grouped_session(self):
        for variant in (V327, V328):
            ext = self.make(variant, name="run%s" % variant["pv"])
            self.run_script(ext, "--apply")
            r = self.drive(ext, [G1, G2], ["s1", "Lanes"], ["s2", "Conductor"], ["s0", "Lead"], ["s9", "lead"], [5, "Lead"], ["s3", ""], ["s1", "lead"])
            joined = lambda g, sid: {**g, "sessionIds": g["sessionIds"] + [sid]}
            self.assertEqual(r[0]["saved"], [[joined(G1, "s1"), G2]], "a name in another letter case finds the group")
            self.assertEqual(r[1]["saved"], [[G1, G2, {"id": "new-id", "name": "Conductor", "collapsed": False, "sessionIds": ["s2"]}]], "a missing group is created")
            self.assertEqual(r[2]["saved"], [[{**G1, "sessionIds": []}, joined(G2, "s0")]], "a session in another group moves, and the emptied group stays")
            self.assertEqual((r[3]["result"], r[3]["saved"]), (True, []), "a session already in the group changes nothing")
            self.assertEqual([(x["result"], x["saved"]) for x in r[4:6]], [(False, []), (False, [])], "bad arguments do nothing")
            self.assertEqual(r[6]["saved"], [[G1, joined(G2, "s1")]])
            self.assertEqual([x["result"] for x in (r[0], r[1], r[2], r[6])], [True, True, True, True])
            self.assertEqual((r[0]["stock"], r[0]["other"]), ("function", "function"), "the stock commands are still registered")
            self.assertEqual(r[0]["front"], "sid-front", "the session command returns the provider's panel in front")

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_the_order_puts_the_named_groups_first_in_its_order_and_the_others_after_in_theirs(self):
        ext = self.make(V328, name="order")
        self.run_script(ext, "--apply")
        order = ["Manager", "Conductor", "Lead", "Lanes"]
        mine = {"id": "g3", "name": "Mine", "collapsed": False, "sessionIds": ["m1"]}
        other = {"id": "g4", "name": "Other", "collapsed": False, "sessionIds": []}
        r = self.drive(ext, [mine, G1, other, G2], ["s5", "Manager", order], ["s0", "lead", order], ["s1", "Mine", order], ["s9", "Lead", order])
        manager = {"id": "new-id", "name": "Manager", "collapsed": False, "sessionIds": ["s5"]}
        self.assertEqual(r[0]["saved"], [[manager, G2, G1, mine, other]], "a new group takes its tier's place; a Lanes-above-Lead list is sorted too")
        self.assertEqual(r[1]["saved"], [[{**G2, "sessionIds": ["s9", "s0"]}, {**G1, "sessionIds": []}, mine, other]], "a move sorts as it saves")
        self.assertEqual(r[2]["saved"], [[G2, G1, {**mine, "sessionIds": ["m1", "s1"]}, other]], "a group outside the order takes a session and stays after")
        self.assertEqual((r[3]["result"], r[3]["saved"]), (True, [[G2, G1, mine, other]]), "nothing to move: the list is still sorted")
        r = self.drive(ext, [G2, G1, mine], ["s9", "lead", order], ["s0", "Lanes", order])
        self.assertEqual([(x["result"], x["saved"]) for x in r], [(True, []), (True, [])], "a list already so is not saved")

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
        crowded = [{"id": "g1", "name": "A", "collapsed": False, "sessionIds": ["x%d" % i for i in range(999)]}, G2]
        r = self.drive(ext, crowded, ["s1", "A"], ["x0", "Lead"])
        self.assertEqual((r[0]["result"], r[0]["saved"]), (False, []), "1000 sessions: no more")
        self.assertEqual((r[1]["result"], r[1]["saved"][0][1]["sessionIds"]), (True, ["s9", "x0"]), "a move adds no session, so it still goes")
        held = [{**g, "sessionIds": ["s7"]} if g["id"] == "g1" else g for g in full]
        self.assertEqual([(x["result"], x["saved"]) for x in self.drive(ext, held, ["s7", "Lanes"])], [(False, [])], "100 groups: a move to a new group is refused and the session stays where it was")

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
            self.assertEqual((new.count(b"cbCwd"), new.count(b"callboard file session")), (6, 0), label)
            marker = json.loads(slurp(os.path.join(ext, "callboard-cwd-patch.json")))
            self.assertEqual((marker["patch"], marker["groups"], marker["width"]), (1, False, True), label)
            self.run_script(ext)
            self.assertIn("warning: the group command is not in this patch", self.out, label)
            self.run_script(ext, "--undo")
            self.assertEqual((self.rc, self.js(ext)), (0, raw), label)

    def test_a_file_that_already_has_the_command_is_left_alone(self):
        raw = build(V327, grp=GROUP + 'x.push(Wp("callboard file session",()=>1));')
        ext, marker = self.applied(raw, name="have")
        self.assertEqual((self.rc, marker["groups"]), (0, False))
        self.assertEqual(self.js(ext).count(b"callboard file session"), 1)

    def test_a_patch_from_before_the_command_reads_outdated_and_update_brings_it_in(self):
        mod = load_module()
        ext = self.make(V327, name="old")
        with contextlib.redirect_stdout(io.StringIO()):
            old = load_module()
            old.GROUPS_ANCHOR = rb"(NO)(MATCH)(HERE)"
            old.apply(ext)
        self.assertNotIn(b"callboard file session", self.js(ext))
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
        self.assertIn(b"callboard file session", self.js(ext))
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
                self.assertEqual(self.js(ext).count(b"callboard file session"), 1, d)
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
            mod.PIECES = mod.PIECES[:3]
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
const ctx = vm.createContext({ m, k, B: () => [true, () => {}], VA: 'VA', lv: { host: 'h' }, TAe: {}, BFt: 'BFt', ia: { usageButtonV2: 'u' }, a: 'compact', PBn: () => 50, DBn: { 50: 'd' }, NFt: stock, tFt: stock, _Bt: stock,
  getComputedStyle: () => ({ getPropertyValue: (n) => (n === '--callboard-compact' ? level : '') }), document: { documentElement: {} } })
vm.runInContext(fs.readFileSync(file, 'utf8') + ';globalThis.F = { sv: ' + sv + ', pc: ' + pc + ', Bar }', ctx)
const props = (used, w, o = 20000) => ctx.F.Bar({ usageData: { value: { totalTokens: used, contextWindow: w, maxOutputTokens: o } } }, 50).p.children[1].p
const used = (u, w) => { const r = ctx.F.pc(props(u, w)); return r && r.p.percentageUsed }
const ring = (x) => ctx.F.sv({ percentage: x, className: 'c' }).p.children.map((c) => c && { r: c.p.r, d: c.p.strokeDasharray, s: c.p.stroke })
const hover = (u, w) => { const r = ctx.F.pc(props(u, w)); return r && r.t(r.p).p.children[1].p }
const sized = ctx.F.sv({ percentage: 50, className: 'c' }).p
console.log(JSON.stringify({ window: [props(1, 1000000).contextWindow, props(1, 400000).contextWindow, props(1, 1000000, 8000).contextWindow], used: [used(1000, 1000000), used(233500, 1000000), used(900000, 1000000)],
  ring: [ring(0), ring(50), ring(150), ring(NaN), ring(undefined)], size: [sized.width, sized.height, sized.viewBox],
  hover: [hover(126430, 233000), hover(0, 233000), hover(500, 233000), hover(499, 233000), hover(250000, 233000), hover(1, 33000), hover(undefined, 233000), hover(126430, 1000000), hover(0, 0)] }))
"""
CIRC = 2 * 3.141592653589793 * 7.25
# What an older script that had no pie amounts to: anchors that match nothing, so the piece is left out.
NO_PIE = (("pie component", rb"no such code", lambda m: b""),)
# An older script that had neither the pie nor the pill, so the webview script is left as it was shipped.
NO_WEB = dict(PIE_ANCHORS=NO_PIE, PILL_ANCHOR=rb"no such code")


class Pie(Case):
    """The context pie: one optional piece that edits webview/index.js (kept as webview/index.js.callboard-orig) and puts the autocompact level into the page."""

    WEBJS = os.path.join("webview", "index.js")
    BAK = os.path.join("webview", "index.js.callboard-orig")

    def marker(self, ext):
        return json.loads(slurp(os.path.join(ext, "callboard-cwd-patch.json")))

    def shown(self, ext, level, names=JS330):
        p = subprocess.run(["node", "-e", WEB_RUNNER, os.path.join(ext, self.WEBJS), level, names["sv"], names["pc"]], capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)

    def test_the_patch_edits_the_three_places_once_keeps_the_shipped_script_and_undo_puts_it_back(self):
        for names in (JS330, JSB):
            web = dict(WEB, **{"index.js": PIE_JS.format(**names)})
            ext = self.make(V327, name="pie" + names["pc"], web=web)
            orig = slurp(os.path.join(ext, self.WEBJS))
            self.run_script(ext, "--apply")
            self.assertEqual((self.rc, self.out.count("warning")), (0, 0), self.out)
            new, marker = slurp(os.path.join(ext, self.WEBJS)), self.marker(ext)
            self.assertEqual(slurp(os.path.join(ext, self.BAK)), orig)
            self.assertEqual((marker["pie"], marker["web_original_sha256"], marker["web_patched_sha256"]), (True, hashlib.sha256(orig).hexdigest(), hashlib.sha256(new).hexdigest()))
            self.assertEqual((new.count(b"cbpCap("), new.count(b"cbpN;"), new.count(b"<circle"), new.count(b'"circle"')), (2, 1, 0, 2))
            self.assertNotIn(b"r<=n", new)
            self.assertNotIn(b'"path"', new)
            self.assertEqual((new.count(b'width:"16",height:"16"'), new.count(b'"20"'), new.count(b"cbpTip"), new.count(b"of context remaining")), (1, 0, 3, 0))
            self.assertEqual(sorted(os.listdir(ext)), sorted(STOCK + ["callboard-cwd-patch.json", "extension.js.callboard-orig"]))
            self.run_script(ext)
            self.assertEqual((self.rc, self.out), (0, "patched 2.1.328\n"))
            self.run_script(ext, "--undo")
            self.assertEqual((self.rc, slurp(os.path.join(ext, self.WEBJS))), (0, orig))
            self.assertEqual((sorted(os.listdir(ext)), sorted(os.listdir(os.path.join(ext, "webview")))), (STOCK, ["index.css", "index.js"]))

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_the_pie_always_shows_against_the_level_and_the_ring_is_continuous(self):
        for names in (JS330, JSB):
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
    def test_the_ring_is_16px_and_the_hover_has_a_title_and_used_over_limit_in_k_with_the_percent(self):
        for names in (JS330, JSB):
            web = dict(WEB, **{"index.js": PIE_JS.format(**names)})
            ext = self.make(V327, name="hov" + names["pc"], web=web)
            self.run_script(ext, "--apply")
            got = self.shown(ext, "", names)
            self.assertEqual(got["size"], ["16", "16", "0 0 20 20"], "the drawing keeps its 20 box, so the stroke scales")
            self.assertEqual([h and h.get("hint") for h in got["hover"]],
                             ["126k / 200k used · 63%", "0k / 200k used · 0%", "1k / 200k used · 0%", "0k / 200k used · 0%", "250k / 200k used · 100%", None, "0k / 200k used · 0%",
                              "126k / 967k used · 13%", None], "whole k, the percent of the limit rounded and never past 100; used past the limit shows as it is; no limit draws nothing")
            self.assertEqual(got["hover"][8].keys(), {"text"}, "before the first usage data (a limit below 0) the bold title stands alone, with no hint line")
            self.assertTrue(all(h is None or h["text"] == {"t": "b", "p": {"style": {"fontWeight": 600}, "children": "Context"}} for h in got["hover"]), "a bold title line")
            self.assertEqual(self.shown(ext, " 100000", names)["hover"][0]["hint"], "126k / 67k used · 100%", "the limit is the compaction point of the level, where the ring is full")

    def test_a_missing_tooltip_anchor_leaves_the_stock_hover_and_keeps_the_ring(self):
        js = WEB["index.js"]
        cases = {
            "amounts": js.replace("percentageUsed:r,onCompact:i", "percentage:r,onCompact:i", 1),
            "text": js.replace("of context remaining", "of context left", 1),
            "doubled": js + js[js.index("function jzn"):js.index("function Bar")],
        }
        for label, bad in cases.items():
            ext = self.make(V327, name="tip" + label, web=dict(WEB, **{"index.js": bad}))
            self.run_script(ext, "--apply")
            self.assertEqual((self.rc, self.out.count("warning")), (0, 0), self.out)
            new = slurp(os.path.join(ext, self.WEBJS))
            self.assertEqual((self.marker(ext)["pie"], new.count(b'width:"16",height:"16"'), new.count(b"cbpTip"), new.count(b"cbpCap("), new.count(b"Click to compact now.")), (True, 1, 0, 2, 1 if label != "doubled" else 2), label)
            self.run_script(ext)
            self.assertEqual((self.rc, self.out), (0, "patched 2.1.328\n"), label)

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
            "pie component": js.replace("||r<=n)return null;", ")return null;", 1),
            "drawing": js.replace('strokeOpacity:"0.15"', 'strokeOpacity:"0.2"', 1),
            "doubled": js + js[js.index("function jBt"):js.index("function Bar")],
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
            self.assertEqual(slurp(os.path.join(ext, self.WEBJS)), mod_pill(bad), "only the pill: " + label)
            self.assertEqual(slurp(os.path.join(ext, self.BAK)), bad.encode(), label)
            marker = self.marker(ext)
            self.assertEqual((marker["pie"], marker["pill"], marker["width"], marker["restore"]), (False, True, True, True), label)
            self.assertNotIn(b"callboard-pie", self.js(ext), label)
            self.run_script(ext)
            self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "patched 2.1.328"), label)
            self.assertIn("warning: the context pie is not in this patch.", self.out, label)
            self.run_script(ext, "--undo")
            self.assertEqual((self.rc, sorted(os.listdir(ext))), (0, STOCK), label)
        self.assertEqual(len(mod.PIE_ANCHORS), 3)

    def test_a_pie_with_a_fixed_threshold_leaves_the_pie_out_and_names_the_anchor(self):
        self.assertEqual((PIE_JS.count("threshold:"), PIE_JS_FIXED.count("threshold:"), PIE_JS_FIXED.count("r>=50")), (2, 0, 1))
        ext = self.make(V327, name="before330", web=dict(WEB, **{"index.js": PIE_JS_FIXED.format(**JS330)}))
        self.run_script(ext)
        self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "unpatched-patchable 2.1.328"))
        self.assertIn("warning: the context pie would be left out (pie anchor pie component (no match))", self.out)

    def test_the_pie_is_left_out_whole_when_the_page_builder_cannot_take_its_block(self):
        raw = build(V327, "")
        ext = self.make(V327, name="nofont", raw=raw)
        self.run_script(ext, "--apply")
        self.assertIn("the context pie is not in (font tag anchor (", self.out)
        self.assertEqual(slurp(os.path.join(ext, self.WEBJS)), mod_pill(WEB["index.js"]), "the pill needs no page block")

    def test_an_install_from_before_the_pie_reads_outdated_and_update_brings_it_in(self):
        mod = load_module()
        ext = self.make(V327, name="old")
        orig_js = slurp(os.path.join(ext, self.WEBJS))
        self.older(ext, **NO_WEB)
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

    def test_an_install_made_with_the_earlier_pie_reads_outdated_and_update_rebuilds_it(self):
        old = load_module()
        size = lambda rep: lambda m: rep(m).replace(b'width:"16",height:"16"', b'width:"20",height:"20"')
        earlier = tuple((n, p, size(r) if n == "pie drawing" else r) for n, p, r in old.PIE_ANCHORS)
        ext = self.make(V327, name="earlier")
        orig_js = slurp(os.path.join(ext, self.WEBJS))
        self.older(ext, PIE_ANCHORS=earlier, PIE_TIP_ANCHORS=())
        before = slurp(os.path.join(ext, self.WEBJS))
        self.assertEqual((before.count(b'width:"20"'), before.count(b"cbpTip")), (1, 0))
        self.run_script(ext)
        self.assertEqual((self.rc, self.out.splitlines()[0]), (1, "outdated 2.1.328: the patch code differs from this script's"))
        self.run_script(ext, "--update")
        self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "updated 2.1.328"))
        new = slurp(os.path.join(ext, self.WEBJS))
        self.assertEqual((new.count(b'width:"16"'), new.count(b'"20"'), new.count(b"cbpTip"), slurp(os.path.join(ext, self.BAK))), (1, 0, 3, orig_js))
        self.run_script(ext)
        self.assertEqual((self.rc, self.out), (0, "patched 2.1.328\n"))
        self.run_script(ext, "--undo")
        self.assertEqual(slurp(os.path.join(ext, self.WEBJS)), orig_js)

    def test_update_follows_the_pie_out_when_the_script_can_no_longer_build_it(self):
        mod = load_module()
        ext = self.make(V327, name="out")
        orig_js = slurp(os.path.join(ext, self.WEBJS))
        self.run_script(ext, "--apply")
        vars(mod).update(NO_WEB)
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
            self.older(ext, **NO_WEB)
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
        for name, pie_in in (("linked", False), ("piein", True), ("pillin", "pill"), ("pieandpillin", "both")):
            ext = self.make(V327, name="die-" + name)
            orig_main, orig_js = self.js(ext), slurp(os.path.join(ext, self.WEBJS))
            self.older(ext, **NO_WEB)
            mod = load_module()
            if pie_in:
                new_js = {True: mod.pie_web, "pill": mod.pill_web, "both": lambda j: mod.pill_web(mod.pie_web(j))}[pie_in](orig_js)
                mod.set_web(ext, orig_js, new_js)
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
        vars(mod).update(NO_WEB)
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
        self.older(ext, **NO_WEB)
        os.link(os.path.join(ext, self.WEBJS), os.path.join(ext, self.BAK))
        os.unlink(os.path.join(ext, self.WEBJS))
        with open(os.path.join(ext, self.WEBJS), "w") as f:
            f.write("something else")
        self.assertUnchanged(ext, "--undo")
        self.assertEqual(self.rc, 1)
        self.assertIn("index.js.callboard-orig does not match the marker's recorded original", self.err)

    def test_an_update_whose_writes_and_webview_rollback_all_fail_still_puts_both_files_back(self):
        ext = self.make(V327, name="rb")
        self.older(ext, **NO_WEB)
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

    def test_an_update_that_cannot_put_the_earlier_pie_back_refuses_naming_undo_and_undo_restores_both(self):
        ext = self.make(V327, name="stuck")
        orig_main, orig_js = self.js(ext), slurp(os.path.join(ext, self.WEBJS))
        mod = load_module()
        first = mod.PIE_ANCHORS[0]
        old = ((first[0], first[1], lambda m: b"/*old*/" + first[2](m)),) + mod.PIE_ANCHORS[1:]
        self.older(ext, PIE_ANCHORS=old)
        self.assertEqual(mod.state(ext)[:2], ("outdated", "2.1.328"))
        real, puts = mod.put, []

        def put(path, content, mode):
            if os.path.basename(path) == "index.js" and not puts:
                puts.append(path)
                return real(path, content, mode)
            if os.path.basename(path) in ("index.js", "extension.js"):
                raise OSError(28, "No space left on device")
            real(path, content, mode)

        mod.put = put
        err = io.StringIO()
        with contextlib.redirect_stderr(err), self.assertRaises(SystemExit) as cm:
            mod.update(ext)
        self.assertEqual((cm.exception.code, len(puts)), (1, 1))
        self.assertIn("run --undo", err.getvalue())
        self.assertEqual((mod.state(ext)[0], os.path.exists(os.path.join(ext, "extension.js.callboard-prev"))), ("leftovers", False))
        self.run_script(ext, "--undo")
        self.assertEqual((self.rc, self.js(ext), slurp(os.path.join(ext, self.WEBJS)), sorted(os.listdir(ext))), (0, orig_main, orig_js, STOCK))

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


# Runs the patched stand-in of the footer under fakes, as React would drive it: renders (each builds new props, so a new ref function), a commit that calls the
# ref with the one element, and a request that answers from the connection. The element counts every write to it.
PILL_RUNNER = r"""
const vm = require('vm'), fs = require('fs')
const [file] = process.argv.slice(1)
const m = (t, p) => ({ t, p }), k = (t, p) => ({ t, p })
const tick = () => new Promise((r) => setTimeout(r, 5))
const el = () => {
  const w = { n: 0, log: [] }
  const e = { w, style: { _d: 'none', get display() { return this._d }, set display(v) { w.n++; w.log.push('display=' + v); this._d = v } }, firstChild: null,
    append(t) { w.n++; w.log.push('append ' + t); this.firstChild = { _d: t, get data() { return this._d }, set data(v) { w.n++; w.log.push('data=' + v); this._d = v } } } }
  return e
}
const world = (reply) => {
  const requests = []
  const ctx = vm.createContext({ m, k, BFt: 'BFt', fAe: 'M', Rr: 'M', $Ft: 'L' })
  vm.runInContext(fs.readFileSync(file, 'utf8') + ';globalThis.Foot = Foot', ctx)
  const session = (cwd, stage) => ({ stage, cwd: { value: cwd }, drawnClaudeConfig: { value: { models: [] } },
    getConnection: () => reply === 'throws' ? (() => { throw new Error('no connection') })() : reply === 'none' ? undefined : reply === 'down' ? Promise.reject(new Error('down')) : Promise.resolve({ sendRequest: async (req) => { requests.push(req); return typeof reply === 'function' ? reply(req) : reply } }) })
  const render = (cwd, stage = 0) => { const c = ctx.Foot(session(cwd, stage)).p.children; return { c, span: c.find((x) => x && x.t === 'span') } }
  return { requests, render }
}
const shape = (c) => c.map((x) => x && (x.t === 'span' ? 'pill' : x.t))
;(async () => {
  const out = {}
  // The footer renders again on every reset of its fit stage: six renders of one folder at stages 0,1,2,0,1,2 ask once and write once.
  { const w = world({ name: 'proj', folders: 2 }), e = el(), shapes = [], sizes = []
    for (const [i, st] of [0, 1, 2, 0, 1, 2].entries()) {
      const r = w.render('/a/proj', st); shapes.push(shape(r.c)); sizes.push(r.c.length)
      r.span.p.ref(null); r.span.p.ref(e)
      if (i === 1) await tick()
    }
    await tick()
    out.loop = { requests: w.requests, writes: e.w.log, text: e.firstChild.data, display: e.style.display, keys: Object.keys(w.render('/a/proj').span.p).sort(), shapes, sizes }
    const before = e.w.n; for (let i = 0; i < 5; i++) w.render('/a/proj', i % 3).span.p.ref(e); await tick()
    out.loop.writesAfter = e.w.n - before; out.loop.requestsAfter = w.requests.length
    out.loop.second = await (async () => { const e2 = el(); w.render('/a/proj').span.p.ref(e2); return { log: e2.w.log, requests: w.requests.length } })()
  }
  // A window with one folder keeps the span, hidden.
  { const w = world({ name: 'proj', folders: 1 }), e = el(); w.render('/a/proj').span.p.ref(e); await tick()
    out.single = { log: e.w.log, display: e.style.display, text: e.firstChild.data, n: w.render('/a/proj').c.length } }
  // A click asks for a rename and shows the answer once; an answer with the same name writes nothing; an answer with no name changes nothing.
  { let name = 'Mine'
    const w = world((req) => ({ name: req.rename ? name : 'proj', folders: 2 })), e = el(); const r = w.render('/a/proj'); r.span.p.ref(e); await tick()
    const log = [...e.w.log]; r.span.p.onClick(); await tick()
    const afterFirst = [...e.w.log]; r.span.p.onClick(); await tick()
    const same = e.w.log.length; name = ''; r.span.p.onClick(); await tick()
    out.click = { requests: w.requests, first: log, after: afterFirst, sameWrites: same - afterFirst.length, emptyWrites: e.w.log.length - same, text: e.firstChild.data,
      cached: (() => { const e3 = el(); w.render('/a/proj').span.p.ref(e3); return e3.w.log })() } }
  // A failed request, a getConnection that throws or gives no connection, a bad answer, a folder that is not a string: hidden, nothing thrown, a click too.
  for (const reply of ['down', 'throws', 'none', null, { name: 7, folders: 'x' }]) {
    const w = world(reply), e = el(), r = w.render('/a/proj'); r.span.p.ref(e); r.span.p.onClick(); await tick()
    ;(out.bad ??= []).push({ log: e.w.log, display: e.style.display, n: w.requests.length })
  }
  { let calls = 0
    const w = world(() => (++calls <= 1 ? null : { name: 'proj', folders: 2 })), e = el()
    for (let i = 0; i < 4; i++) { w.render('/a/proj').span.p.ref(e); await tick() }
    const s = world(null), e2 = el()
    for (let i = 0; i < 8; i++) { s.render('/a/proj').span.p.ref(e2); await tick() }
    out.retry = { requests: w.requests.length, log: e.w.log, stuck: s.requests.length, stuckLog: e2.w.log } }
  { const w = world({ name: 'x', folders: 2 })
    out.nocwd = [w.render('').span === undefined, w.render(undefined).span === undefined, w.render(5).span === undefined, w.render('/').span !== undefined] }
  console.log(JSON.stringify(out))
})()
"""


# Runs the patched stand-in extension's request switch under a fake vscode and real files below a root: the handler of the folder pill.
HANDLER_RUNNER = r"""
const vm = require('vm'), fs = require('fs'), path = require('path')
const [file, root] = process.argv.slice(1)
const R = (...p) => path.join(root, ...p)
const st = { folders: [R('a'), R('b')], input: undefined, boxes: [], warned: 0 }
const fake = { workspace: { get workspaceFolders() { return st.folders.map((f) => ({ name: path.basename(f), uri: { fsPath: f } })) } }, commands: { registerCommand: () => ({}) },
  window: { showInputBox: async (o) => { st.boxes.push(o); return st.input }, showWarningMessage: () => { st.warned++ } } }
const ctx = vm.createContext({ x: [], Wp: () => {}, F: () => ({ target: 'panel', focusInput: 1 }), c: {}, kS: async () => {}, rl: async () => {}, $e: fake, Pe: fake, Buffer,
  require: (m) => (m === 'vscode' ? fake : require(m)) })
vm.runInContext(fs.readFileSync(file, 'utf8') + ';globalThis.P = P', ctx)
const opened = []
const call = (req) => ctx.P.prototype.processRequest.call({ openURL: async (u) => opened.push(u) }, { request: req }, undefined)
const folder = (d) => R(d, '.archive', '.folder')
const read = (d) => { try { return fs.readFileSync(folder(d), 'utf8') } catch { return null } }
const put = (d, text) => { fs.mkdirSync(R(d, '.archive'), { recursive: true }); fs.writeFileSync(folder(d), text) }
const name = async (cwd, rename, input) => { st.input = input; return (await call({ type: 'callboard_folder', cwd, rename })).name }
;(async () => {
  const out = {}
  out.stock = { ...(await call({ type: 'open_url', url: 'u' })), opened }
  out.get = await call({ type: 'callboard_folder', cwd: R('a') })
  const archive = fs.existsSync(R('b', '.archive'))
  const n = await name(R('b'), true, 'New')
  out.renamed = { name: n, file: read('b'), archive: !archive && fs.existsSync(R('b', '.archive')) }
  out.cleared = { name: await name(R('b'), true, ''), file: read('b') }
  await name(R('b'), true, 'New')
  out.same = { name: await name(R('b'), true, 'b'), file: read('b') }
  out.fallback = []
  out.fallback.push(await name(R('b')))
  for (const text of ['', '\n\n', '\u0001\u0002\n']) { put('b', text); out.fallback.push(await name(R('b'))) }
  put('b', 'x'.repeat(60)); out.long = await name(R('b'))
  put('b', 'a\u0007b\n'); out.controls = await name(R('b'))
  put('b', '<b>x</b>'); out.markup = await name(R('b'))
  fs.rmSync(folder('b'))
  await name(R('a'), true, undefined)
  const box = st.boxes[st.boxes.length - 1]
  out.box = { value: box.value, validate: [box.validateInput('a\nb'), box.validateInput('x'.repeat(41)), box.validateInput('ok')] }
  const mine = read('a')
  out.esc = { name: await name(R('a'), true, undefined), file: read('a') }
  fs.writeFileSync(folder('a'), mine)
  out.inside = { name: await name(R('a', 'sub'), true, 'Deep'), file: read(path.join('a', 'sub')) }
  st.boxes = []
  out.scope = { relative: await name('a', true, 'X'), outside: await name(R('outside'), true, 'Hack'), dotdot: await name(root + '/a/../outside', true, 'Hack'), number: await name(5, true, 'X'), boxes: st.boxes.length, leak: read('outside') }
  st.folders = [R('a'), R('c')]
  out.blocked = { name: await name(R('c'), true, 'Z'), warned: st.warned }
  out.blocked.cleared = await name(R('c'), true, ''); out.blocked.warnedAfterClear = st.warned
  st.folders = [R('a')]
  const dir = (...p) => fs.mkdirSync(R(...p), { recursive: true })
  fs.writeFileSync(R('outside', 'victim'), 'V')
  dir('a', 'link', '.archive'); fs.symlinkSync(R('outside', 'victim'), folder(path.join('a', 'link')))
  dir('a', 'fifo', '.archive'); require('child_process').execFileSync('mkfifo', [folder(path.join('a', 'fifo'))])
  dir('a', 'dirlink'); fs.symlinkSync(R('outside', '.archive'), R('a', 'dirlink', '.archive'))
  const w0 = st.warned
  out.links = { link: await name(R('a', 'link'), false), linkRename: await name(R('a', 'link'), true, 'Hack'), fifo: await name(R('a', 'fifo'), false), fifoRename: await name(R('a', 'fifo'), true, 'Hack'),
    dirlink: await name(R('a', 'dirlink'), false), dirlinkRename: await name(R('a', 'dirlink'), true, 'Hack'), victim: fs.readFileSync(R('outside', 'victim'), 'utf8'), leak: read('outside'), warned: st.warned - w0 }
  dir('a', '..x')
  out.dots = { name: await name(R('a', '..x'), true, 'Dots'), file: read(path.join('a', '..x')) }
  const long = 'y'.repeat(50); dir('a', long)
  await name(R('a', long), true, undefined)
  const lbox = st.boxes[st.boxes.length - 1]
  out.longFolder = { value: lbox.value === long, validate: lbox.validateInput(long), same: await name(R('a', long), true, long), file: read(path.join('a', long)) }
  console.log(JSON.stringify(out))
})()
"""


class Pill(Case):
    """The folder pill: one optional piece, in webview/index.js with the pie (the page side) and in extension.js (the file, the folder count, the rename box)."""

    WEBJS = os.path.join("webview", "index.js")
    BAK = os.path.join("webview", "index.js.callboard-orig")

    def marker(self, ext):
        return json.loads(slurp(os.path.join(ext, "callboard-cwd-patch.json")))

    def test_the_pill_goes_in_once_after_the_model_pill_and_undo_takes_it_out(self):
        mod = load_module()
        for names in (JS330, JSB):
            web = dict(WEB, **{"index.js": PIE_JS.format(**names)})
            ext = self.make(V327, name="pill" + names["mp"], web=web)
            orig = slurp(os.path.join(ext, self.WEBJS))
            orig_main = self.js(ext)
            self.run_script(ext, "--apply")
            self.assertEqual((self.rc, self.out.count("warning")), (0, 0), self.out)
            new = slurp(os.path.join(ext, self.WEBJS))
            self.assertEqual((self.marker(ext)["pill"], slurp(os.path.join(ext, self.BAK))), (True, orig))
            self.assertEqual((new.count(b'"span"'), new.count(b"title:")), (1, 0), "one pill, no title")
            self.assertEqual((self.js(ext).count(b'case"callboard_folder":'), self.js(ext).index(b'case"callboard_folder":') < self.js(ext).index(b'case"open_url":')), (1, True), "the handler is a case of the request switch")
            self.assertEqual(new.index(b'"span"') > new.index(b"m(%s,{...Ft})" % names["mp"].encode()), True, "after the model pill")
            self.assertEqual(new.index(b'"span"') < new.index(b"m($Ft,"), True, "before the model list")
            start = new.index(b"m(%s,{...Ft})," % names["mp"].encode()) + len(b"m(%s,{...Ft})," % names["mp"].encode())
            expr = new[start:new.index(b"m($Ft,")]
            self.assertNotIn(b"!==2", expr, "not gated on the fit stage: a pill that comes and goes with it loops the footer's layout")
            self.assertIsNone(re.search(rb"(?<![\w$])" + re.escape(names["st"].encode()) + rb"(?![\w$])", expr), "nothing the pill draws depends on the fit stage variable")
            self.assertEqual(expr[:expr.index(b"(cbfP=>")].count(b"&&"), 2, "only its two checks (a string cwd, a non-empty one) lead to the span")
            self.assertEqual(expr.count(b"children"), 0, "no children of its own for the page's renderer to fight the text with")
            self.assertEqual((expr.count(b"createElement"), expr.count(b"innerHTML"), expr.count(b"textContent")), (0, 0, 0), "text only")
            self.run_script(ext)
            self.assertEqual((self.rc, self.out), (0, "patched 2.1.328\n"))
            self.run_script(ext, "--undo")
            self.assertEqual((self.rc, slurp(os.path.join(ext, self.WEBJS)), sorted(os.listdir(ext)), self.js(ext)), (0, orig, STOCK, orig_main))

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_the_pill_asks_once_writes_only_what_differs_and_survives_every_render(self):
        for names in (JS330, JSB):
            web = dict(WEB, **{"index.js": PIE_JS.format(**names)})
            ext = self.make(V327, name="run" + names["mp"], web=web)
            self.run_script(ext, "--apply")
            p = subprocess.run(["node", "-e", PILL_RUNNER, os.path.join(ext, self.WEBJS)], capture_output=True, text=True, timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr)
            got = json.loads(p.stdout)
            loop = got["loop"]
            self.assertEqual(loop["requests"], [{"type": "callboard_folder", "cwd": "/a/proj"}], "six renders, one request, and it is a get")
            self.assertEqual(loop["writes"], ["append proj", "display="], "one write of the text, one of the display, both on the first answer")
            self.assertEqual((loop["text"], loop["display"]), ("proj", ""))
            self.assertEqual((loop["writesAfter"], loop["requestsAfter"]), (0, 1), "later renders write nothing and ask nothing: the footer's child list and text stay as they are")
            self.assertEqual(loop["second"], {"log": ["append proj", "display="], "requests": 1}, "an element that mounts again for a folder already answered is filled from the kept answer, without a request")
            self.assertEqual(loop["keys"], ["onClick", "ref", "style"], "no children, no title: the text is the only thing in the span, put there by the ref")
            self.assertEqual((len(set(loop["sizes"])), all("pill" in s for s in loop["shapes"])), (1, True), "the same number of children and the pill among them at every fit stage, so the footer's observer sees no node added or removed")
            self.assertEqual(loop["shapes"][0], ["BFt", "M", "pill", "L"], "between the model pill and its list")
            self.assertEqual(loop["shapes"][2], ["BFt", False, "pill", "L"], "the narrowest fit stage hides the model pill, not this one")
            self.assertEqual(got["single"], {"log": ["append proj"], "display": "none", "text": "proj", "n": 4}, "one folder: the span stays, hidden, and the display is not written")
            click = got["click"]
            self.assertEqual(click["requests"], [{"type": "callboard_folder", "cwd": "/a/proj"}, {"type": "callboard_folder", "cwd": "/a/proj", "rename": True}] + [{"type": "callboard_folder", "cwd": "/a/proj", "rename": True}] * 2)
            self.assertEqual((click["first"], click["after"]), (["append proj", "display="], ["append proj", "display=", "data=Mine"]), "a rename sets the text node's data")
            self.assertEqual((click["sameWrites"], click["emptyWrites"], click["text"]), (0, 0, "Mine"), "the same answer and an answer with no name write nothing")
            self.assertEqual(click["cached"], ["append Mine", "display="], "a later mount shows the renamed name")
            for b in got["bad"]:
                self.assertEqual(b["display"], "none", "a failed or bad answer leaves it hidden")
                self.assertEqual(b["log"], [], "and writes no text")
            self.assertEqual([b["n"] for b in got["bad"][1:3]], [0, 0], "a getConnection that throws or gives nothing sends no request and throws into no render or click")
            self.assertEqual(got["retry"], {"requests": 2, "log": ["append proj", "display="], "stuck": 3, "stuckLog": []},
                             "a failed ask is not kept: the next render asks again and the pill comes up; one that keeps failing stops after three, writing nothing")
            self.assertEqual(got["nocwd"], [True, True, True, True], "no folder, no pill; a root folder draws one")

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_the_handler_reads_and_writes_only_the_one_file_of_a_window_folder(self):
        for variant in (V327, V328):
            ext = self.make(variant, name="h" + variant["nc"].strip("$"))
            self.run_script(ext, "--apply")
            self.assertEqual(self.marker(ext)["pill"], True)
            root = os.path.join(self.t, "w" + variant["nc"].strip("$"))
            for d in ("a", "b", "outside", os.path.join("a", "sub"), "c"):
                os.makedirs(os.path.join(root, d))
            os.makedirs(os.path.join(root, "outside", ".archive"))
            with open(os.path.join(root, "outside", ".archive", ".folder"), "w") as f:
                f.write("Leak\n")
            os.makedirs(os.path.join(root, "a", ".archive"))
            with open(os.path.join(root, "a", ".archive", ".folder"), "w") as f:
                f.write("  Mine  \nsecond line\n")
            with open(os.path.join(root, "c", "file"), "w") as f:
                f.write("x")
            with open(os.path.join(root, "c", ".archive"), "w") as f:
                f.write("not a folder")
            p = subprocess.run(["node", "-e", HANDLER_RUNNER, os.path.join(ext, "extension.js"), root], capture_output=True, text=True, timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr)
            got = json.loads(p.stdout)
            self.assertEqual(got["stock"], {"type": "open_url_response", "opened": ["u"]}, "the stock case still answers")
            self.assertEqual(got["get"], {"type": "callboard_folder_response", "name": "Mine", "folders": 2}, "the first line, trimmed")
            self.assertEqual(got["fallback"], ["b", "b", "b", "b"], "no file, an empty one, blank lines, only control characters: the folder's last part")
            self.assertEqual(got["long"], "x" * 40, "capped at 40")
            self.assertEqual(got["controls"], "ab", "control characters are dropped")
            self.assertEqual(got["markup"], "<b>x</b>", "a string as it is: the page puts it in as text")
            self.assertEqual(got["box"]["value"], "Mine", "the box is prefilled with the current name")
            self.assertEqual(got["box"]["validate"], ["One line only", "At most 40 characters", None])
            self.assertEqual(got["renamed"], {"name": "New", "file": "New\n", "archive": True}, "Enter writes the file, creating .archive")
            self.assertEqual(got["cleared"], {"name": "b", "file": None}, "an empty name deletes the file")
            self.assertEqual(got["same"], {"name": "b", "file": None}, "the folder's own name needs no file")
            self.assertEqual(got["esc"], {"name": "Mine", "file": "  Mine  \nsecond line\n"}, "Esc changes nothing")
            self.assertEqual(got["inside"], {"name": "Deep", "file": "Deep\n"}, "a folder inside a window folder is allowed")
            self.assertEqual(got["scope"], {"relative": "a", "outside": "outside", "dotdot": "outside", "number": "", "boxes": 0, "leak": "Leak\n"},
                             "a relative path, a folder outside the window and a path that climbs out answer the folder's own name, never read the file and open no box")
            self.assertEqual(got["blocked"], {"name": "c", "warned": 1, "cleared": "c", "warnedAfterClear": 2}, "a write or a clear that fails warns and changes nothing")
            self.assertEqual(got["links"], {"link": "link", "linkRename": "link", "fifo": "fifo", "fifoRename": "fifo", "dirlink": "dirlink", "dirlinkRename": "dirlink", "victim": "V", "leak": "Leak\n", "warned": 3},
                             "a .folder that is a link or a fifo, and an .archive that is a link, are never read and never written through: the name stays the folder's and the target stays as it was")
            self.assertEqual(got["dots"], {"name": "Dots", "file": "Dots\n"}, "a folder whose name starts with two dots is inside the window folder")
            self.assertEqual(got["longFolder"], {"value": True, "validate": None, "same": "y" * 50, "file": None}, "a folder name over 40 characters: the box takes its own prefill, and typing it back clears the file")

    def test_a_missing_handler_anchor_leaves_the_pill_out_and_a_missing_page_anchor_leaves_the_handler_out(self):
        raw = build(V327).decode("utf-8")
        cases = {
            "no switch": ("extension.js", raw.replace('case"open_url":return await this.openURL(', 'case"open_urls":return await this.openURL(', 1), "pill handler anchor (no match)"),
            "doubled": ("extension.js", raw + 'class P2{async processRequest(e,t){switch(e.request.type){case"open_url":return await this.openURL(e.request.url)}}}', "pill handler anchor (2 matches)"),
            "named": ("extension.js", raw + 'var x="callboard_folder";', "the file already contains callboard_folder"),
            "no connection": ("webview", WEB["index.js"].replace("getConnection()", "getConn()"), "no .getConnection()"),
            "no sendRequest": ("webview", WEB["index.js"].replace("sendRequest(", "send("), "no .sendRequest("),
        }
        for label, (where, bad, why) in cases.items():
            ext = self.make(V327, name="h" + label.replace(" ", ""), raw=bad.encode("utf-8") if where == "extension.js" else None, web=dict(WEB, **{"index.js": bad}) if where == "webview" else WEB)
            self.run_script(ext, "--apply")
            self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "patched 2.1.328"), label)
            self.assertIn("warning: the folder pill is not in (" + why, self.out, label)
            marker = self.marker(ext)
            self.assertEqual((marker["pill"], marker["pie"], marker["width"], marker["restore"]), (False, True, True, True), label)
            self.assertNotIn(b'"span"', slurp(os.path.join(ext, self.WEBJS)), label)
            self.assertEqual(self.js(ext).count(b'case"callboard_folder":'), 0, label)
            self.run_script(ext, "--undo")
            self.assertEqual((self.rc, sorted(os.listdir(ext))), (0, STOCK), label)

    def test_the_pill_costs_only_itself_when_its_anchor_misses_or_doubles(self):
        mod = load_module()
        js = WEB["index.js"]
        cases = {
            "no model pill": js.replace("m(fAe,{...Ft})", "m(fAe,{})", 1),
            "member stage": js.replace("_!==2&&m(fAe", "e.stage!==2&&m(fAe", 1),
            "no model list": js.replace("availableModels:e.drawnClaudeConfig", "availableModels:e.config", 1),
            "doubled": js + js[js.index("function Foot"):],
            "no cwd read": js.replace(".cwd.value", ".cwdx.value"),
        }
        for label, bad in cases.items():
            ext = self.make(V327, name="miss" + label.replace(" ", ""), web=dict(WEB, **{"index.js": bad}))
            before = snap(ext)
            self.run_script(ext)
            self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "unpatched-patchable 2.1.328"), label)
            self.assertIn("warning: the folder pill would be left out (" + ("no .cwd.value" if label == "no cwd read" else "pill anchor "), self.out, label)
            self.assertEqual(snap(ext), before, label)
            self.run_script(ext, "--apply")
            self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "patched 2.1.328"), label)
            self.assertIn("warning: the folder pill is not in (" + ("no .cwd.value" if label == "no cwd read" else "pill anchor "), self.out, label)
            marker = self.marker(ext)
            self.assertEqual((marker["pill"], marker["pie"], marker["width"], marker["restore"]), (False, True, True, True), label)
            self.assertNotIn(b'"span"', slurp(os.path.join(ext, self.WEBJS)), label)
            self.assertNotIn(b"callboard_folder", self.js(ext), label)
            self.assertIn(b"cbpCap(", slurp(os.path.join(ext, self.WEBJS)), label)
            self.run_script(ext)
            self.assertIn("warning: the folder pill is not in this patch.", self.out, label)
            self.run_script(ext, "--undo")
            self.assertEqual((self.rc, sorted(os.listdir(ext))), (0, STOCK), label)
        self.assertIn('[class*="usageButtonV2_"] svg{width:16px!important;height:16px!important}', mod.PIE_CSS)

    def test_an_install_from_before_the_pill_reads_outdated_and_update_brings_it_in(self):
        ext = self.make(V327, name="old")
        orig_js = slurp(os.path.join(ext, self.WEBJS))
        self.older(ext, PILL_ANCHOR=rb"no such code")
        self.assertNotIn(b'"span"', slurp(os.path.join(ext, self.WEBJS)))
        self.run_script(ext)
        self.assertEqual((self.rc, self.out.splitlines()[0]), (1, "outdated 2.1.328: the folder pill is not in"))
        self.run_script(ext, "--update")
        self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "updated 2.1.328"))
        self.assertEqual((self.marker(ext)["pill"], slurp(os.path.join(ext, self.BAK)), slurp(os.path.join(ext, self.WEBJS)).count(b'"span"')), (True, orig_js, 1))
        self.run_script(ext)
        self.assertEqual((self.rc, self.out), (0, "patched 2.1.328\n"))

    def test_an_install_with_the_stage_gated_pill_reads_outdated_and_update_replaces_it(self):
        ext = self.make(V327, name="gated")
        mod = load_module()
        def gated(js):
            m = re.search(mod.PILL_ANCHOR, js)
            return mod.pill_web(js).replace(m.group(0), m.group(0) + m.group("st") + b"!==2&&", 1)
        self.older(ext, pill_web=gated)
        self.assertIn(b"!==2&&typeof ", slurp(os.path.join(ext, self.WEBJS)))
        self.run_script(ext)
        self.assertEqual((self.rc, self.out.splitlines()[0]), (1, "outdated 2.1.328: the patch code differs from this script's"))
        self.run_script(ext, "--update")
        self.assertEqual((self.rc, self.out.splitlines()[0]), (0, "updated 2.1.328"))
        self.assertNotIn(b"!==2&&typeof ", slurp(os.path.join(ext, self.WEBJS)))
        self.run_script(ext)
        self.assertEqual((self.rc, self.out), (0, "patched 2.1.328\n"))

    def test_a_webview_without_the_pie_still_takes_the_pill(self):
        ext = self.make(V327, name="nopie", web=dict(WEB, **{"index.js": WEB["index.js"][WEB["index.js"].index("function Foot"):]}))
        self.run_script(ext, "--apply")
        self.assertIn("the context pie is not in (", self.out)
        self.assertEqual((self.marker(ext)["pie"], self.marker(ext)["pill"]), (False, True))
        self.run_script(ext, "--undo")
        self.assertEqual((self.rc, sorted(os.listdir(ext))), (0, STOCK))


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
