"""Tests for link-extension.py. Run: /usr/bin/python3 -I tools/callboard/test_link_extension.py

Each case runs a copy of the script inside a fixture checkout under a temporary folder, against a temporary extensions
folder, so nothing in your home folder is touched."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "link-extension.py")
PY = "/usr/bin/python3"
ID = "notitial.callboard-panels"
OTHER = {"identifier": {"id": "other.ext", "uuid": "0000"}, "version": "2.0.0",
         "location": {"$mid": 1, "path": "/x/other.ext-2.0.0", "scheme": "file"},
         "relativeLocation": "other.ext-2.0.0", "metadata": {"installedTimestamp": 1, "source": "gallery"}}


def dumps(d):
    return json.dumps(d, separators=(",", ":"), ensure_ascii=False)


def entry(ver, ext, ident=ID):
    return {"identifier": {"id": ident}, "version": ver,
            "location": {"$mid": 1, "path": "%s/%s-%s" % (ext, ident, ver), "scheme": "file"},
            "relativeLocation": "%s-%s" % (ident, ver)}


def snap(root):
    """Every path under root with its link target or content, so "changes nothing" can be compared."""
    out = {}
    for d, dirs, files in os.walk(root):
        for n in dirs + files:
            p = os.path.join(d, n)
            if os.path.islink(p):
                out[p] = ("link", os.readlink(p))
            elif os.path.isfile(p):
                with open(p, "rb") as f:
                    out[p] = ("file", f.read())
            else:
                out[p] = ("dir",)
    return out


class Case(unittest.TestCase):
    def setUp(self):
        self.t = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(self.cleanup)
        self.out = ""
        self.rc = None

    def cleanup(self):
        for d, dirs, _ in os.walk(self.t):
            for n in dirs:
                os.chmod(os.path.join(d, n), 0o755)
        shutil.rmtree(self.t, ignore_errors=True)

    def fixture(self, name, version="1.2.3", publisher="notitial", pkg_name="callboard-panels"):
        """A checkout with link-extension.py and extension/package.json."""
        root = os.path.join(self.t, name)
        os.makedirs(os.path.join(root, "extension"), exist_ok=True)
        shutil.copy(SCRIPT, os.path.join(root, "link-extension.py"))
        with open(os.path.join(root, "extension", "package.json"), "w") as f:
            json.dump({"name": pkg_name, "version": version, "publisher": publisher}, f)
        return root

    def run_script(self, root, *args, running="no", env=None, plain=False):
        cmd = [PY, "-I", os.path.join(root, "link-extension.py")]
        if not plain:
            cmd += ["--vscode-running", running] if running and "--ext-dir" in args else []
        cmd += list(args)
        p = subprocess.run(cmd, capture_output=True, text=True, env=env)
        self.rc, self.out = p.returncode, p.stdout + p.stderr
        self.assertNotIn("Traceback", self.out)
        return self.rc

    def ext(self, name="ext"):
        return os.path.join(self.t, name)

    def target(self, ext, ver="1.2.3"):
        return os.path.join(ext, "%s-%s" % (ID, ver))

    def write(self, path, text):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(text)

    def read(self, path):
        with open(path) as f:
            return f.read()

    def assertRefused(self, root, ext, running="no"):
        before = snap(ext)
        self.run_script(root, "--ext-dir", ext, "--apply", running=running)
        self.assertEqual(self.rc, 1, self.out)
        self.assertEqual(snap(ext), before)


class Link(Case):
    def test_dry_run_apply_and_second_apply(self):
        c, e = self.fixture("repo"), self.ext()
        src = os.path.join(c, "extension")
        self.run_script(c, "--ext-dir", e)
        self.assertEqual(self.rc, 0)
        self.assertFalse(os.path.exists(e))
        self.assertIn("DRY: ln -s -- %s %s" % (src, self.target(e)), self.out)
        self.run_script(c, "--ext-dir", e, "--apply")
        self.assertEqual(self.rc, 0, self.out)
        self.assertEqual(os.readlink(self.target(e)), src)
        self.run_script(c, "--ext-dir", e, "--apply")
        self.assertEqual(self.rc, 0)
        self.assertIn("already linked: " + self.target(e), self.out)

    def test_version_comes_from_the_manifest_and_a_bump_replaces_the_link(self):
        c, e = self.fixture("repo"), self.ext()
        self.run_script(c, "--ext-dir", e, "--apply")
        self.write(os.path.join(e, ".obsolete"), '{"%s-1.2.3":true}' % ID)
        self.fixture("repo", "1.3.0")
        self.run_script(c, "--ext-dir", e, "--apply")
        self.assertEqual(self.rc, 0, self.out)
        self.assertEqual(os.readlink(self.target(e, "1.3.0")), os.path.join(c, "extension"))
        self.assertFalse(os.path.lexists(self.target(e)))
        self.assertEqual(self.read(os.path.join(e, "extensions.json")), dumps([entry("1.3.0", e)]))
        self.assertEqual(self.read(os.path.join(e, ".obsolete")), "{}")

    def test_the_real_script_reads_its_own_package_json(self):
        e = self.ext()
        p = subprocess.run([PY, "-I", SCRIPT, "--ext-dir", e], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertRegex(p.stdout, r"DRY: ln -s -- .*/extension %s/%s-[0-9]+\.[0-9]+\.[0-9]+\n" % (e, ID))

    def test_foreign_entries_refuse_and_change_nothing(self):
        c, e = self.fixture("repo"), self.ext()
        os.makedirs(e)
        # a real folder, a link elsewhere, a link into another checkout, an old copy in another letter case
        for name, make in (
            ("%s-1.0.0" % ID, lambda p: os.makedirs(p)),
            ("%s-9.9.9" % ID, lambda p: os.symlink("/elsewhere", p)),
            ("%s-1.0.0" % ID, lambda p: os.symlink(os.path.join(self.fixture("other"), "extension"), p)),
            ("Notitial.Callboard-Panels-0.1.0", lambda p: os.makedirs(p)),
        ):
            p = os.path.join(e, name)
            make(p)
            self.assertRefused(c, e)
            self.assertIn("%s is not a link into this checkout" % p, self.out)
            if os.path.isdir(p) and not os.path.islink(p):
                shutil.rmtree(p)
            else:
                os.unlink(p)

    def test_a_refusal_keeps_the_existing_link_and_makes_no_new_one(self):
        c, e = self.fixture("repo"), self.ext()
        self.run_script(c, "--ext-dir", e, "--apply")
        os.symlink("/elsewhere", os.path.join(e, "%s-9.9.9" % ID))
        self.fixture("repo", "1.4.0")
        self.assertRefused(c, e)
        self.assertEqual(os.readlink(self.target(e)), os.path.join(c, "extension"))
        self.assertFalse(os.path.lexists(self.target(e, "1.4.0")))

    def test_a_manifest_that_is_wrong_refuses(self):
        e = self.ext()
        for kw in ({"publisher": "someone"}, {"pkg_name": "other-name"}, {"version": "1.0.0/../x"}, {"version": "1.2"}):
            c = self.fixture("bad", **kw)
            self.run_script(c, "--ext-dir", e)
            self.assertEqual(self.rc, 1, kw)
        c = self.fixture("bad")
        self.write(os.path.join(c, "extension", "package.json"), '{"name":"callboard-panels","version":NaN}')
        self.run_script(c, "--ext-dir", e)
        self.assertEqual(self.rc, 1)

    def test_usage_errors(self):
        c, e = self.fixture("repo"), self.ext()
        for args in (("--ext-dir", "relative/dir"), ("--bogus",), ("--ext-dir",), ("--vscode-running", "no"),
                     ("--ext-dir", e, "--vscode-running", "maybe")):
            self.run_script(c, *args, plain=True)
            self.assertEqual(self.rc, 2, args)
        home = os.path.join(self.t, "home")
        env = dict(os.environ, HOME=home)
        self.run_script(c, "--vscode-running", "no", "--ext-dir", os.path.join(home, ".vscode", "extensions"), env=env, plain=True)
        self.assertEqual(self.rc, 2)
        self.assertIn("not for VS Code's own extensions folder", self.out)

    def test_an_extensions_folder_that_is_a_link_refuses(self):
        c, e = self.fixture("repo"), self.ext()
        os.makedirs(e)
        os.symlink(e, os.path.join(self.t, "ext-link"))
        for suffix in ("", "/"):
            self.run_script(c, "--ext-dir", os.path.join(self.t, "ext-link") + suffix, "--apply")
            self.assertEqual(self.rc, 1)
            self.assertEqual(os.listdir(e), [])

    def test_a_path_that_is_not_normal_still_finds_its_own_entry(self):
        c, e = self.fixture("repo"), self.ext()
        odd = e + "/./sub/.."
        self.run_script(c, "--ext-dir", odd, "--apply")
        self.assertEqual(self.rc, 0, self.out)
        self.run_script(c, "--ext-dir", odd, "--apply")
        self.assertEqual(self.rc, 0, self.out)
        self.assertIn("already linked", self.out)
        self.run_script(c, "--ext-dir", odd, "--remove", "--apply")
        self.assertEqual(json.loads(self.read(os.path.join(e, "extensions.json"))), [])

    def test_it_refuses_to_run_without_isolated_mode(self):
        c, e = self.fixture("repo"), self.ext()
        p = subprocess.run([PY, os.path.join(c, "link-extension.py"), "--ext-dir", e], capture_output=True, text=True)
        self.assertEqual(p.returncode, 2)
        self.assertFalse(os.path.exists(e))

    def test_home_must_be_absolute(self):
        c = self.fixture("repo")
        self.run_script(c, env=dict(os.environ, HOME="relative"), plain=True)
        self.assertEqual(self.rc, 1)
        self.assertIn("HOME must be an absolute path", self.out)

    def test_the_real_ps_agrees_with_the_dry_run(self):
        e = self.ext()
        p = subprocess.run([PY, "-I", SCRIPT, "--ext-dir", e], capture_output=True, text=True)
        procs = subprocess.run(["/bin/ps", "-U", str(os.getuid()), "-xo", "comm="], capture_output=True, text=True).stdout.splitlines()
        running = not procs or any(l.endswith("/Contents/MacOS/Code") for l in procs)
        self.assertEqual("VS Code is running" in p.stdout, running)


class Registry(Case):
    def setUp(self):
        super().setUp()
        self.c, self.e = self.fixture("reg"), self.ext("regext")
        self.reg, self.obs = os.path.join(self.e, "extensions.json"), os.path.join(self.e, ".obsolete")
        self.write(self.reg, dumps([OTHER]))
        self.write(self.obs, dumps({ID + "-1.0.0": True, "Notitial.Callboard-Panels-1.2.3": True, "other.ext-1.0.0": True}))

    def test_dry_run_changes_nothing_and_names_the_work(self):
        before = snap(self.e)
        self.run_script(self.c, "--ext-dir", self.e)
        self.assertEqual(self.rc, 0)
        self.assertEqual(snap(self.e), before)
        self.assertIn("DRY: register %s-1.2.3 in %s" % (ID, self.reg), self.out)
        self.assertIn("DRY: clear 2 keys in " + self.obs, self.out)

    def test_apply_writes_exactly_the_wanted_entry(self):
        self.run_script(self.c, "--ext-dir", self.e, "--apply")
        self.assertEqual(self.rc, 0, self.out)
        self.assertEqual(os.readlink(self.target(self.e)), os.path.join(self.c, "extension"))
        self.assertEqual(self.read(self.reg), dumps([OTHER, entry("1.2.3", self.e)]))
        self.assertEqual(self.read(self.obs), dumps({"other.ext-1.0.0": True}))
        self.assertEqual(self.read(self.reg + ".callboard.bak"), dumps([OTHER]))
        self.assertEqual([n for n in os.listdir(self.e) if n.startswith(".") and ".callboard-" in n], [])

    def test_nothing_to_change_writes_nothing_and_is_fine_with_vscode_running(self):
        self.run_script(self.c, "--ext-dir", self.e, "--apply")
        before = snap(self.e)
        os.chmod(self.e, 0o555)
        self.run_script(self.c, "--ext-dir", self.e, "--apply", running="yes")
        self.assertEqual(self.rc, 0, self.out)
        self.assertIn("already linked: " + self.target(self.e), self.out)
        self.assertEqual(snap(self.e), before)
        self.run_script(self.c, "--ext-dir", self.e, running="yes")
        self.assertNotIn("VS Code is running", self.out)

    def test_a_change_with_vscode_running_refuses_and_the_dry_run_says_so(self):
        self.assertRefused(self.c, self.e, running="yes")
        self.assertIn("quit it with Cmd+Q", self.out)
        self.run_script(self.c, "--ext-dir", self.e, running="yes")
        self.assertEqual(self.rc, 0)
        self.assertIn("VS Code is running: --apply will refuse", self.out)

    def test_dangling_entry_bare_link_and_metadata_are_repaired(self):
        self.write(self.reg, dumps([entry("1.0.0", self.e), OTHER]))
        self.run_script(self.c, "--ext-dir", self.e, "--apply")
        self.assertEqual(self.read(self.reg), dumps([OTHER, entry("1.2.3", self.e)]))
        os.unlink(self.reg)
        self.run_script(self.c, "--ext-dir", self.e, "--apply")
        self.assertEqual((self.rc, self.read(self.reg)), (0, dumps([entry("1.2.3", self.e)])))
        with_meta = dict(entry("1.2.3", self.e), metadata={"installedTimestamp": 5})
        self.write(self.reg, dumps([with_meta]))
        self.run_script(self.c, "--ext-dir", self.e, "--apply")
        self.assertEqual(self.read(self.reg), dumps([entry("1.2.3", self.e)]))

    def test_a_fresh_machine_with_no_extensions_folder(self):
        fe = os.path.join(self.t, "fresh", "ext")
        self.run_script(self.c, "--ext-dir", fe, "--apply")
        self.assertEqual(self.rc, 0, self.out)
        self.assertEqual(os.readlink(self.target(fe)), os.path.join(self.c, "extension"))
        self.assertEqual(self.read(os.path.join(fe, "extensions.json")), dumps([entry("1.2.3", fe)]))
        self.assertFalse(os.path.exists(os.path.join(fe, ".obsolete")))

    def test_refusals_change_nothing_and_name_the_file(self):
        cases = {
            "malformed-registry": ("extensions.json", "[{", "not valid JSON"),
            "registry-object": ("extensions.json", "{}", "not a JSON list"),
            "registry-item": ("extensions.json", "[1]", "not an object"),
            "registry-link": ("extensions.json", None, "is a link"),
            "obsolete-malformed": (".obsolete", "nope", "not valid JSON"),
            "obsolete-list": (".obsolete", "[]", "not a JSON object"),
            "obsolete-link": (".obsolete", None, "is a link"),
            "foreign-location": ("extensions.json", dumps([{"identifier": {"id": "Notitial.Callboard-Panels"}, "version": "1.0.0",
                                                           "location": {"$mid": 1, "path": "/elsewhere/x", "scheme": "file"}}]), "which is not"),
            "foreign-no-location": ("extensions.json", dumps([{"identifier": {"id": ID}, "version": "1.0.0"}]), "(no location)"),
            "nan": ("extensions.json", '[{"identifier":{"id":"x"},"n":NaN}]', "not valid JSON"),
            "backup-is-a-folder": ("extensions.json.callboard.bak", "DIR", "is not a regular file"),
        }
        for name, (fname, content, part) in cases.items():
            with self.subTest(name):
                d = os.path.join(self.t, "ref-" + name)
                os.makedirs(d)
                p = os.path.join(d, fname)
                if content is None:
                    os.symlink("/elsewhere", p)
                elif content == "DIR":
                    self.write(os.path.join(d, "extensions.json"), "[]")
                    os.mkdir(p)
                else:
                    self.write(p, content)
                self.assertRefused(self.c, d)
                self.assertIn(part, self.out)
                self.assertIn(os.path.join(d, fname.replace(".callboard.bak", "")), self.out)
        d = os.path.join(self.t, "refdir")
        os.makedirs(os.path.join(d, "extensions.json"))
        self.assertRefused(self.c, d)

    def test_a_string_that_cannot_be_written_back_refuses_before_the_link(self):
        d = os.path.join(self.t, "sur")
        os.makedirs(d)
        with open(os.path.join(d, "extensions.json"), "w") as f:
            f.write('[{"identifier":{"id":"x"},"n":"\\ud800"}]')
        self.assertRefused(self.c, d)
        self.assertIn("can't be written as JSON", self.out)

    def test_a_path_from_a_file_is_printed_escaped(self):
        d = os.path.join(self.t, "esc")
        self.write(os.path.join(d, "extensions.json"), '[{"identifier":{"id":"%s"},"version":"1.0.0","location":{"$mid":1,"path":"/a\\u001b[31mb","scheme":"file"}}]' % ID)
        self.assertRefused(self.c, d)
        self.assertIn("\\u001b[31mb", self.out)
        self.assertNotIn("\x1b", self.out)

    def test_the_first_backup_is_kept(self):
        d = os.path.join(self.t, "bak")
        self.write(os.path.join(d, "extensions.json"), dumps([OTHER]))
        self.run_script(self.c, "--ext-dir", d, "--apply")
        self.fixture("reg", "1.4.0")
        self.run_script(self.c, "--ext-dir", d, "--apply")
        self.assertEqual(self.rc, 0, self.out)
        self.assertEqual(self.read(os.path.join(d, "extensions.json.callboard.bak")), dumps([OTHER]))

    def test_an_entry_in_another_letter_case_and_an_odd_name(self):
        d = os.path.join(self.t, "case")
        self.write(os.path.join(d, "extensions.json"), dumps([entry("1.0.0", d, "Notitial.Callboard-Panels")]))
        os.symlink(os.path.join(self.c, "extension"), os.path.join(d, "Notitial.Callboard-Panels-1.0.0"))
        self.run_script(self.c, "--ext-dir", d, "--apply")
        self.assertEqual(self.rc, 0, self.out)
        self.assertEqual(self.read(os.path.join(d, "extensions.json")), dumps([entry("1.2.3", d)]))
        self.assertFalse(os.path.lexists(os.path.join(d, "Notitial.Callboard-Panels-1.0.0")))
        for name, where in (("odd-outside", "/elsewhere/ext/some-copy"), ("odd-inside", None)):
            od = os.path.join(self.t, name)
            path = where or os.path.join(od, "some-copy")
            self.write(os.path.join(od, "extensions.json"),
                       dumps([{"identifier": {"id": ID}, "version": "1.0.0", "location": {"$mid": 1, "path": path, "scheme": "file"}}]))
            self.assertRefused(self.c, od)
            self.assertIn("x.y.z", self.out)
        self.run_script(self.c, "--ext-dir", od, "--remove", "--apply")
        self.assertEqual(self.rc, 0)
        self.assertIn("left alone (an entry of %s that is not ours): %s" % (ID, path), self.out)
        self.assertEqual(len(json.loads(self.read(os.path.join(od, "extensions.json")))), 1)


class Remove(Case):
    def setUp(self):
        super().setUp()
        self.m, self.me = self.fixture("rm"), self.ext("rmext")
        self.run_script(self.m, "--ext-dir", self.me, "--apply")
        self.foreign_link = os.path.join(self.me, "%s-9.9.9" % ID)
        os.symlink("/elsewhere", self.foreign_link)
        self.write(os.path.join(self.me, "extensions.json"), dumps([
            OTHER, entry("1.2.3", self.me), entry("9.9.9", self.me),
            {"identifier": {"id": ID}, "version": "0.5.0", "location": {"$mid": 1, "path": "/outside/x", "scheme": "file"}}]))
        self.write(os.path.join(self.me, ".obsolete"), dumps({ID + "-0.9.0": True, ID + "-9.9.9": True, "other.ext-1.0.0": True}))

    def test_dry_run_changes_nothing(self):
        before = snap(self.me)
        self.run_script(self.m, "--ext-dir", self.me, "--remove")
        self.assertEqual(self.rc, 0)
        self.assertEqual(snap(self.me), before)
        self.assertIn("DRY: unregister 1 entry of " + ID, self.out)
        self.assertIn("DRY: clear 1 key in", self.out)

    def test_with_vscode_running_it_refuses(self):
        before = snap(self.me)
        self.run_script(self.m, "--ext-dir", self.me, "--remove", "--apply", running="yes")
        self.assertEqual(self.rc, 1)
        self.assertEqual(snap(self.me), before)

    def test_remove_takes_ours_and_leaves_the_foreign_link_and_its_entry(self):
        self.run_script(self.m, "--ext-dir", self.me, "--remove", "--apply")
        self.assertEqual(self.rc, 0, self.out)
        self.assertFalse(os.path.lexists(self.target(self.me)))
        self.assertEqual(os.readlink(self.foreign_link), "/elsewhere")
        versions = [e["version"] for e in json.loads(self.read(os.path.join(self.me, "extensions.json")))]
        self.assertEqual(versions, ["2.0.0", "9.9.9", "0.5.0"])
        self.assertIn("left alone (an entry of %s that is not ours): /outside/x" % ID, self.out)
        self.assertIn("left alone (not a link into this checkout): " + self.foreign_link, self.out)
        self.assertEqual(self.read(os.path.join(self.me, ".obsolete")), dumps({ID + "-9.9.9": True, "other.ext-1.0.0": True}))
        self.assertTrue(os.path.isfile(os.path.join(self.me, "extensions.json.callboard.bak")))
        before = snap(self.me)
        self.run_script(self.m, "--ext-dir", self.me, "--remove", "--apply", running="yes")
        self.assertEqual(self.rc, 0)
        self.assertEqual(snap(self.me), before)

    def test_a_registry_only_change_with_vscode_running_refuses(self):
        rg = self.ext("regonly")
        self.write(os.path.join(rg, "extensions.json"), dumps([entry("1.2.3", rg)]))
        before = snap(rg)
        self.run_script(self.m, "--ext-dir", rg, "--remove", "--apply", running="yes")
        self.assertEqual(self.rc, 1)
        self.assertEqual(snap(rg), before)

    def test_a_malformed_registry_keeps_the_link(self):
        os.unlink(self.foreign_link)
        self.write(os.path.join(self.me, "extensions.json"), "[{")
        self.run_script(self.m, "--ext-dir", self.me, "--remove", "--apply")
        self.assertEqual(self.rc, 1)
        self.assertTrue(os.path.islink(self.target(self.me)))


if __name__ == "__main__":
    unittest.main()
