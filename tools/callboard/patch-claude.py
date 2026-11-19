"""Lets callboard open a Claude Code panel in any folder of a multi-folder VS Code window. Checks unless --apply, --update or --undo.

  /usr/bin/python3 -I patch-claude.py EXTENSION_DIR [--apply | --update | --undo]
      EXTENSION_DIR is one installed Claude Code extension folder, for example ~/.vscode/extensions/anthropic.claude-code-<version>-<platform>.
      No flag: change nothing and print one line, the state and the extension's version, then what it means:
        patched                  the patch is in, its marker matches the file and it is what this script would build now
                                 (with no backup that matches the marker, there is nothing to build from, and the marker decides)
        outdated <why>           the patch is in but an older script built it (the line names what differs): --update brings it current
        unpatched-patchable      every anchor was found exactly once: --apply would patch it
        anchors-missing <names>  an update moved the code the patch hooks into (a name is missing or matches twice): --apply refuses
      --apply: patch extension.js, keep the original beside it as extension.js.callboard-orig and write callboard-cwd-patch.json
      (the marker callboard's panels extension reads; its "look" and "groups" fields say whether the panel look and the group command below went in). Patched already: says so and stops; outdated: refuses and names --update. A window reload (Developer: Reload
      Window) loads it.
      --update: for an `outdated` install, build the patch again from the backup original and swap it in: extension.js and the marker are
      replaced, the backup is not touched. The new bytes are built before anything is written (a refusal changes nothing), and a failed write puts the
      previous patched file back. Any other state: the same as --apply.
      --undo: put the original back from the backup and remove the backup and the marker.

The patch gives `claude-vscode.editor.open` a `cwd` in its sixth argument ({cwd: folder}), which becomes the working folder of the
new panel instead of the window's first folder, when it is one of the window's folders (4 edits). A fresh panel opened by a + New session button
(a call with an options object but no `cwd` or session id) in a window with several folders first shows VS Code's own folder list and uses the pick; Escape
opens nothing; a bare call (the palette, Open, an @-mention), a resume and a one-folder window never ask. The panel look (LOOK_CSS below, a style block added to the webview page the extension builds) lets the composer and its permission box use the panel's
width and keeps the Remote Control chip icon-only. Each anchor is a pattern that tolerates renamed minified
identifiers, and the file is written only when every anchor matches exactly once: otherwise nothing changes and the missing ones
are named. Two optional pieces are separate: the panel look, whose style block goes in when its one anchor matches exactly once, and the group
command (GROUPS_ANCHOR below), which registers `callboard assign group` (session id, group name) so callboard's panels extension can put a lead, lane or conductor
session in the sidebar's Lead, Lanes or Conductor group; when an optional anchor does not match, a warning line says so and the folder patch still applies. There is no half patch: a failure after the file was replaced puts the backup back. An update of the extension is a new
folder, so it starts unpatched and this runs again. It never uses the network, runs nothing else, works only inside EXTENSION_DIR
and changes no setting. Run it as your user: it refuses root. Tests: /usr/bin/python3 -I tools/callboard/test_patch_claude.py
Exit codes: 0 done or nothing to do (patched, patchable), 1 refused, outdated or anchors missing, 2 usage.
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
PREVIOUS = "extension.js.callboard-prev"
MARKER = "callboard-cwd-patch.json"
PATCH = 1
NAME = b"cbCwd"
ID = rb"[A-Za-z_$][\w$]*"
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")

# The panel look: the one block of CSS the patch adds to the webview page, and the one place to tune it. It ends up inside a JavaScript template literal of
# the extension, so it holds no backtick, backslash or "${". Class names of the page carry a build hash, so the selectors match their stable prefix.
# CONFIRMED against the shipped index.css: the 680px cap on `inputWrapper_` and `permissionsContainer_` (both centred with margin:0 auto), and
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


# The group command's anchor: the registration of the stock command that adds the active tab to a group, which sits inside an `x.subscriptions.push(...)` call
# of the extension's activation. Our registration goes in front of it as one more argument of that push. Optional, like the look.
GROUPS_ANCHOR = rb'(?P<vs>ID)\.commands\.registerCommand\("claude-vscode\.addSessionTabToGroup",async\(\)=>\{if\(!await (?P<prov>ID)\.addActiveSessionTabToGroup\(\)\)'.replace(b"ID", ID)
GROUPS_COMMAND = "callboard assign group"


def groups_command(m):
    """`callboard assign group` (session id, group name): in the window's group list (the provider's own settings, which are keyed by the window's first folder)
    find the group by name in any letter case, create it when there is none, add the session to it unless it already sits in some group, and save through the
    provider, which also tells the open sidebars. Returns true when the session sits in a group afterwards, false when it was refused: a bad argument, an
    archived session (the provider's save drops archived ids from every group, as the stock command refuses them), or the stock list limits (100 groups,
    1000 sessions: the provider's save would drop the excess without saying). Uses only members the extension keeps unminified."""
    p = m.group("prov")
    return (m.group("vs") + b'.commands.registerCommand("' + GROUPS_COMMAND.encode() + b'",async(cbqS,cbqN)=>{'
            b'if(typeof cbqS!="string"||typeof cbqN!="string"||!cbqN)return!1;let cbqG=' + p + b".settings.getSessionGroups();"
            b"if(" + p + b".settings.getArchivedSessionIds().includes(cbqS))return!1;"
            b"if(cbqG.some((cbqE)=>cbqE.sessionIds.includes(cbqS)))return!0;"
            b"let cbqL=cbqN.toLowerCase(),cbqT=cbqG.find((cbqE)=>cbqE.name.toLowerCase()===cbqL);"
            b"if(!cbqT&&cbqG.length>=100||cbqG.reduce((cbqA,cbqE)=>cbqA+cbqE.sessionIds.length,0)>=1000)return!1;"
            + p + b".persistGroupsFromHost(cbqT?cbqG.map((cbqE)=>cbqE===cbqT?{...cbqE,sessionIds:[...cbqE.sessionIds,cbqS]}:cbqE)"
            b':[...cbqG,{id:require("crypto").randomUUID(),name:cbqN,collapsed:!1,sessionIds:[cbqS]}]);return!0}),' + m.group(0))


def groups_problem(raw):
    """Why the group command cannot go in (None when it can): its anchor does not match exactly once, or the file already has it."""
    n = len(re.findall(GROUPS_ANCHOR, raw))
    if n != 1:
        return "groups anchor (%s)" % ("no match" if n == 0 else "%d matches" % n)
    return "the file already contains %s" % GROUPS_COMMAND if GROUPS_COMMAND.encode() in raw else None


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
    """(the patched bytes, whether the panel look went in, whether the group command went in). Every anchor is replaced on these very bytes and must match
    exactly once, else nothing is written; the two optional pieces may miss."""
    for label, pat, rep in ANCHORS:
        raw, n = re.subn(pat, rep, raw)
        if n != 1:
            refuse("%s matched %d times; nothing was changed" % (label, n))
    look = look_problem(raw) is None
    if look:
        raw = re.sub(LOOK_ANCHOR, look_block, raw)
    groups = groups_problem(raw) is None
    if groups:
        raw = re.sub(GROUPS_ANCHOR, groups_command, raw)
    return raw, look, groups


def stale(ext, raw, m):
    """Why the installed patch differs from the one this script builds from the backed-up original, or None when it is the same (or no usable backup is there to build from)."""
    orig = read(os.path.join(ext, BACKUP))
    if orig is None or digest(orig) != m["original_sha256"]:
        return None
    bad = problems(orig)
    if bad:
        return "this script no longer fits the backup: " + "; ".join(bad)
    new, look, groups = patched(orig)
    if digest(new) == digest(raw):
        return None
    if look and m.get("look") is not True:
        return "the panel look is not in"
    return "the group command is not in" if groups and m.get("groups") is not True else "the patch code differs from this script's"


def state(ext):
    """(name, version, detail). Reads only."""
    ver = version(ext)
    raw = read(os.path.join(ext, MAIN))
    if raw is None:
        refuse("%s has no %s" % (show(ext), MAIN))
    m = marker_of(ext)
    if m is not None and m["patched_sha256"] == digest(raw):
        why = stale(ext, raw, m)
        return ("outdated", ver, why) if why else ("patched", ver, "")
    left = [n for n in (MARKER, BACKUP) if os.path.lexists(os.path.join(ext, n))]
    if left:
        return "leftovers", ver, ", ".join(left)
    bad = problems(raw)
    return ("anchors-missing", ver, "; ".join(bad)) if bad else ("unpatched-patchable", ver, "")


def reason(e):
    return e.strerror if isinstance(e, OSError) and e.strerror else type(e).__name__


def write_patch(ext, ver, orig, new, look, groups):
    """The one write of a patch, for --apply and --update: the patched file, read back, then the marker that vouches for it."""
    main = os.path.join(ext, MAIN)
    put(main, new, os.stat(main).st_mode & 0o777)
    if read(main) != new:
        raise OSError("the file read back differs")
    put(os.path.join(ext, MARKER), json.dumps({"patch": PATCH, "version": ver, "look": look, "groups": groups, "original_sha256": digest(orig), "patched_sha256": digest(new)}).encode() + b"\n", 0o644)


def apply(ext):
    name, ver, detail = state(ext)
    if name == "patched":
        print("already patched %s" % ver)
        return 0
    if name == "outdated":
        refuse("the patch in %s is outdated (%s); run --update" % (show(ext), detail))
    if name == "leftovers":
        refuse("%s from an earlier run is in %s but does not match the file; run --undo first" % (detail, show(ext)))
    if name == "anchors-missing":
        print("anchors-missing %s: %s" % (ver, detail))
        print("Nothing was changed. The extension's code moved; the patterns in this script need a repair.")
        return 1
    main = os.path.join(ext, MAIN)
    raw = read(main)
    new, look, groups = patched(raw)
    backup = os.path.join(ext, BACKUP)
    try:
        # A hard link costs no space, and the patched file is a new inode, so the backup keeps the original.
        os.link(main, backup)
        write_patch(ext, ver, raw, new, look, groups)
    except BaseException as e:
        # Back to the original: renaming the backup over the file is atomic and needs no space (a no-op when both are still one inode).
        if os.path.lexists(backup):
            os.replace(backup, main)
        for n in (BACKUP, MARKER):
            if os.path.lexists(os.path.join(ext, n)):
                os.unlink(os.path.join(ext, n))
        refuse("could not patch (%s); the original is back and nothing is left over" % reason(e))
    print("patched %s" % ver)
    print("Changed: %s (backup: %s, marker: %s, all in %s)" % (MAIN, BACKUP, MARKER, show(ext)))
    if not look:
        print("warning: the panel look is not in (%s); the folder patch is." % look_problem(raw))
    if not groups:
        print("warning: the group command is not in (%s); the folder patch is." % groups_problem(raw))
    print("Reload the VS Code window (Developer: Reload Window) to load it. Undo: run this with --undo.")
    return 0


def update(ext):
    name, ver, detail = state(ext)
    if name != "outdated":
        return apply(ext)
    main = os.path.join(ext, MAIN)
    orig = read(os.path.join(ext, BACKUP))
    bad = problems(orig)
    if bad:
        refuse("this script cannot build the patch from the backup (%s); nothing was changed" % "; ".join(bad))
    new, look, groups = patched(orig)
    # The previous patched file stays reachable under a second name (a hard link, no space) until the new one is in: a failed write puts it back.
    prev = os.path.join(ext, PREVIOUS)
    if os.path.lexists(prev):
        os.unlink(prev)
    os.link(main, prev)
    failed = None
    try:
        write_patch(ext, ver, orig, new, look, groups)
    except BaseException as e:
        # A no-op when the file was never replaced (both names are one inode), so the spare name goes either way.
        os.replace(prev, main)
        failed = e
    if os.path.lexists(prev):
        os.unlink(prev)
    if failed is not None:
        refuse("could not update (%s); the previous patch is back and nothing else changed" % reason(failed))
    print("updated %s" % ver)
    print("Changed: %s and %s, rebuilt from the backup %s (not touched), all in %s" % (MAIN, MARKER, BACKUP, show(ext)))
    if not look:
        print("warning: the panel look is not in (%s); the folder patch is." % look_problem(orig))
    if not groups:
        print("warning: the group command is not in (%s); the folder patch is." % groups_problem(orig))
    print("Reload the VS Code window (Developer: Reload Window) to load it. Undo: run this with --undo.")
    return 0


def undo(ext):
    version(ext)
    main = os.path.join(ext, MAIN)
    m = marker_of(ext)
    orig = read(os.path.join(ext, BACKUP))
    if orig is None and not os.path.lexists(os.path.join(ext, MARKER)):
        print("nothing to undo")
        return 0
    if orig is not None and m is not None and digest(orig) != m["original_sha256"]:
        refuse("%s does not match the marker's recorded original; left alone. Reinstall the extension instead" % BACKUP)
    raw = read(main)
    if orig is None:
        if m is None or raw is None or digest(raw) != m["original_sha256"]:
            refuse("the backup is gone and %s is not known to be the original; reinstall the extension instead" % MAIN)
    elif raw != orig:
        put(main, orig, os.stat(main).st_mode & 0o777)
    for n in (BACKUP, MARKER, PREVIOUS):
        if os.path.lexists(os.path.join(ext, n)):
            os.unlink(os.path.join(ext, n))
    print("undone: the original %s is back, backup and marker removed" % MAIN)
    print("Reload the VS Code window to load it.")
    return 0


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    flags = [a for a in argv if a.startswith("--")]
    if len(args) != 1 or any(f not in ("--apply", "--update", "--undo") for f in flags) or len(flags) > 1:
        usage("usage: patch-claude.py EXTENSION_DIR [--apply | --update | --undo]")
    if os.geteuid() == 0:
        refuse("run this as your user, not as root")
    ext = os.path.abspath(args[0])
    if os.path.islink(ext) or not os.path.isdir(ext):
        refuse("%s is not a folder (a link is refused too)" % show(ext))
    if flags == ["--apply"]:
        return apply(ext)
    if flags == ["--update"]:
        return update(ext)
    if flags == ["--undo"]:
        return undo(ext)
    name, ver, detail = state(ext)
    print("%s %s%s" % (name, ver, ": " + detail if detail else ""))
    miss = look_problem(read(os.path.join(ext, MAIN))) if name == "unpatched-patchable" else None
    if miss:
        print("warning: the panel look would be left out (%s); the folder patch would still apply." % miss)
    miss = groups_problem(read(os.path.join(ext, MAIN))) if name == "unpatched-patchable" else None
    if miss:
        print("warning: the group command would be left out (%s); the folder patch would still apply." % miss)
    if name == "patched" and marker_of(ext).get("look") is not True:
        print("warning: the panel look is not in this patch.")
    if name == "patched" and marker_of(ext).get("groups") is not True:
        print("warning: the group command is not in this patch.")
    if name == "leftovers":
        print("A backup or marker from an earlier run is here and does not match the file: run --undo.")
    if name == "outdated":
        print("Run --update: it rebuilds the patch from the backup and swaps it in.")
    return 1 if name in ("anchors-missing", "leftovers", "outdated") else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
