"""Lets callboard open a Claude Code panel in any folder of a multi-folder VS Code window. Checks unless --apply or --undo.

  /usr/bin/python3 -I patch-claude.py EXTENSION_DIR [--apply | --undo] [--with-pill]
      EXTENSION_DIR is one installed Claude Code extension folder, for example ~/.vscode/extensions/anthropic.claude-code-<version>-<platform>.
      No flag: change nothing and print one line, the state and the extension's version, then what it means:
        patched                  the patch is in and its marker matches the file
        unpatched-patchable      every anchor was found exactly once: --apply would patch it
        anchors-missing <names>  an update moved the code the patch hooks into (a name is missing or matches twice): --apply refuses
      --apply: patch extension.js, keep the original beside it as extension.js.callboard-orig and write callboard-cwd-patch.json
      (the marker callboard's panels extension reads; its "look" field says whether the panel look below went in). Patched already: says so and stops. A window reload (Developer: Reload
      Window) loads it.
      --undo: put the original back from the backup and remove the backup and the marker (and the pill's, when it is in).
      --with-pill (with --apply, or alone as a check): also add a small pill with the folder's name to the composer's footer, in the second
      file webview/index.js (backup webview/index.js.callboard-orig, a "pill" field in the same marker). It is never part of a plain --apply.
      On a patched extension it adds only the pill. A miss or a failure refuses only the pill (exit 1) and leaves everything else as it was.

The patch gives `claude-vscode.editor.open` a `cwd` in its sixth argument ({cwd: folder}), which becomes the working folder of the
new panel instead of the window's first folder, when it is one of the window's folders (4 edits). A fresh panel opened by a + New session button
(a call with an options object but no `cwd` or session id) in a window with several folders first shows VS Code's own folder list and uses the pick; Escape
opens nothing; a bare call (the palette, Open, an @-mention), a resume and a one-folder window never ask. The panel look (LOOK_CSS below, a style block added to the webview page the extension builds) lets the composer and its permission box use the panel's
width and keeps the Remote Control chip icon-only. Each anchor is a pattern that tolerates renamed minified
identifiers, and the file is written only when every anchor matches exactly once: otherwise nothing changes and the missing ones
are named. The one optional piece, the panel look, is separate: its style block goes in when its one anchor matches exactly once; when it
does not, a warning line says so and the folder patch still applies. There is no half patch: a failure after the file was replaced puts the backup back. An update of the extension is a new
folder, so it starts unpatched and this runs again. It never uses the network, runs nothing else, works only inside EXTENSION_DIR
and changes no setting. Run it as your user: it refuses root. Tests: /usr/bin/python3 -I tools/callboard/test_patch_claude.py
Exit codes: 0 done or nothing to do (patched, patchable), 1 refused or anchors missing, 2 usage.
"""
import hashlib
import json
import os
import re
import stat
import sys
import tempfile

MAIN = "extension.js"
BACKUP = "extension.js.callboard-orig"
MARKER = "callboard-cwd-patch.json"
PATCH = 1
NAME = b"cbCwd"
ID = rb"[A-Za-z_$][\w$]*"
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")

# The panel look: the one block of CSS the patch adds to the webview page, and the one place to tune it. It ends up inside a JavaScript template literal of
# the extension, so it holds no backtick, backslash or "${". Class names of the page carry a build hash, so the selectors match their stable prefix.
# CONFIRMED against the shipped index.css (2.1.328): the 680px cap on `inputWrapper_` and `permissionsContainer_` (both centred with margin:0 auto), and
# the Remote Control chip's `aria-label`. A GUESS, which only a rendered panel can confirm: `inputContainer_`, the composer's outer box (absolute,
# max-width 680px, left and right 16px). The guess is limited to the rule that has no `data-permission-mode`, because the inner box of the same prefix has it.
# If the side margin does not change, find the element that holds the margin in the window's developer tools and change that selector and the 8px.
LOOK_CSS = (
    '[class*="inputWrapper_"],[class*="permissionsContainer_"]{max-width:none!important}'
    '[class*="inputContainer_"]:not([data-permission-mode]){max-width:none!important;left:8px!important;right:8px!important}'
    '[aria-label="Remote Control"]{padding:0!important}'
    '[aria-label="Remote Control"] svg{display:block!important}'
    '[aria-label="Remote Control"] span{display:none!important}'
)
LOOK_ID = b"callboard-look"

WEB = os.path.join("webview", "index.js")
WEB_BACKUP = WEB + ".callboard-orig"


# (label, pattern, replacement). The replacement gets the match; each pattern is checked on the unpatched file.
ANCHORS = (
    ("createPanel signature",
     rb"(async createPanel\((?:ID,){7}ID=!1)\)\{".replace(b"ID", ID),
     lambda m: m.group(1) + b"," + NAME + b"){"),
    ("createPanel's setupPanel call",
     rb"(this\.setupPanel\(ID,ID,ID,ID,ID===!0,ID)\)".replace(b"ID", ID),
     lambda m: m.group(1) + b"," + NAME + b")"),
    ("setupPanel start",
     rb"(setupPanel\((?:ID,){5}ID=!1)\)\{(this\.panelFullEditor\.set\(ID,!!ID\);let (ID)=ID\.workspace\.workspaceFolders\?\.map\(\((ID)\)=>\4\.uri\.fsPath\)"
     rb"\|\|\[\],ID=ID\()\3\)".replace(b"ID", ID),
     lambda m: m.group(1) + b"," + NAME + b"){" + m.group(2) + m.group(3) + b".includes(" + NAME + b")?[" + NAME + b"]:" + m.group(3) + b")"),
    ("editor.open command",
     rb'("claude-vscode\.editor\.open",async\((?P<args>(?:ID,){4}ID),(?P<opt>ID)\)=>\{[\s\S]{0,1500}?)(?P<decl>let\{[^{}]{1,80}\}=await ID)\.createPanel\((?P=args),(?P<fi>ID\.focusInput)\)'.replace(b"ID", ID),
     lambda m: m.group(1) + b"let cbqC=await " + pick(m.group("args").split(b",")[0], m.group("opt")) + b";if(cbqC===null)return;" + m.group("decl")
     + b".createPanel(" + m.group("args") + b"," + m.group("fi") + b",void 0,!1,cbqC)"),
)


# The panel look's anchor: the webview page's stylesheet link followed by the font configuration style tag. The block goes between them, after the page's own
# stylesheet, so it wins ties. Optional: when it does not match exactly once the folder patch still applies.
LOOK_ANCHOR = rb'(<link href="\$\{[^}`]{1,60}\}" rel="stylesheet">)(\s*)(<style id="claude-font-configuration">)'


def look_block(m):
    return m.group(1) + m.group(2) + b'<style id="' + LOOK_ID + b'">' + LOOK_CSS.encode("ascii") + b"</style>" + m.group(2) + m.group(3)


def look_problem(raw):
    """Why the panel look cannot go in (None when it can): its anchor does not match exactly once, or the page already has the block."""
    n = len(re.findall(LOOK_ANCHOR, raw))
    if n != 1:
        return "look anchor (%s)" % ("no match" if n == 0 else "%d matches" % n)
    return "the file already contains %s" % LOOK_ID.decode() if LOOK_ID in raw else None


# The opt-in folder pill, in the webview bundle: the composer footer's element list, `S` the session, `ST` the footer's fit stage, `M` the element function.
# The pill goes after the context meter (`m(aFt,{session:e})`) and before the Remote Control chip, shows the last part of the session's folder (cwd, the
# panel's own folder) with the full path as its title, and is left out at the narrowest fit stage (2) like the model pill. Inline style, so no stylesheet is needed.
PILL_ANCHOR = (rb'("data-fit-stage":(?P<st>ID),children:\[(?:(?!"data-fit-stage")[\s\S]){0,2500}?)(?P<jsx>ID)\((?P<comp>ID),\{session:(?P<s>ID)\}\),'
               rb'(?P=s)\.remoteControlState\.value\.status!=="disconnected"&&').replace(b"ID", ID)
PILL_ID = b"data-callboard"
PILL_STYLE = (b'{display:"block",flexShrink:0,maxWidth:"11em",boxSizing:"border-box",padding:"0 8px",borderRadius:"9999px",fontSize:".85em",'
              b'lineHeight:"var(--app-pill-min-height)",background:"var(--app-pill-background)",color:"var(--app-pill-foreground)",'
              b'overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}')


def pill_block(m):
    s, cwd = m.group("s"), m.group("s") + b".cwd.value"
    return (m.group(1) + m.group("jsx") + b"(" + m.group("comp") + b",{session:" + s + b"})," + m.group("st") + b"!==2&&" + cwd + b"&&" + m.group("jsx")
            + b'("span",{"' + PILL_ID + b'":"folder",title:' + cwd + b",style:" + PILL_STYLE + b",children:" + cwd + rb'.split(/[\\/]/).filter(Boolean).pop()}),'
            + s + b'.remoteControlState.value.status!=="disconnected"&&')


def pill_problem(raw):
    """Why the pill cannot go in (None when it can): the file is missing, its anchor does not match exactly once, or it already holds the pill."""
    if raw is None:
        return "%s is missing" % WEB
    n = len(re.findall(PILL_ANCHOR, raw))
    if n != 1:
        return "pill anchor (%s)" % ("no match" if n == 0 else "%d matches" % n)
    return "the file already contains %s" % PILL_ID.decode() if PILL_ID in raw else None


def pick(sid, opt):
    """The folder a new panel starts in: the caller's {cwd}, else (a fresh open that carries an options object, which is what the + New session buttons send,
    in a window with several folders) the one picked in VS Code's own list, else none. A bare call (the palette, Open, an @-mention) never asks.
    null is a cancelled pick: nothing opens. Uses require("vscode") of the extension's own bundle, so it needs no module alias."""
    return (b'(async()=>{let cbqV=require("vscode"),cbqF=cbqV.workspace.workspaceFolders||[];if(typeof ' + opt + b'?.cwd=="string")return ' + opt + b".cwd;"
            b"if(" + sid + b"!==void 0||!" + opt + b"||cbqF.length<2)return;"
            b"let cbqP=await cbqV.window.showQuickPick(cbqF.map((cbqE)=>({label:cbqE.name,description:cbqE.uri.fsPath,fsPath:cbqE.uri.fsPath}))"
            b',{placeHolder:"Start the session in which folder?"});return cbqP?cbqP.fsPath:null})()')


def refuse(msg):
    print("patch-claude: " + msg, file=sys.stderr)
    sys.exit(1)


def usage(msg):
    print("patch-claude: " + msg, file=sys.stderr)
    sys.exit(2)


def show(p):
    return p if p.isprintable() else json.dumps(p)


def read(path):
    """The bytes of a regular file, never through a link; None when it is missing."""
    if os.path.islink(path):
        refuse("%s is a link; refusing to work through it" % show(path))
    if not os.path.lexists(path):
        return None
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
            refuse("%s is not a regular file" % show(path))
        return f.read()


def put(path, content, mode):
    """Temp file in the same folder, then a rename over the target: a reader sees the old file or the new one."""
    d, base = os.path.split(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix="." + base + ".callboard-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        if os.path.lexists(tmp):
            os.unlink(tmp)
        raise


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def pill_of(m):
    """The marker's pill field ({original_sha256, patched_sha256} of webview/index.js), or None."""
    p = m.get("pill") if m else None
    return p if isinstance(p, dict) and all(isinstance(p.get(k), str) for k in ("original_sha256", "patched_sha256")) else None


def version(ext):
    raw = read(os.path.join(ext, "package.json"))
    try:
        pkg = json.loads(raw.decode("utf-8")) if raw is not None else None
    except ValueError:
        pkg = None
    if not isinstance(pkg, dict) or str(pkg.get("publisher")).lower() != "anthropic" or pkg.get("name") != "claude-code":
        refuse("%s is not an installed Claude Code extension folder (its package.json is not anthropic.claude-code)" % show(ext))
    ver = pkg.get("version")
    if not isinstance(ver, str) or not VERSION.fullmatch(ver):
        refuse("the extension's package.json has no version like 1.2.3")
    return ver


def marker_of(ext):
    """The marker's fields, or None when there is none or it is not this script's (the state then reads as leftovers)."""
    raw = read(os.path.join(ext, MARKER))
    try:
        m = json.loads(raw.decode("utf-8")) if raw is not None else None
    except ValueError:
        return None
    ok = isinstance(m, dict) and m.get("patch") == PATCH and all(isinstance(m.get(k), str) for k in ("original_sha256", "patched_sha256"))
    return m if ok else None


def problems(raw):
    """What stops a patch: a label per anchor that matches nothing or more than once. [] means every anchor matches exactly once."""
    out = []
    for used in (NAME, b"cbq"):
        if used in raw:
            out.append("the file already contains %s" % used.decode())
    for label, pat, _ in ANCHORS:
        n = len(re.findall(pat, raw))
        if n != 1:
            out.append("%s (%s)" % (label, "no match" if n == 0 else "%d matches" % n))
    return out


def patched(raw):
    """(the patched bytes, whether the panel look went in). Every anchor is replaced on these very bytes and must match exactly once, else nothing is
    written; the look is the one anchor that may miss."""
    for label, pat, rep in ANCHORS:
        raw, n = re.subn(pat, rep, raw)
        if n != 1:
            refuse("%s matched %d times; nothing was changed" % (label, n))
    if look_problem(raw) is not None:
        return raw, False
    return re.sub(LOOK_ANCHOR, look_block, raw), True


def state(ext):
    """(name, version, detail). Reads only."""
    ver = version(ext)
    raw = read(os.path.join(ext, MAIN))
    if raw is None:
        refuse("%s has no %s" % (show(ext), MAIN))
    m = marker_of(ext)
    if m is not None and m["patched_sha256"] == digest(raw):
        return "patched", ver, ""
    left = [n for n in (MARKER, BACKUP, WEB_BACKUP) if os.path.lexists(os.path.join(ext, n))]
    if left:
        return "leftovers", ver, ", ".join(left)
    bad = problems(raw)
    return ("anchors-missing", ver, "; ".join(bad)) if bad else ("unpatched-patchable", ver, "")


def add_pill(ext):
    """The folder pill, a step of its own after the main patch: a miss or a failure refuses only the pill and leaves the rest as it was. Returns the exit code."""
    web, marker = os.path.join(ext, WEB), os.path.join(ext, MARKER)
    raw, old = read(web), read(marker)
    m = marker_of(ext)
    if m is not None and pill_of(m) is not None and raw is not None and digest(raw) == pill_of(m)["patched_sha256"]:
        print("pill already in")
        return 0
    miss = pill_problem(raw)
    if miss is None and os.path.lexists(os.path.join(ext, WEB_BACKUP)):
        miss = "%s is left over from an earlier run; run --undo first" % WEB_BACKUP
    if miss is not None:
        print("pill refused: %s. Nothing was changed for it; the rest of the patch is as it was." % miss)
        return 1
    new = re.sub(PILL_ANCHOR, pill_block, raw)
    backup = os.path.join(ext, WEB_BACKUP)
    try:
        os.link(web, backup)
        put(web, new, os.stat(web).st_mode & 0o777)
        put(marker, json.dumps(dict(m, pill={"original_sha256": digest(raw), "patched_sha256": digest(new)})).encode() + b"\n", 0o644)
        if read(web) != new:
            raise OSError("the file read back differs")
    except BaseException as e:
        if os.path.lexists(backup):
            os.replace(backup, web)
        if os.path.lexists(backup):
            os.unlink(backup)
        if read(marker) != old:
            put(marker, old, 0o644)
        print("pill refused: could not patch (%s); %s is back as it was." % (e.strerror if isinstance(e, OSError) and e.strerror else type(e).__name__, WEB))
        return 1
    print("pill in: %s (backup: %s, and a pill field in %s). Reload the VS Code window; --undo takes it out with the rest." % (WEB, WEB_BACKUP, MARKER))
    return 0


def apply(ext, with_pill=False):
    name, ver, detail = state(ext)
    if name == "patched":
        print("already patched %s" % ver)
        return add_pill(ext) if with_pill else 0
    if name == "leftovers":
        refuse("%s from an earlier run is in %s but does not match the file; run --undo first" % (detail, show(ext)))
    if name == "anchors-missing":
        print("anchors-missing %s: %s" % (ver, detail))
        print("Nothing was changed. The extension's code moved; the patterns in this script need a repair.")
        return 1
    main = os.path.join(ext, MAIN)
    raw = read(main)
    new, look = patched(raw)
    mode = os.stat(main).st_mode & 0o777
    backup = os.path.join(ext, BACKUP)
    try:
        # A hard link costs no space, and the patched file is a new inode, so the backup keeps the original.
        os.link(main, backup)
        put(main, new, mode)
        put(os.path.join(ext, MARKER), json.dumps({"patch": PATCH, "version": ver, "look": look, "original_sha256": digest(raw), "patched_sha256": digest(new)}).encode() + b"\n", 0o644)
        if read(main) != new:
            raise OSError("the file read back differs")
    except BaseException as e:
        # Back to the original: renaming the backup over the file is atomic and needs no space (a no-op when both are still one inode).
        if os.path.lexists(backup):
            os.replace(backup, main)
        for n in (BACKUP, MARKER):
            if os.path.lexists(os.path.join(ext, n)):
                os.unlink(os.path.join(ext, n))
        refuse("could not patch (%s); the original is back and nothing is left over" % (e.strerror if isinstance(e, OSError) and e.strerror else type(e).__name__))
    print("patched %s" % ver)
    print("Changed: %s (backup: %s, marker: %s, all in %s)" % (MAIN, BACKUP, MARKER, show(ext)))
    if not look:
        print("warning: the panel look is not in (%s); the folder patch is." % look_problem(raw))
    print("Reload the VS Code window (Developer: Reload Window) to load it. Undo: run this with --undo.")
    return add_pill(ext) if with_pill else 0


def revert_plan(ext, rel, backup, want):
    """What putting `rel` back takes: (the original's bytes or None, whether the file must be written). Refuses when the original is in doubt.
    `want` is the sha256 the marker records for the original, or None when it records none."""
    orig, raw = read(os.path.join(ext, backup)), read(os.path.join(ext, rel))
    if orig is not None and want is not None and digest(orig) != want:
        refuse("%s does not match the marker's recorded original; left alone. Reinstall the extension instead" % backup)
    if orig is None:
        if want is None or raw is None or digest(raw) != want:
            refuse("the backup is gone and %s is not known to be the original; reinstall the extension instead" % rel)
        return None, False
    return orig, raw != orig


def undo(ext):
    version(ext)
    m = marker_of(ext)
    pill = pill_of(m)
    has_web = os.path.lexists(os.path.join(ext, WEB_BACKUP))
    if read(os.path.join(ext, BACKUP)) is None and not os.path.lexists(os.path.join(ext, MARKER)) and not has_web:
        print("nothing to undo")
        return 0
    # Both files are checked before either is written, so a doubt about one leaves the other alone too.
    plans = [(MAIN, BACKUP, m["original_sha256"] if m else None)]
    if has_web or pill:
        plans.append((WEB, WEB_BACKUP, pill["original_sha256"] if pill else None))
    todo = [(rel, revert_plan(ext, rel, backup, want)) for rel, backup, want in plans]
    for rel, (orig, write) in todo:
        if write:
            put(os.path.join(ext, rel), orig, os.stat(os.path.join(ext, rel)).st_mode & 0o777)
    for n in (BACKUP, WEB_BACKUP, MARKER):
        if os.path.lexists(os.path.join(ext, n)):
            os.unlink(os.path.join(ext, n))
    print("undone: the original %s %s back, backup and marker removed" % (" and ".join(rel for rel, _ in todo), "is" if len(todo) == 1 else "are"))
    print("Reload the VS Code window to load it.")
    return 0


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    flags = [a for a in argv if a.startswith("--")]
    pill = "--with-pill" in flags
    modes = [f for f in flags if f != "--with-pill"]
    if len(args) != 1 or any(f not in ("--apply", "--undo", "--with-pill") for f in flags) or len(set(flags)) != len(flags) or len(modes) > 1 or (pill and modes == ["--undo"]):
        usage("usage: patch-claude.py EXTENSION_DIR [--apply | --undo] [--with-pill (not with --undo)]")
    if os.geteuid() == 0:
        refuse("run this as your user, not as root")
    ext = os.path.abspath(args[0])
    if os.path.islink(ext) or not os.path.isdir(ext):
        refuse("%s is not a folder (a link is refused too)" % show(ext))
    if modes == ["--apply"]:
        return apply(ext, pill)
    if modes == ["--undo"]:
        return undo(ext)
    name, ver, detail = state(ext)
    print("%s %s%s" % (name, ver, ": " + detail if detail else ""))
    if name == "leftovers":
        print("A backup or marker from an earlier run is here and does not match the file: run --undo.")
    miss = look_problem(read(os.path.join(ext, MAIN))) if name == "unpatched-patchable" else None
    if miss:
        print("warning: the panel look would be left out (%s); the folder patch would still apply." % miss)
    m = marker_of(ext) if name == "patched" else None
    if m is not None and m.get("look") is not True:
        print("warning: the panel look is not in this patch.")
    if m is not None and pill_of(m) is not None:
        web = read(os.path.join(ext, WEB))
        print("pill: in" if web is not None and digest(web) == pill_of(m)["patched_sha256"] else "warning: the pill is not in (%s does not match the marker)." % WEB)
    elif pill and name in ("patched", "unpatched-patchable"):
        miss = pill_problem(read(os.path.join(ext, WEB)))
        print("pill: would be refused (%s)" % miss if miss else "pill: --apply --with-pill would add it")
    return 1 if name in ("anchors-missing", "leftovers") else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
