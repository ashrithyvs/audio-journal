"""Independent journal.organize@1 vector verifier (docs/journal-organize.md).

Written from the contract text, not ported from the Node generator, the app,
or the node companion. It interprets the pinned JSON Schema files with its
own small Draft 7 checker (only the keywords the schemas use, with UTF-16
string lengths as the contract requires), then applies the cross-field rules
of contract §6 and §6.1 in their normative order. Every vector must reach its
recorded verdict and sub-code; envelope sizes, request keys, and file digests
are recomputed.

Usage: python3 -I verify_vectors.py <schemas/journal/v1 directory>
       python3 -I verify_vectors.py <dir> --results <file with {cases: [{fixture, result}]}>
"""

import base64
import hashlib
import hmac
import json
import re
import sys
import unicodedata
from pathlib import Path

KINDS = ["summary", "sections", "tasks", "ideas", "people", "projects"]
LISTS = ["tasks", "ideas", "people", "projects"]
MAX_DEPTH = 8


class Reject(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


# ------------------------------------------------------------- JSON helpers


def parse_strict(data: bytes):
    """UTF-8, no duplicate keys, no trailing data."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("utf8")

    def pairs(items):
        out = {}
        for key, value in items:
            if key in out:
                raise ValueError("duplicate key")
            out[key] = value
        return out

    return json.loads(text, object_pairs_hook=pairs)


def esc(s: str) -> str:
    out = ['"']
    for ch in s:
        o = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif o < 0x20 or 0xD800 <= o <= 0xDFFF:
            out.append("\\u%04x" % o)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def utf16_units(s: str):
    units = []
    for ch in s:
        o = ord(ch)
        if o > 0xFFFF:
            o -= 0x10000
            units.append(0xD800 + (o >> 10))
            units.append(0xDC00 + (o & 0x3FF))
        else:
            units.append(o)
    return units


def key_order(k: str):
    return utf16_units(k)


def canonical(v) -> str:
    if isinstance(v, dict):
        keys = sorted(v.keys(), key=key_order)
        return "{" + ",".join(esc(k) + ":" + canonical(v[k]) for k in keys) + "}"
    if isinstance(v, list):
        return "[" + ",".join(canonical(x) for x in v) + "]"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if v is None:
        return "null"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if v.is_integer():
            return str(int(v))
        return repr(v)
    return esc(v)


def nbytes(v) -> int:
    # surrogatepass: lone surrogates are already escaped by esc().
    return len(canonical(v).encode("utf-8", "surrogatepass"))


def sha256_text(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8", "surrogatepass")).hexdigest()


def depth(v) -> int:
    if isinstance(v, dict):
        return 1 + max((depth(x) for x in v.values()), default=0)
    if isinstance(v, list):
        return 1 + max((depth(x) for x in v), default=0)
    return 0


def len16(s: str) -> int:
    return len(utf16_units(s))


# ------------------------------------------------------------- Draft 7 subset


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def check_schema(schema, v) -> bool:
    if "const" in schema and not (v == schema["const"] and type(v) is type(schema["const"])):
        return False
    if "enum" in schema and not any(v == e and type(v) is type(e) for e in schema["enum"]):
        return False
    if "oneOf" in schema:
        if sum(1 for s in schema["oneOf"] if check_schema(s, v)) != 1:
            return False
    t = schema.get("type")
    if t == "object":
        if not isinstance(v, dict):
            return False
        for r in schema.get("required", []):
            if r not in v:
                return False
        props = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            if any(k not in props for k in v):
                return False
        if "minProperties" in schema and len(v) < schema["minProperties"]:
            return False
        for k, sub in props.items():
            if k in v and not check_schema(sub, v[k]):
                return False
    elif t == "array":
        if not isinstance(v, list):
            return False
        if len(v) < schema.get("minItems", 0) or len(v) > schema.get("maxItems", 10**9):
            return False
        if schema.get("uniqueItems"):
            seen = [canonical(x) for x in v]
            if len(set(seen)) != len(seen):
                return False
        if "items" in schema and not all(check_schema(schema["items"], x) for x in v):
            return False
    elif t == "string":
        if not isinstance(v, str):
            return False
        n = len16(v)
        if n < schema.get("minLength", 0) or n > schema.get("maxLength", 10**9):
            return False
        if "pattern" in schema and not re.search(schema["pattern"], v):
            return False
    elif t == "integer":
        if not is_int(v):
            return False
        if v < schema.get("minimum", -(10**18)) or v > schema.get("maximum", 10**18):
            return False
    elif t is not None:
        raise RuntimeError("unsupported type " + t)
    return True


# ------------------------------------------------------------- text rules


def forbidden(ch: str, allow_lf_tab: bool) -> bool:
    o = ord(ch)
    if allow_lf_tab and ch in "\n\t":
        return False
    return (
        o <= 0x1F
        or 0x7F <= o <= 0x9F
        or o in (0x2028, 0x2029)
        or 0x202A <= o <= 0x202E
        or 0x2066 <= o <= 0x2069
        or 0xD800 <= o <= 0xDFFF
    )


def blank(s: str) -> bool:
    return all(unicodedata.category(ch) == "Zs" for ch in s)


def text_ok(s: str, allow_lf_tab: bool) -> bool:
    return not blank(s) and not any(forbidden(ch, allow_lf_tab) for ch in s)


def normalized(s: str) -> str:
    s = unicodedata.normalize("NFC", s).lower()
    out, space = [], False
    for ch in s:
        if unicodedata.category(ch) == "Zs":
            space = True
            continue
        if space and out:
            out.append(" ")
        space = False
        out.append(ch)
    return "".join(out)


def splits_pair(units, i) -> bool:
    return 0 < i < len(units) and 0xD800 <= units[i - 1] <= 0xDBFF and 0xDC00 <= units[i] <= 0xDFFF


# ------------------------------------------------------------- input rules


def validate_input(raw: bytes, schema, cap):
    try:
        req = parse_strict(raw)
    except (ValueError, json.JSONDecodeError):
        raise Reject("INPUT_SCHEMA")
    if nbytes(req) > cap or depth(req) > MAX_DEPTH:
        raise Reject("INPUT_SIZE")
    if not check_schema(schema, req) or sum(len(e["units"]) for e in req["entries"]) > 400:
        raise Reject("INPUT_SCHEMA")
    for e in req["entries"]:
        for u in e["units"]:
            if not text_ok(u["text"], e["kind"] == "written"):
                raise Reject("INPUT_TEXT")
    for e in req["entries"]:
        for u in e["units"]:
            if sha256_text(u["text"]) != u["sha256"]:
                raise Reject("INPUT_DIGEST")
    ids = [e["entryId"] for e in req["entries"]]
    if len(set(ids)) != len(ids):
        raise Reject("INPUT_DUPLICATE")
    for e in req["entries"]:
        uids = [u["unitId"] for u in e["units"]]
        if len(set(uids)) != len(uids):
            raise Reject("INPUT_DUPLICATE")
    for e in req["entries"]:
        for u in e["units"]:
            if e["kind"] == "voice":
                if not (u["startMs"] < u["endMs"] <= e["durationMs"]):
                    raise Reject("INPUT_RANGE")
            elif u["offset"] + len16(u["text"]) > 200000:
                raise Reject("INPUT_RANGE")
    keys = [(key_order(e["createdAt"]), key_order(e["entryId"])) for e in req["entries"]]
    if any(not (a < b) for a, b in zip(keys, keys[1:])):
        raise Reject("INPUT_ORDER")
    for e in req["entries"]:
        us = e["units"]
        for a, b in zip(us, us[1:]):
            if e["kind"] == "voice":
                if b["startMs"] < a["startMs"]:
                    raise Reject("INPUT_ORDER")
            elif not (a["offset"] + len16(a["text"]) <= b["offset"]):
                raise Reject("INPUT_ORDER")
    return req


# ------------------------------------------------------------- result rules


def items_in_order(out):
    """(kind, item, text) in contract document order."""
    if "summary" in out:
        yield "summary", out["summary"], out["summary"]["text"]
    for section in out.get("sections", []):
        for item in section["items"]:
            yield "sections", item, item["text"]
    for kind in LISTS:
        for item in out.get(kind, []):
            yield kind, item, item.get("text", item.get("name"))


def validate_result(raw: bytes, req, schema, cap):
    try:
        out = parse_strict(raw)
    except (ValueError, json.JSONDecodeError):
        raise Reject("RESULT_SCHEMA")
    if nbytes(out) > cap or depth(out) > MAX_DEPTH:
        raise Reject("RESULT_SIZE")
    if not check_schema(schema, out):
        raise Reject("RESULT_SCHEMA")
    if sum(len(item["sources"]) for _, item, _ in items_in_order(out)) > 1000:
        raise Reject("RESULT_SCHEMA")
    if (
        out["contract"] != req["contract"]
        or out["requestKey"] != req["requestKey"]
        or out["inputSha256"] != hashlib.sha256(canonical(req).encode("utf-8")).hexdigest()
    ):
        raise Reject("RESULT_ECHO")
    present = [k for k in KINDS if k in out]
    if present != [k for k in KINDS if k in req["kinds"]]:
        raise Reject("RESULT_KINDS")
    areas = [s["area"] for s in out.get("sections", [])]
    if areas not in ([], ["work"], ["personal"], ["work", "personal"]):
        raise Reject("RESULT_KINDS")
    for _, _, text in items_in_order(out):
        if not text_ok(text, False):
            raise Reject("RESULT_TEXT")
    entries = {e["entryId"]: (i, e) for i, e in enumerate(req["entries"])}
    refs = [(item, s) for _, item, _ in items_in_order(out) for s in item["sources"]]

    def unit_of(s):
        ei, e = entries[s["entryId"]]
        for ui, u in enumerate(e["units"]):
            if u["unitId"] == s["unitId"]:
                return ei, e, ui, u
        return None

    for _, s in refs:
        if s["entryId"] not in entries or unit_of(s) is None:
            raise Reject("RESULT_REFERENCE")
    for _, s in refs:
        if s["unitSha256"] != unit_of(s)[3]["sha256"]:
            raise Reject("RESULT_DIGEST")
    for _, s in refs:
        _, e, _, u = unit_of(s)
        units = utf16_units(u["text"])
        if not (0 <= s["charStart"] < s["charEnd"] <= len(units)):
            raise Reject("RESULT_RANGE")
        if splits_pair(units, s["charStart"]) or splits_pair(units, s["charEnd"]):
            raise Reject("RESULT_RANGE")
        has_a, has_b = "audioStartMs" in s, "audioEndMs" in s
        if e["kind"] == "voice":
            if not (has_a and has_b):
                raise Reject("RESULT_RANGE")
            if not (u["startMs"] <= s["audioStartMs"] < s["audioEndMs"] <= u["endMs"]):
                raise Reject("RESULT_RANGE")
        elif has_a or has_b:
            raise Reject("RESULT_RANGE")
    for _, item, _ in items_in_order(out):
        keyed = []
        for s in item["sources"]:
            ei, _, ui, _ = unit_of(s)
            keyed.append(((ei, ui, s["charStart"]), s))
        for (ka, a), (kb, b) in zip(keyed, keyed[1:]):
            if not ka < kb:
                raise Reject("RESULT_ORDER")
            if ka[:2] == kb[:2] and a["charEnd"] > b["charStart"]:
                raise Reject("RESULT_ORDER")
    groups = []
    for section in out.get("sections", []):
        groups.append([i["text"] for i in section["items"]])
    for kind in LISTS:
        groups.append([i.get("text", i.get("name")) for i in out.get(kind, [])])
    for texts in groups:
        norm = [normalized(t) for t in texts]
        if len(set(norm)) != len(norm):
            raise Reject("RESULT_DUPLICATE")
    return out


# ------------------------------------------------------------- events


def run_events(case, fixtures, results, schemas, caps):
    req = fixtures[case.get("fixture", "mixed")]
    partials = ignored = 0
    outcome = None
    for ev in case["events"]:
        if outcome is not None:
            continue
        t = ev["type"]
        if t == "partial":
            delta = ev["delta"]
            ok = check_schema(schemas["partial"], delta) and all(k in req["kinds"] for k in delta["counts"])
            if ok:
                partials += 1
            else:
                ignored += 1
        elif t == "completed":
            try:
                validate_result(result_bytes(results[ev["result"]]), req, schemas["output"], caps["outputCap"])
                outcome = {"outcome": "duplicate"} if case.get("alreadyStored") else {"outcome": "stored"}
            except Reject as r:
                outcome = {"outcome": "invalid", "code": "INVALID_RESULT", "subCode": r.code}
        elif t == "failed":
            outcome = {"outcome": "failed", "code": ev["code"]}
        elif t == "cancelled":
            outcome = {"outcome": "cancelled"}
    if outcome is None:
        outcome = {"outcome": "failed", "code": "EXECUTION_FAILED"}
    outcome["partials"] = partials
    outcome["ignoredPartials"] = ignored
    return outcome


# ------------------------------------------------------------- main


def result_bytes(case) -> bytes:
    if "resultBase64" in case:
        return base64.b64decode(case["resultBase64"])
    if "resultText" in case:
        return case["resultText"].encode("utf-8", "surrogatepass")
    return canonical(case["result"]).encode("utf-8", "surrogatepass")


def input_bytes(case) -> bytes:
    if "inputText" in case:
        return case["inputText"].encode("utf-8", "surrogatepass")
    return canonical(case["input"]).encode("utf-8", "surrogatepass")


def request_key(key: bytes, req) -> str:
    rest = {k: v for k, v in req.items() if k != "requestKey"}
    mac = hmac.new(key, b"journal.organize@1\x00" + canonical(rest).encode("utf-8"), hashlib.sha256).digest()
    bits = "".join(format(b, "08b") for b in mac)
    alphabet = "0123456789abcdefghjkmnpqrstvwxyz"
    return "org_" + "".join(alphabet[int(bits[i * 5 : i * 5 + 5], 2)] for i in range(26))


def main(root: Path) -> int:
    failures = []
    manifest = json.loads((root / "vectors.json").read_text("utf-8"))
    for name, digest in manifest["files"].items():
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest:
            failures.append(f"file digest {name}")
    caps = manifest["budget"]
    if caps["inputCap"] != caps["messageCap"] - caps["requestEnvelopeMax"] or caps["outputCap"] != caps["messageCap"] - caps["eventEnvelope"]:
        failures.append("budget arithmetic")
    schemas = {
        "input": json.loads((root / "organize-input.schema.json").read_text("utf-8")),
        "output": json.loads((root / "organize-output.schema.json").read_text("utf-8")),
        "partial": json.loads((root / "organize-partial.schema.json").read_text("utf-8")),
    }
    vec = root / "vectors"
    fixtures = json.loads((vec / "fixtures.json").read_text("utf-8"))
    inputs = json.loads((vec / "inputs.json").read_text("utf-8"))
    results = json.loads((vec / "results.json").read_text("utf-8"))
    events = json.loads((vec / "events.json").read_text("utf-8"))
    envelopes = json.loads((vec / "envelopes.json").read_text("utf-8"))
    keys = json.loads((vec / "request-keys.json").read_text("utf-8"))

    counts = {"inputs": 0, "results": 0, "events": 0, "envelopes": 0, "requestKeys": 0, "fixtures": 0}

    for name, req in fixtures.items():
        try:
            validate_input(canonical(req).encode("utf-8"), schemas["input"], caps["inputCap"])
            counts["fixtures"] += 1
        except Reject as r:
            failures.append(f"fixture {name}: {r.code}")
    if nbytes(fixtures["max"]) != caps["inputCap"]:
        failures.append("fixture max is not exactly at the input cap")

    for case in inputs:
        expect = case["expect"]
        try:
            validate_input(input_bytes(case), schemas["input"], caps["inputCap"])
            got = {"valid": True}
        except Reject as r:
            got = {"valid": False, "code": r.code}
        if got != expect:
            failures.append(f"input {case['name']}: expected {expect}, got {got}")
        else:
            counts["inputs"] += 1

    by_name = {c["name"]: c for c in results}
    for case in results:
        expect = case["expect"]
        try:
            validate_result(result_bytes(case), fixtures[case["fixture"]], schemas["output"], caps["outputCap"])
            got = {"valid": True}
        except Reject as r:
            got = {"valid": False, "code": r.code}
        if got != expect:
            failures.append(f"result {case['name']}: expected {expect}, got {got}")
        else:
            counts["results"] += 1
    if nbytes(by_name["valid-maxOutput"]["result"]) != caps["outputCap"]:
        failures.append("valid-maxOutput is not exactly at the output cap")

    for case in events:
        got = run_events(case, fixtures, by_name, schemas, caps)
        want = case["expect"]
        if any(got.get(k) != v for k, v in want.items()) or (
            "ignoredPartials" not in want and got["ignoredPartials"] != 0
        ):
            failures.append(f"events {case['name']}: expected {want}, got {got}")
        else:
            counts["events"] += 1

    inputs_by_name = {c["name"]: c for c in inputs}
    for case in envelopes:
        if case["kind"] == "jobRequest":
            src, ref = case["input"].split(":", 1)
            inp = fixtures[ref] if src == "fixture" else inputs_by_name[ref]["input"]
            e = case["envelope"]
            msg = {
                "capability": {"id": "journal.organize", "version": e["version"]},
                "deadlineMs": e["deadlineMs"],
                "idempotencyKey": e["idempotencyKey"],
                "input": inp,
                "requestId": e["requestId"],
                "stream": e["stream"],
            }
            if not (re.fullmatch(r"[A-Za-z0-9._:-]{1,64}", e["requestId"]) and re.fullmatch(r"[A-Za-z0-9_-]{16,128}", e["idempotencyKey"])):
                failures.append(f"envelope {case['name']}: envelope fields outside the SDK schema")
        else:
            _, ref = case["output"].split(":", 1)
            msg = {"data": {"output": by_name[ref]["result"]}, "sequence": case["sequence"], "type": "completed"}
        size = nbytes(msg)
        want = case["expect"]
        if size != want["bytes"] or (size <= caps["messageCap"]) != want["withinCap"]:
            failures.append(f"envelope {case['name']}: {size} bytes, expected {want}")
        else:
            counts["envelopes"] += 1

    key = bytes.fromhex(keys["testKeyHex"])
    for case in keys["cases"]:
        got = request_key(key, case["input"])
        if got != case["expect"]["requestKey"]:
            failures.append(f"request key {case['name']}: {got}")
        else:
            counts["requestKeys"] += 1

    for name, n in counts.items():
        expected = manifest["counts"].get(name, n)
        if n != expected:
            failures.append(f"count {name}: verified {n} of {expected}")
    for f in failures:
        print("FAIL", f)
    print(
        "verified: {fixtures} fixtures, {inputs} input cases, {results} result cases, "
        "{events} event cases, {envelopes} envelope cases, {requestKeys} request-key cases; "
        "{fail} failures".format(fail=len(failures), **counts)
    )
    return 1 if failures else 0


def check_results(root: Path, results_file: Path) -> int:
    """Validates engine outputs ({cases: [{fixture, result}]}) for their fixtures."""
    manifest = json.loads((root / "vectors.json").read_text("utf-8"))
    schema = json.loads((root / "organize-output.schema.json").read_text("utf-8"))
    fixtures = json.loads((root / "vectors" / "fixtures.json").read_text("utf-8"))
    cases = json.loads(results_file.read_text("utf-8"))["cases"]
    failures = 0
    for case in cases:
        try:
            validate_result(canonical(case["result"]).encode("utf-8"), fixtures[case["fixture"]], schema, manifest["budget"]["outputCap"])
        except Reject as r:
            failures += 1
            print("FAIL", case["fixture"], r.code)
    print(f"verified {len(cases) - failures} of {len(cases)} results; {failures} failures")
    return 1 if failures else 0


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--results" in args:
        i = args.index("--results")
        results = Path(args.pop(i + 1))
        args.pop(i)
        sys.exit(check_results(Path(args[0] if args else "schemas/journal/v1"), results))
    sys.exit(main(Path(args[0] if args else "schemas/journal/v1")))
