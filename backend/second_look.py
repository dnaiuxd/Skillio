"""
Skillio's second look at a "data is leaving" alarm.

SkillSpector flags a credential that reaches a network call, and stops there.
Its strix alarm — Critical, "credential exfiltration" — was a proxy helper
reading an address setting that defaults to 127.0.0.1. This module reads the
flagged lines itself and answers three questions in plain words:

    Takes     what the code reads (a key, or just a setting)
    Sends to  where it goes (your own computer, or the internet)
    When      what has to happen for it to run

The rule it holds to: a false alarm costs a minute, a real theft called
harmless is the one mistake this can't make. So it never hides anything, it
says "can't tell" rather than guess, and only two confident answers — "your
own computer" or "just a setting" — let an alarm move down the list. Python
is read with the `ast` module, which parses without running anything; every
other language gets what a line-level read can honestly say, and never moves.

The reading is pure: `look` gets a file's text and touches nothing else.
Getting that text is the last section — SkillSpector deletes its own copy
when it finishes, so Skillio reads the upload, the folder, or for a GitHub
link fetches just the flagged files, and checks each against the snippet
SkillSpector reported before trusting it.
"""
import ast
import ipaddress
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from typing import Optional
from urllib.parse import urlsplit

# Bump when the card's meaning changes, so a stored look can be told apart.
LOOK_VERSION = 1

DATA_LEAVING = frozenset({"data flow", "data exfiltration"})

# Name parts that mark a value as a secret. Matched against the name split on
# "_" and case, so OPENAI_API_KEY and githubToken both count. Deliberately
# broad: a wrong "secret" keeps an alarm serious, which is the safe mistake.
_SECRET_PARTS = frozenset({
    "KEY", "APIKEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PASS", "PWD",
    "CREDENTIAL", "CREDENTIALS", "CREDS", "AUTH", "COOKIE", "SESSION",
    "PRIVATE", "CERT", "BEARER", "PAT", "SIGNATURE", "SALT", "OTP",
})
# Parts that say the value is where to connect, not what to send.
_ADDRESS_PARTS = frozenset({
    "URL", "URI", "HOST", "HOSTNAME", "ENDPOINT", "ADDR", "ADDRESS", "SERVER",
    "DOMAIN", "PORT", "BASE",
})
# Other settings that are plainly not secrets. PROXY is left out on purpose:
# a proxy URL can carry user:password.
_PLAIN_PARTS = frozenset({
    "LEVEL", "DEBUG", "MODE", "REGION", "TIMEOUT", "LANG", "LOCALE", "TZ",
    "VERBOSE", "COLOR", "COLOUR", "THEME", "VERSION",
})

_URL_RE = re.compile(r"""(?:https?|wss?)://[^\s'"`<>)\]]+""")
_FLOW_RE = re.compile(r"from (.+?) \(line (\d+), ([^)]*)\)")

# Non-Python reads: a line-level guess at env reads, never used to lower.
_ENV_NAME_RES = (
    re.compile(r"process\.env\.([A-Za-z_][A-Za-z0-9_]*)"),
    re.compile(r"""process\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)"""),
    re.compile(r"""getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)"""),
    re.compile(r"""environ(?:\.get\(\s*|\[\s*)['"]([A-Za-z_][A-Za-z0-9_]*)"""),
)
_WHOLE_ENV_RE = re.compile(
    r"process\.env(?![.\[\w])|os\.environ(?![.\[\w])|os\.environ\.(?:items|copy|keys|values)\(|\benv\s*$"
)

_MAX_DEPTH = 6

UNCHECKED_REASONS = {
    "not_kept": "Skillio couldn't get a copy of this file to read.",
    "changed": (
        "Skillio's copy of this file doesn't match the code SkillSpector "
        "reported, so it won't guess."
    ),
    "too_big": "This file is too large for Skillio to read safely.",
    "ambiguous": (
        "More than one file in the skill has this name, and Skillio couldn't "
        "tell which one SkillSpector meant."
    ),
}


def applies(issue: dict) -> bool:
    return str(issue.get("category") or "").strip().lower() in DATA_LEAVING


def _parts(name: str) -> list:
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name)
    return [p for p in re.split(r"[^A-Za-z0-9]+", spaced.upper()) if p]


def name_kind(name: str) -> str:
    """secret, address, plain, or unknown — in that order of precedence."""
    parts = _parts(name)
    if any(p in _SECRET_PARTS for p in parts):
        return "secret"
    if any(p in _ADDRESS_PARTS for p in parts):
        return "address"
    if parts and parts[-1] in _PLAIN_PARTS:
        return "plain"
    return "unknown"


def _is_local_host(host: str) -> bool:
    host = host.strip("[]").lower()
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _host_of(url: str) -> Optional[str]:
    """host[:port] of a literal URL, or None when part of it is built at run
    time — "https://" followed by a placeholder has no host to read."""
    try:
        parts = urlsplit(url)
        host = parts.hostname
        port = parts.port
    except ValueError:
        return None
    if not host or "{" in parts.netloc or "$" in parts.netloc:
        return None
    return f"{host}:{port}" if port else host


class _Facts:
    def __init__(self) -> None:
        self.names: list = []        # env var names read, in order
        self.dynamic_name = False    # an env read whose name isn't a literal
        self.whole_env = False       # every env var at once
        self.urls: list = []         # (url, via_setting or None)

    def add_name(self, name: str) -> None:
        if name not in self.names:
            self.names.append(name)

    def add_url(self, url: str, via: Optional[str]) -> None:
        if (url, via) not in self.urls:
            self.urls.append((url, via))

    def merge(self, other: "_Facts") -> None:
        for n in other.names:
            self.add_name(n)
        for u in other.urls:
            self.add_url(*u)
        self.dynamic_name |= other.dynamic_name
        self.whole_env |= other.whole_env


# --- Python ------------------------------------------------------------------

def _dotted(node) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        inner = _dotted(node.value)
        return f"{inner}.{node.attr}" if inner else node.attr
    return ""


def _is_environ(node) -> bool:
    return _dotted(node) in ("os.environ", "environ")


class _Module:
    def __init__(self, text: str) -> None:
        self.tree = ast.parse(text)
        self.funcs: dict = {}
        self.consts: dict = {}
        self.stmts: list = []
        for node in ast.walk(self.tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                # Methods too, by bare name: self._url() resolves to the
                # first def called _url. Close enough to read an address.
                self.funcs.setdefault(node.name, node)
            if isinstance(node, ast.stmt):
                self.stmts.append(node)
        for node in self.tree.body:
            if isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None:
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for t in targets:
                    if isinstance(t, ast.Name):
                        self.consts[t.id] = node.value

    def stmt_at(self, line: int):
        best = None
        for s in self.stmts:
            end = getattr(s, "end_lineno", s.lineno)
            if s.lineno <= line <= end:
                # Skip a def or class: their span is the whole body, and the
                # line asked about is one statement inside it.
                if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    continue
                if best is None or (end - s.lineno) < (best.end_lineno - best.lineno):
                    best = s
        return best

    def func_at(self, line: int):
        best = None
        for f in self.funcs.values():
            if f.lineno <= line <= f.end_lineno:
                if best is None or f.lineno > best.lineno:
                    best = f
        return best

    def called_at_top_level(self, name: str) -> bool:
        for s in self.tree.body:
            if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            for n in ast.walk(s):
                if isinstance(n, ast.Call) and _dotted(n.func).split(".")[-1] == name:
                    return True
        return False

    def assignment(self, name: str, scope, before: int):
        """The last `name = ...` in scope before a line, else a module const."""
        found = None
        if scope is not None:
            for n in ast.walk(scope):
                if isinstance(n, ast.Assign) and n.lineno < before:
                    if any(isinstance(t, ast.Name) and t.id == name for t in n.targets):
                        if found is None or n.lineno > found.lineno:
                            found = n
                if isinstance(n, (ast.With, ast.AsyncWith)) and n.lineno < before:
                    for item in n.items:
                        v = item.optional_vars
                        if isinstance(v, ast.Name) and v.id == name:
                            found = ast.Assign(targets=[v], value=item.context_expr,
                                               lineno=n.lineno)
        if found is not None:
            return found.value
        return self.consts.get(name)

    def expand(self, node, scope, line: int, depth: int, seen: set, via=None) -> _Facts:
        facts = _Facts()
        if node is None or depth > _MAX_DEPTH:
            return facts

        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            for url in _URL_RE.findall(node.value):
                facts.add_url(url, via)
            return facts

        if isinstance(node, ast.JoinedStr):
            # f"https://{host}/x": the scheme is literal, the host is not.
            literal = "".join(
                v.value if isinstance(v, ast.Constant) else "{}" for v in node.values
            )
            for url in _URL_RE.findall(literal):
                facts.add_url(url, via)
            for v in node.values:
                if isinstance(v, ast.FormattedValue):
                    facts.merge(self.expand(v.value, scope, line, depth, seen, via))
            return facts

        if isinstance(node, ast.Call):
            fn = _dotted(node.func)
            if fn.endswith("environ.get") or fn.split(".")[-1] == "getenv":
                key = node.args[0] if node.args else None
                if isinstance(key, ast.Constant) and isinstance(key.value, str):
                    facts.add_name(key.value)
                    setting = key.value
                else:
                    facts.dynamic_name = True
                    setting = None
                default = node.args[1] if len(node.args) > 1 else None
                facts.merge(self.expand(default, scope, line, depth + 1, seen, setting))
                return facts
            if isinstance(node.func, ast.Attribute) and _is_environ(node.func.value):
                # os.environ.items(), .copy(), .keys() ...
                facts.whole_env = True
                return facts
            if fn in ("dict", "list") and node.args and _is_environ(node.args[0]):
                facts.whole_env = True
                return facts
            target = self.funcs.get(fn.split(".")[-1]) if fn else None
            if target is not None and target.name not in seen:
                inner_seen = seen | {target.name}
                for n in ast.walk(target):
                    if isinstance(n, ast.Return) and n.value is not None:
                        facts.merge(self.expand(n.value, target, n.lineno,
                                                depth + 1, inner_seen, via))
            for child in list(node.args) + [k.value for k in node.keywords]:
                facts.merge(self.expand(child, scope, line, depth, seen, via))
            if isinstance(node.func, ast.Attribute):
                facts.merge(self.expand(node.func.value, scope, line, depth, seen, via))
            return facts

        if isinstance(node, ast.Subscript) and _is_environ(node.value):
            key = node.slice
            if isinstance(key, ast.Constant) and isinstance(key.value, str):
                facts.add_name(key.value)
            else:
                facts.dynamic_name = True
            return facts

        if _is_environ(node):
            facts.whole_env = True
            return facts

        if isinstance(node, ast.Name):
            key = ("name", node.id, id(scope))
            if key in seen:
                return facts
            value = self.assignment(node.id, scope, line)
            if value is not None:
                facts.merge(self.expand(value, scope, getattr(value, "lineno", line),
                                        depth + 1, seen | {key}, via))
            return facts

        for child in ast.iter_child_nodes(node):
            facts.merge(self.expand(child, scope, line, depth, seen, via))
        return facts

    def facts_at(self, line: int) -> _Facts:
        stmt = self.stmt_at(line)
        if stmt is None:
            return _Facts()
        return self.expand(stmt, self.func_at(line), line, 0, frozenset())


# --- Other languages -----------------------------------------------------------

def _line_facts(lines: list, line: int) -> _Facts:
    facts = _Facts()
    if not 1 <= line <= len(lines):
        return facts
    text = lines[line - 1]
    for rx in _ENV_NAME_RES:
        for name in rx.findall(text):
            facts.add_name(name)
    if _WHOLE_ENV_RE.search(text):
        facts.whole_env = True
    for url in _URL_RE.findall(text):
        facts.add_url(url, None)
    return facts


# --- Wording -------------------------------------------------------------------

def _code(s: str) -> str:
    return f"`{s}`"


def _list(items: list) -> str:
    items = [_code(i) for i in items]
    if len(items) > 3:
        items = items[:3] + [f"{len(items) - 3} more"]
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


def _takes(facts: _Facts, kind_hint: str) -> tuple:
    """(sentence, class) where class is secret, setting, or unknown."""
    if facts.whole_env:
        return ("all of your environment settings at once, which usually "
                "includes keys and passwords."), "secret"
    if not facts.names:
        if facts.dynamic_name:
            return ("a setting whose name is worked out while the code runs, "
                    "so Skillio can't tell which."), "unknown"
        hint = f" SkillSpector calls it {kind_hint}." if kind_hint else ""
        return f"Skillio can't tell from the code.{hint}", "unknown"
    kinds = {n: name_kind(n) for n in facts.names}
    secrets = [n for n, k in kinds.items() if k == "secret"]
    if secrets:
        what = "a name" if len(secrets) == 1 else "names"
        return f"{_list(secrets)}, {what} that looks like a key or password.", "secret"
    if facts.dynamic_name:
        return (f"{_list(facts.names)}, plus a setting whose name Skillio "
                "can't read ahead of time."), "unknown"
    if all(k == "address" for k in kinds.values()):
        noun = "a setting called" if len(kinds) == 1 else "settings called"
        it = "It's an address" if len(kinds) == 1 else "They're addresses"
        return f"{noun} {_list(facts.names)}. {it}, not a password or key.", "setting"
    if all(k in ("address", "plain") for k in kinds.values()):
        noun = "a setting called" if len(kinds) == 1 else "settings called"
        return f"{noun} {_list(facts.names)}, which isn't a password or key.", "setting"
    noun = "a setting called" if len(kinds) == 1 else "settings called"
    return (f"{noun} {_list(facts.names)}. Skillio can't tell whether it holds "
            "a password or key."), "unknown"


def _sends_to(facts: _Facts, sink_known: bool) -> tuple:
    """(sentence, class, settings) — class is local, internet or unseen;
    settings are the env names a default address came from."""
    hosts = []
    for url, via in facts.urls:
        host = _host_of(url)
        if host is None:
            continue
        hosts.append((host, via))
    if not hosts:
        if sink_known:
            return ("an address the code works out while it runs, so Skillio "
                    "can't read it ahead of time."), "unseen", []
        return ("Skillio can't see it being sent anywhere from here, so it "
                "can't rule that out."), "unseen", []
    seen_hosts = list(dict.fromkeys(h for h, _ in hosts))
    settings = list(dict.fromkeys(v for _, v in hosts if v))
    by_default = " by default" if settings and all(v for _, v in hosts) else ""
    if all(_is_local_host(h.rsplit(":", 1)[0] if h.count(":") == 1 else h)
           for h in seen_hosts):
        return (f"{_list(seen_hosts)}{by_default}, which means your own computer."
                ), "local", settings
    remote = [h for h in seen_hosts
              if not _is_local_host(h.rsplit(":", 1)[0] if h.count(":") == 1 else h)]
    what = "a website" if len(remote) == 1 else "websites"
    return f"{_list(remote)}{by_default}, {what} on the internet.", "internet", settings


def _when(mod: Optional[_Module], line: int) -> str:
    if mod is None:
        return "Skillio can't tell from this kind of file."
    fn = mod.func_at(line)
    if fn is None:
        return "as soon as the skill runs."
    if mod.called_at_top_level(fn.name):
        return f"as soon as the skill runs, through {_code(fn.name + '()')}."
    return f"when {_code(fn.name + '()')} is called."


def _headline(takes: str, dest: str, sink_known: bool) -> tuple:
    """(headline, kind, lower)."""
    if dest == "local":
        if takes == "secret":
            return ("Sends a key or password to a program on your own computer",
                    "local_secret", False)
        return "Probably harmless: talks to a program on your own computer", "local", True
    if dest == "internet":
        if takes == "secret":
            return "Sends your secrets off your computer", "secret_out", False
        if takes == "setting":
            return "Probably harmless: sends a setting, not a secret", "setting", True
        if sink_known:
            return "Sends something off your computer", "out", False
        return "Talks to a website on the internet", "out", False
    if takes == "secret":
        return "Reads your secrets, and Skillio can't see where they go", "unseen", False
    if sink_known:
        return "Sends something off your computer, and Skillio can't see where", "unseen", False
    return "Skillio can't see where this goes", "unseen", False


def unchecked(reason: str) -> dict:
    return {
        "v": LOOK_VERSION,
        "kind": "unchecked",
        "headline": "Couldn't check this one",
        "detail": UNCHECKED_REASONS.get(reason, UNCHECKED_REASONS["not_kept"]),
        "lower": False,
    }


def snippet_matches(text: str, snippet: Optional[str], line: int) -> bool:
    """Does SkillSpector's snippet appear in this text near the line it named?

    The guard for a fetched copy: a repo can change between SkillSpector's
    download and Skillio's, and a card written about different code is worse
    than no card.
    """
    # SkillSpector cuts long lines short and lowercases some text in its
    # snippets ("https://BUCKET..." comes back as "https://bucket..."), so a
    # snippet line only has to START the file's line, ignoring case.
    want = [s.strip().lower() for s in (snippet or "").splitlines() if s.strip()]
    if not want:
        return False
    have = [s.strip().lower() for s in text.splitlines()]
    lo = max(0, line - 1 - len(want) - 20)
    hi = min(len(have), line + len(want) + 20)
    window = [h for h in have[lo:hi] if h]
    n = len(want)
    return any(
        all(window[i + j].startswith(want[j]) for j in range(n))
        for i in range(len(window) - n + 1)
    )


def look(issue: dict, text: str, path: str) -> dict:
    """The card for one data-leaving finding, from its file's text."""
    loc = issue.get("location") if isinstance(issue.get("location"), dict) else {}
    line = int(loc.get("start_line") or 0)
    sink_known = str(issue.get("category") or "").strip().lower() == "data flow"
    pattern = str(issue.get("pattern") or "")
    flow = _FLOW_RE.search(pattern)
    source_line = int(flow.group(2)) if flow else line
    kind_hint = flow.group(3).strip() if flow else ""

    mod = None
    if path.lower().endswith(".py"):
        try:
            mod = _Module(text)
        except (SyntaxError, ValueError, RecursionError, MemoryError):
            mod = None

    if mod is not None:
        took = mod.facts_at(source_line)
        went = mod.facts_at(line) if line != source_line else _Facts()
    else:
        lines = text.splitlines()
        took = _line_facts(lines, source_line)
        went = _line_facts(lines, line) if line != source_line else _Facts()
        # The finding text is the matched code itself — for an External
        # Transmission hit, the URL.
        literal = str(issue.get("finding") or "")
        for url in _URL_RE.findall(literal):
            went.add_url(url, None)
    if mod is not None:
        literal = str(issue.get("finding") or "")
        for url in _URL_RE.findall(literal):
            went.add_url(url, None)

    both = _Facts()
    both.merge(took)
    both.merge(went)

    takes_text, takes_class = _takes(took if (took.names or took.whole_env) else both,
                                     kind_hint)
    dest_text, dest_class, settings = _sends_to(both, sink_known)
    headline, kind, lower = _headline(takes_class, dest_class, sink_known)
    # Only Python is read closely enough to move an alarm.
    lower = lower and mod is not None

    card = {
        "v": LOOK_VERSION,
        "kind": kind,
        "headline": headline,
        "takes": takes_text,
        "sends_to": dest_text,
        "when": _when(mod, line),
        "lower": lower,
    }
    if settings:
        noun = "that setting" if len(settings) == 1 else "those settings"
        card["worth_knowing"] = (
            f"if someone changed {noun} ({_list(settings)}), it could point "
            "somewhere else."
        )
    return card


# --- Getting the files -----------------------------------------------------------

# A flagged file bigger than this is not a skill script anyone wrote by hand.
MAX_FILE_BYTES = 2 * 1024 * 1024
GIT_TIMEOUT_SECONDS = 60

_GITHUB_RE = re.compile(
    r"^https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?"
    r"(?:/tree/([^?#]+?))?/?$"
)


def _norm(path: str) -> str:
    path = path.replace("\\", "/")
    return path[2:] if path.startswith("./") else path


def _matching(names: list, path: str) -> list:
    """Names that are this path, or end with it. SkillSpector reports paths
    from the folder it scanned, which may sit below an archive's top folder
    ("strix-main/strix/x.py" is reported as "strix/x.py")."""
    path = _norm(path).lstrip("/")
    if not path:
        return []
    return [n for n in names if n == path or n.endswith("/" + path)]


def _decode(data: bytes) -> str:
    return data.decode("utf-8", errors="replace")


class _ZipFiles:
    def __init__(self, path: str) -> None:
        self.zf = zipfile.ZipFile(path)
        self.infos = {i.filename: i for i in self.zf.infolist() if not i.is_dir()}

    def candidates(self, path: str):
        names = _matching(list(self.infos), path)
        if not names:
            return "not_kept"
        out = []
        for n in names:
            # file_size is what the archive claims; read() stops a liar.
            if self.infos[n].file_size > MAX_FILE_BYTES:
                return "too_big"
            with self.zf.open(self.infos[n]) as fh:
                data = fh.read(MAX_FILE_BYTES + 1)
            if len(data) > MAX_FILE_BYTES:
                return "too_big"
            out.append(_decode(data))
        return out

    def close(self) -> None:
        self.zf.close()


class _DirFiles:
    def __init__(self, root: str) -> None:
        self.root = os.path.realpath(root)

    def candidates(self, path: str):
        full = os.path.realpath(os.path.join(self.root, _norm(path)))
        # Never outside the folder that was scanned, symlinks included.
        if os.path.commonpath([full, self.root]) != self.root or not os.path.isfile(full):
            return "not_kept"
        if os.path.getsize(full) > MAX_FILE_BYTES:
            return "too_big"
        with open(full, "rb") as fh:
            return [_decode(fh.read(MAX_FILE_BYTES + 1))]

    def close(self) -> None:
        pass


class _OneFile(_DirFiles):
    def __init__(self, path: str) -> None:
        super().__init__(os.path.dirname(os.path.abspath(path)))
        self.name = os.path.basename(path)

    def candidates(self, path: str):
        if os.path.basename(_norm(path)) != self.name:
            return "not_kept"
        return super().candidates(self.name)


def _git(args: list, cwd: str) -> subprocess.CompletedProcess:
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": cwd,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_CONFIG_NOSYSTEM": "1",
    }
    return subprocess.run(
        ["git", "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null",
         "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", *args],
        cwd=cwd, env=env, capture_output=True, timeout=GIT_TIMEOUT_SECONDS,
    )


class _GitHubFiles:
    """Just the flagged files from a GitHub link, at the branch it named.

    A shallow, blob-less fetch: the file list and nothing else, then one
    blob per flagged file. Nothing is checked out, so nothing in the repo
    runs and nothing lands on disk but git's own objects.
    """

    def __init__(self, url: str) -> None:
        m = _GITHUB_RE.match(url.strip())
        if not m:
            raise ValueError("not a GitHub repository link")
        owner, repo, tree = m.groups()
        self.dir = tempfile.mkdtemp(prefix="skillio_look_")
        remote = f"https://github.com/{owner}/{repo}.git"
        try:
            self._ok(_git(["init", "-q"], self.dir))
            self._ok(_git(["remote", "add", "origin", remote], self.dir))
            ref, sub = self._split_tree(tree) if tree else ("HEAD", "")
            self._ok(_git(["fetch", "-q", "--depth", "1", "--filter=blob:none",
                           "--no-tags", "origin", ref], self.dir))
            listing = self._ok(_git(["ls-tree", "-r", "-z", "--name-only",
                                     "FETCH_HEAD"], self.dir))
        except Exception:
            self.close()
            raise
        names = [n for n in _decode(listing.stdout).split("\0") if n]
        if sub:
            prefix = sub.rstrip("/") + "/"
            names = [n for n in names if n.startswith(prefix)]
        self.names = names

    @staticmethod
    def _ok(proc: subprocess.CompletedProcess) -> subprocess.CompletedProcess:
        if proc.returncode != 0:
            raise RuntimeError(_decode(proc.stderr)[:300])
        return proc

    def _split_tree(self, tree: str) -> tuple:
        """/tree/feature/foo/skills/x: which part is the branch? The longest
        prefix that names a real branch or tag, as SkillSpector decides it."""
        refs = self._ok(_git(["ls-remote", "--heads", "--tags", "origin"], self.dir))
        known = set()
        for line in _decode(refs.stdout).splitlines():
            name = line.split("\t", 1)[-1]
            for prefix in ("refs/heads/", "refs/tags/"):
                if name.startswith(prefix):
                    known.add(name[len(prefix):].removesuffix("^{}"))
        segs = tree.strip("/").split("/")
        for i in range(len(segs), 0, -1):
            ref = "/".join(segs[:i])
            if ref in known:
                return ref, "/".join(segs[i:])
        # A commit hash, or something ls-remote doesn't list: try the first
        # segment as the ref, as git itself would.
        return segs[0], "/".join(segs[1:])

    def candidates(self, path: str):
        names = _matching(self.names, path)
        if not names:
            return "not_kept"
        out = []
        for n in names:
            size = _git(["cat-file", "-s", f"FETCH_HEAD:{n}"], self.dir)
            if size.returncode != 0:
                return "not_kept"
            if int(_decode(size.stdout).strip() or 0) > MAX_FILE_BYTES:
                return "too_big"
            blob = _git(["cat-file", "blob", f"FETCH_HEAD:{n}"], self.dir)
            if blob.returncode != 0:
                return "not_kept"
            out.append(_decode(blob.stdout))
        return out

    def close(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)


def open_files(target: str):
    """Something to read the scanned files from, or None if Skillio can't."""
    try:
        if _GITHUB_RE.match(target.strip()):
            return _GitHubFiles(target)
        if os.path.isdir(target):
            return _DirFiles(target)
        if os.path.isfile(target):
            if zipfile.is_zipfile(target):
                return _ZipFiles(target)
            return _OneFile(target)
    except Exception:  # noqa: BLE001 - no copy is an answer, not a failure
        return None
    return None


def annotate(issues: list, target: str, opener=open_files) -> int:
    """Put a second look on every data-leaving finding. Returns how many.

    Only opens the source when there is something to look at — a GitHub
    fetch is not free, and most scans have no data-leaving finding at all.
    """
    todo = [i for i in issues if isinstance(i, dict) and applies(i)]
    if not todo:
        return 0
    files = opener(target)
    cache: dict = {}  # a file flagged ten times is fetched once
    try:
        for issue in todo:
            loc = issue.get("location") if isinstance(issue.get("location"), dict) else {}
            path = str(loc.get("file") or "")
            line = int(loc.get("start_line") or 0)
            if files is None or not path:
                issue["skillio_second_look"] = unchecked("not_kept")
                continue
            if path not in cache:
                try:
                    cache[path] = files.candidates(path)
                except Exception:  # noqa: BLE001
                    cache[path] = "not_kept"
            found = cache[path]
            if isinstance(found, str):
                issue["skillio_second_look"] = unchecked(found)
                continue
            snippet = issue.get("code_snippet")
            if snippet:
                found = [t for t in found if snippet_matches(t, snippet, line)]
                if not found:
                    issue["skillio_second_look"] = unchecked("changed")
                    continue
            elif isinstance(files, _GitHubFiles):
                # A fetched copy with nothing to check it against.
                issue["skillio_second_look"] = unchecked("changed")
                continue
            found = list(dict.fromkeys(found))  # identical copies are one file
            if len(found) > 1:
                issue["skillio_second_look"] = unchecked("ambiguous")
                continue
            try:
                issue["skillio_second_look"] = look(issue, found[0], path)
            except Exception:  # noqa: BLE001 - one odd file can't sink the scan
                issue["skillio_second_look"] = unchecked("not_kept")
    finally:
        if files is not None:
            files.close()
    return len(todo)
