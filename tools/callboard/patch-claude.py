"""Lets callboard open a Claude Code panel in any folder of a multi-folder VS Code window. Checks unless --apply or --undo.

  /usr/bin/python3 -I patch-claude.py EXTENSION_DIR [--apply | --undo]
      EXTENSION_DIR is one installed Claude Code extension folder, for example ~/.vscode/extensions/anthropic.claude-code-<version>-<platform>.
      No flag: change nothing and print one line, the state and the extension's version, then what it means:
        patched                  the patch is in and its marker matches the file
        unpatched-patchable      every anchor was found exactly once: --apply would patch it
        anchors-missing <names>  an update moved the code the patch hooks into (a name is missing or matches twice): --apply refuses
      --apply: patch extension.js, keep the original beside it as extension.js.callboard-orig and write callboard-cwd-patch.json
      (the marker callboard's panels extension reads). Patched already: says so and stops. A window reload (Developer: Reload
      Window) loads it.
      --undo: put the original back from the backup and remove the backup and the marker.

The patch gives `claude-vscode.editor.open` a `cwd` in its sixth argument ({cwd: folder}), which becomes the working folder of the
new panel instead of the window's first folder (4 edits, 5 names). Each anchor is a pattern that tolerates renamed minified
identifiers, and the file is written only when every anchor matches exactly once: otherwise nothing changes and the missing ones
are named. There is no half patch: a failure after the file was replaced puts the backup back. An update of the extension is a new
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
     lambda m: m.group(1) + b"," + NAME + b"){" + m.group(2) + NAME + b"?[" + NAME + b"]:" + m.group(3) + b")"),
    ("editor.open command",
     rb'("claude-vscode\.editor\.open",async\((?P<args>(?:ID,){4}ID),(?P<opt>ID)\)=>\{[\s\S]{0,1500}?\.createPanel\((?P=args),ID\.focusInput)\)'.replace(b"ID", ID),
     lambda m: m.group(1) + b",void 0,!1,typeof " + m.group("opt") + b'?.cwd=="string"?' + m.group("opt") + b".cwd:void 0)"),
)
EDITS = 5  # occurrences of NAME the four anchors add


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
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
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
    raw = read(os.path.join(ext, MARKER))
    if raw is None:
        return None
    try:
        m = json.loads(raw.decode("utf-8"))
    except ValueError:
        refuse("%s is not valid JSON; reinstall the extension (an update is a fresh folder)" % MARKER)
    if not isinstance(m, dict) or m.get("patch") != PATCH or not all(isinstance(m.get(k), str) for k in ("original_sha256", "patched_sha256")):
        refuse("%s is not this script's marker; reinstall the extension (an update is a fresh folder)" % MARKER)
    return m


def problems(raw):
    """What stops a patch: a label per anchor that matches nothing or more than once. [] means every anchor matches exactly once."""
    out = []
    if NAME in raw:
        out.append("the file already contains %s" % NAME.decode())
    for label, pat, _ in ANCHORS:
        n = len(re.findall(pat, raw))
        if n != 1:
            out.append("%s (%s)" % (label, "no match" if n == 0 else "%d matches" % n))
    return out


def patched(raw):
    for _, pat, rep in ANCHORS:
        raw = re.sub(pat, rep, raw)
    if raw.count(NAME) != EDITS:
        refuse("internal check failed: the patch would not carry %d edits; nothing was changed" % EDITS)
    return raw


def state(ext):
    """(name, version, detail). Reads only."""
    ver = version(ext)
    raw = read(os.path.join(ext, MAIN))
    if raw is None:
        refuse("%s has no %s" % (show(ext), MAIN))
    m = marker_of(ext)
    if m is not None and m["patched_sha256"] == digest(raw):
        return "patched", ver, ""
    left = [n for n in (MARKER, BACKUP) if os.path.lexists(os.path.join(ext, n))]
    if left:
        return "leftovers", ver, ", ".join(left)
    bad = problems(raw)
    return ("anchors-missing", ver, "; ".join(bad)) if bad else ("unpatched-patchable", ver, "")


def apply(ext):
    name, ver, detail = state(ext)
    if name == "patched":
        print("already patched %s" % ver)
        return 0
    if name == "leftovers":
        refuse("%s from an earlier run is in %s but does not match the file; run --undo first" % (detail, show(ext)))
    if name == "anchors-missing":
        print("anchors-missing %s: %s" % (ver, detail))
        print("Nothing was changed. The extension's code moved; the patterns in this script need a repair.")
        return 1
    main = os.path.join(ext, MAIN)
    raw = read(main)
    new = patched(raw)
    mode = os.stat(main).st_mode & 0o777
    try:
        put(os.path.join(ext, BACKUP), raw, mode)
        put(main, new, mode)
        put(os.path.join(ext, MARKER), json.dumps({"patch": PATCH, "version": ver, "original_sha256": digest(raw), "patched_sha256": digest(new)}).encode() + b"\n", 0o644)
        if read(main) != new:
            raise OSError("the file read back differs")
    except BaseException as e:
        # Back to the original, whatever was written: the backup holds it.
        put(main, raw, mode)
        for n in (BACKUP, MARKER):
            if os.path.lexists(os.path.join(ext, n)):
                os.unlink(os.path.join(ext, n))
        refuse("could not patch (%s); the original is back and nothing is left over" % (e.strerror if isinstance(e, OSError) and e.strerror else type(e).__name__))
    print("patched %s" % ver)
    print("Changed: %s (backup: %s, marker: %s, all in %s)" % (MAIN, BACKUP, MARKER, show(ext)))
    print("Reload the VS Code window (Developer: Reload Window) to load it. Undo: run this with --undo.")
    return 0


def undo(ext):
    version(ext)
    main = os.path.join(ext, MAIN)
    m = marker_of(ext)
    orig = read(os.path.join(ext, BACKUP))
    if orig is None and m is None:
        print("nothing to undo")
        return 0
    if orig is not None and m is not None and digest(orig) != m["original_sha256"]:
        refuse("%s does not match the marker's recorded original; left alone. Reinstall the extension instead" % BACKUP)
    raw = read(main)
    if orig is None:
        if raw is None or digest(raw) != m["original_sha256"]:
            refuse("the backup is gone and %s is not the original; reinstall the extension instead" % MAIN)
    elif raw != orig:
        put(main, orig, os.stat(main).st_mode & 0o777)
    for n in (BACKUP, MARKER):
        if os.path.lexists(os.path.join(ext, n)):
            os.unlink(os.path.join(ext, n))
    print("undone: the original %s is back, backup and marker removed" % MAIN)
    print("Reload the VS Code window to load it.")
    return 0


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    flags = [a for a in argv if a.startswith("--")]
    if len(args) != 1 or any(f not in ("--apply", "--undo") for f in flags) or len(flags) > 1:
        usage("usage: patch-claude.py EXTENSION_DIR [--apply | --undo]")
    if os.geteuid() == 0:
        refuse("run this as your user, not as root")
    ext = os.path.abspath(args[0])
    if os.path.islink(ext) or not os.path.isdir(ext):
        refuse("%s is not a folder (a link is refused too)" % show(ext))
    if flags == ["--apply"]:
        return apply(ext)
    if flags == ["--undo"]:
        return undo(ext)
    name, ver, detail = state(ext)
    print("%s %s%s" % (name, ver, ": " + detail if detail else ""))
    if name == "leftovers":
        print("A backup or marker from an earlier run is here and does not match the file: run --undo.")
    return 1 if name in ("anchors-missing", "leftovers") else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
