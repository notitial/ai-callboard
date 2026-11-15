"""Links the callboard panels extension into VS Code from this checkout and registers it. Dry run unless --apply.

  /usr/bin/python3 -I link-extension.py [--apply]
      make ~/.vscode/extensions/notitial.callboard-panels-<version> a link to this checkout's extension/ folder, and
      give it an entry in VS Code's extensions.json (no metadata)
  /usr/bin/python3 -I link-extension.py --remove [--apply]
      remove every notitial.callboard-panels-* link into this checkout, this id's entries inside the extensions folder
      and its .obsolete keys

The version comes from extension/package.json and stays fixed: VS Code loads the extension's code from this checkout at
each start of its extension host, so a pull plus a window reload is an update and this script runs once per machine.
VS Code caches the manifest, though: a change to package.json other than the code needs a version bump, and then this
script again (a link into this checkout under another version's name is replaced). A real folder, or a link to anywhere
else, under any notitial.callboard-panels-* name is never touched: the script stops and names it, so an old copy can't
shadow the link.
VS Code deletes, at each start, every extension folder that extensions.json doesn't list, so the link alone does not
survive a restart. The entry carries no metadata, which keeps VS Code from deleting through the link. The files are
VS Code's own: the script refuses a linked or malformed one and keeps the first old copy as <name>.callboard.bak. It also
clears this id's keys in .obsolete. A change needs VS Code quit (Cmd+Q): with it running, --apply refuses and changes
nothing. Nothing to change is fine with VS Code open. Run it as your user: it refuses root, never uses sudo and
changes no setting. Start VS Code afterwards.
--ext-dir and --vscode-running yes|no are for the tests. Tests: /usr/bin/python3 -I tools/callboard/test_link_extension.py
Exit codes: 0 done (or nothing to do), 1 refused, 2 usage.
"""
import argparse
import json
import os
import re
import stat
import subprocess
import sys
import tempfile

ID = "notitial.callboard-panels"
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
ENTRY_NAME = re.compile(re.escape(ID) + r"-[0-9]+\.[0-9]+\.[0-9]+", re.IGNORECASE)


def refuse(msg):
    print("link-extension: " + msg, file=sys.stderr)
    sys.exit(1)


def usage(msg):
    print("link-extension: " + msg, file=sys.stderr)
    sys.exit(2)


def norm(p):
    return os.path.normpath(p).lower()


def show(p):
    # A path from a file is printed escaped when it holds control characters, so it can't drive the terminal.
    return p if p.isprintable() else json.dumps(p)


def plural(n, one, many):
    return one if n == 1 else many


def no_constants(c):
    raise ValueError("constant " + c)


def read_json(raw):
    return json.loads(raw.decode("utf-8"), parse_constant=no_constants)


def read_manifest(path):
    if os.path.islink(path) or not os.path.isfile(path):
        refuse("%s is missing or not a regular file" % path)
    try:
        with open(path, "rb") as f:
            data = read_json(f.read())
    except (OSError, ValueError, RecursionError):
        refuse("%s is not valid JSON" % path)
    if not isinstance(data, dict):
        refuse("%s is not a JSON object" % path)
    for key, want in (("publisher", "notitial"), ("name", "callboard-panels")):
        if data.get(key) != want:
            refuse("extension/package.json %s must be %s" % (key, want))
    ver = data.get("version")
    if not isinstance(ver, str) or not VERSION.fullmatch(ver):
        refuse("extension/package.json version must look like 1.2.3 (got %r)" % (ver,))
    return ver


def load(path, kind, what):
    """(data, raw bytes, mode), or (None, None, None) when the file is missing. Never through a link."""
    if os.path.islink(path):
        refuse("%s is a link; refusing to work through it" % path)
    if not os.path.lexists(path):
        return None, None, None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as e:
        refuse("cannot open %s without following a link (%s)" % (path, e.strerror))
    with os.fdopen(fd, "rb") as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode):
            refuse("%s is not a regular file" % path)
        raw = f.read()
    try:
        data = read_json(raw)
    except (ValueError, RecursionError) as e:
        refuse("%s is not valid JSON (%s); fix or remove it yourself, then run this again" % (path, type(e).__name__))
    if not isinstance(data, kind):
        refuse("%s is not a JSON %s; fix or remove it yourself, then run this again" % (path, what))
    return data, raw, st.st_mode & 0o777


def put(path, content, perm):
    """Temp file in the same folder (mkstemp: new, 0600), then a rename over the target. Never writes through a link."""
    d, base = os.path.split(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix="." + base + ".callboard-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, perm)
        os.replace(tmp, path)
    except BaseException:
        if os.path.lexists(tmp):
            os.unlink(tmp)
        raise


def vscode_running(override):
    """True when VS Code's main process is up (this user's processes). A ps that fails or prints nothing counts as running."""
    if override:
        return override == "yes"
    try:
        out = subprocess.run(["/bin/ps", "-U", str(os.getuid()), "-xo", "comm="], capture_output=True, text=True, errors="replace", timeout=20)
    except (OSError, subprocess.SubprocessError):
        return True
    lines = out.stdout.splitlines() if out.returncode == 0 else []
    return not lines or any(l.endswith("/Contents/MacOS/Code") for l in lines)


def entry_id(e):
    i = e.get("identifier")
    v = i.get("id") if isinstance(i, dict) else None
    return v.lower() if isinstance(v, str) else None


def entry_path(e):
    loc = e.get("location")
    p = loc.get("path") if isinstance(loc, dict) else None
    return p if isinstance(p, str) else None


def plan_registry(ext_dir, removing, ver, target, foreign, prefix):
    """Validate VS Code's extensions.json and .obsolete and plan their change.
    Returns (lines to print, [(path, new bytes, old bytes, old mode)])."""
    reg_path = os.path.join(ext_dir, "extensions.json")
    obs_path = os.path.join(ext_dir, ".obsolete")
    reg, reg_raw, reg_mode = load(reg_path, list, "list")
    obs, obs_raw, obs_mode = load(obs_path, dict, "object")
    for f in (reg_path, obs_path):
        b = f + ".callboard.bak"
        if os.path.islink(b) or (os.path.lexists(b) and not os.path.isfile(b)):
            refuse("%s is not a regular file; remove it yourself, then run this again" % b)
    if reg is not None and any(not isinstance(e, dict) for e in reg):
        refuse("%s holds an item that is not an object; fix or remove it yourself, then run this again" % reg_path)
    idl = ID.lower()
    foreign_l = {norm(p) for p in foreign}
    lines = []
    new_reg = None
    keep, drop = [], []
    for e in reg or []:
        if entry_id(e) != idl:
            keep.append(e)
            continue
        p = entry_path(e)
        shown = show(p) if p is not None else "(no location)"
        # An entry this script may replace: directly in the extensions folder, named <id>-x.y.z.
        ours = (p is not None and os.path.dirname(os.path.normpath(p)).lower() == ext_dir.lower()
                and ENTRY_NAME.fullmatch(os.path.basename(os.path.normpath(p))) is not None)
        if not ours or norm(p) in foreign_l:
            if not removing:
                refuse("%s has an entry for %s at %s, which is not %s/%s-x.y.z; remove it yourself, then run this again"
                       % (reg_path, ID, shown, ext_dir, ID))
            lines.append("left alone (an entry of %s that is not ours): %s" % (ID, shown))
            keep.append(e)
        else:
            drop.append(e)
    if removing:
        if drop:
            new_reg = keep
            lines.append("%sunregister %d %s of %s in %s" % (prefix, len(drop), plural(len(drop), "entry", "entries"), ID, reg_path))
    else:
        wanted = {
            "identifier": {"id": ID},
            "version": ver,
            "location": {"$mid": 1, "path": os.path.normpath(target), "scheme": "file"},
            "relativeLocation": "%s-%s" % (ID, ver),
        }
        if not (len(drop) == 1 and drop[0] == wanted):
            new_reg = keep + [wanted]
            extra = " (replacing %d other %s)" % (len(drop), plural(len(drop), "entry", "entries")) if drop else ""
            lines.append("%sregister %s-%s in %s%s" % (prefix, ID, ver, reg_path, extra))
    new_obs = None
    if obs is not None:
        gone = [k for k in obs if k.lower().startswith(idl + "-")
                and not (removing and norm(os.path.join(ext_dir, k)) in foreign_l)]
        if gone:
            new_obs = {k: v for k, v in obs.items() if k not in gone}
            lines.append("%sclear %d %s in %s" % (prefix, len(gone), plural(len(gone), "key", "keys"), obs_path))
    writes = []
    try:
        for path, data, raw, mode in ((reg_path, new_reg, reg_raw, reg_mode), (obs_path, new_obs, obs_raw, obs_mode)):
            if data is not None:
                out = json.dumps(data, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
                writes.append((path, out, raw, mode))
    except (ValueError, RecursionError) as e:
        refuse("the new content for %s can't be written as JSON (%s)" % (ext_dir, type(e).__name__))
    if writes and os.path.isdir(ext_dir) and not os.access(ext_dir, os.W_OK | os.X_OK):
        refuse("%s is not writable" % ext_dir)
    return lines, writes


def write_registry(writes):
    try:
        for path, content, old_raw, old_mode in writes:
            if old_raw is not None and not os.path.lexists(path + ".callboard.bak"):
                # The first backup is kept: it is the file as VS Code left it, before this script ever touched it.
                put(path + ".callboard.bak", old_raw, old_mode)
            put(path, content, old_mode if old_mode is not None else 0o644)
    except OSError as e:
        refuse("could not write under %s (%s); check the folder, then run this again" % (os.path.dirname(path), e))


def main(argv):
    ap = argparse.ArgumentParser(prog="link-extension.py", add_help=True, allow_abbrev=False)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--remove", action="store_true")
    ap.add_argument("--ext-dir")
    ap.add_argument("--vscode-running", choices=("yes", "no"))
    args = ap.parse_args(argv)
    if not sys.flags.isolated:
        usage("run it as /usr/bin/python3 -I link-extension.py, so no module or startup file of yours is loaded")
    apply_ = args.apply
    prefix = "" if apply_ else "DRY: "

    if os.getuid() == 0:
        refuse("run it as your user, not as root")
    if args.ext_dir is None:
        if args.vscode_running:
            usage("--vscode-running is only for the tests, with --ext-dir")
        home = os.environ.get("HOME", "")
        if not os.path.isabs(home):
            refuse("HOME must be an absolute path")
        ext_dir = os.path.join(home, ".vscode", "extensions")
    else:
        ext_dir = args.ext_dir
        if not os.path.isabs(ext_dir):
            usage("--ext-dir must be absolute")
    ext_dir = os.path.normpath(ext_dir)
    if args.vscode_running and ext_dir == os.path.join(os.environ.get("HOME", "/nonexistent"), ".vscode", "extensions"):
        usage("--vscode-running is only for the tests, not for VS Code's own extensions folder")
    if os.path.islink(ext_dir):
        refuse("%s is a link; refusing to work through it" % ext_dir)

    src = os.path.join(os.path.dirname(os.path.realpath(__file__)), "extension")
    ver = read_manifest(os.path.join(src, "package.json"))
    target = os.path.join(ext_dir, "%s-%s" % (ID, ver))

    def ours(p):
        return os.path.islink(p) and os.readlink(p) == src

    # Case-insensitive, as APFS and VS Code's extension ids are: an old copy in another letter case could shadow the link.
    try:
        names = sorted(n for n in os.listdir(ext_dir) if n.lower().startswith(ID.lower() + "-"))
    except FileNotFoundError:
        names = []
    entries = [os.path.join(ext_dir, n) for n in names]

    def guard():
        # Called only when something would change.
        if vscode_running(args.vscode_running):
            if apply_:
                refuse("VS Code is running and would undo or lose the change: quit it with Cmd+Q, then run this from Terminal (not from VS Code's terminal)")
            print("VS Code is running: --apply will refuse until you quit it with Cmd+Q")

    def act(what, fn):
        if apply_:
            fn()
        else:
            print("DRY: " + what)

    if args.remove:
        mine = [e for e in entries if ours(e)]
        foreign = [e for e in entries if not ours(e)]
        for e in foreign:
            print("left alone (not a link into this checkout): " + e)
        lines, writes = plan_registry(ext_dir, True, ver, target, foreign, prefix)
        if mine or writes:
            guard()
        for l in lines:
            print(l)
        for e in mine:
            act("rm -- " + e, lambda e=e: os.unlink(e))
        if apply_:
            write_registry(writes)
            print("removed %d link(s) into %s" % (len(mine), src))
        else:
            print("would remove %d link(s) into %s" % (len(mine), src))
            if mine or writes:
                print("dry run only; add --apply to remove")
        return

    # Check everything before changing anything, so a refusal leaves the folder and VS Code's files as they were.
    stale, already = [], False
    for e in entries:
        if not ours(e):
            refuse("%s is not a link into this checkout (an old copy, or a link elsewhere); remove it yourself, then run this again" % e)
        if e == target:
            already = True
        else:
            stale.append(e)
    lines, writes = plan_registry(ext_dir, False, ver, target, [], prefix)
    need = not already or bool(stale) or bool(writes)
    if need:
        guard()
    for l in lines:
        print(l)
    if not os.path.isdir(ext_dir):
        act("mkdir -p -- " + ext_dir, lambda: os.makedirs(ext_dir, exist_ok=True))
    # The registry first: a failed write then leaves no link yet, and a dangling entry is replaced by the next run. The
    # other order could leave a bare link, the state this script exists to prevent.
    if apply_:
        write_registry(writes)
    for e in stale:
        act("rm -- " + e, lambda e=e: os.unlink(e))
    if already:
        print("already linked: %s -> %s" % (target, src))
    else:
        def link():
            os.symlink(src, target)
            if not ours(target):
                refuse("the link at %s did not come out as expected" % target)
            print("linked: %s -> %s" % (target, src))
        act("ln -s -- %s %s" % (src, target), link)
    if need:
        print("start VS Code to load version " + ver if apply_ else "dry run only; add --apply to link")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except OSError as e:
        refuse("%s: %s" % (type(e).__name__, e))
