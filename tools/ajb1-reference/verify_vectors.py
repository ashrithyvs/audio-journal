"""Independent AJB1 v1 vector verifier (docs/backup-and-restore.md §9).

Written from the specification text, not ported from the Node reference:
Python's own JSON parser, the `cryptography` package's AES-GCM, and
OpenSSL's Argon2id (a third Argon2 implementation beside the Node reference
and libargon2). Every vector in schemas/ajb1/v1/vectors.json must reach the
recorded verdict, and every valid archive must decode to the recorded records
and PCM digests.

Usage: python3 -I verify_vectors.py <schemas/ajb1/v1 directory>
"""

import hashlib
import json
import re
import struct
import sys
import unicodedata
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.argon2 import Argon2id

MAGIC = bytes([0x41, 0x4A, 0x42, 0x31, 0x0D, 0x0A, 0x1A, 0x0A])
HEADER = 128
L = 1_048_576
BLOCK = L + 16
TYPES = ["entry", "recording", "transcriptSegment"]


class Reject(Exception):
    def __init__(self, code, stage):
        super().__init__(f"{code}/{stage}")
        self.code, self.stage = code, stage


# --- canonical JSON (§9.4) -------------------------------------------------


def _no_duplicates(pairs):
    keys = [k for k, _ in pairs]
    if len(keys) != len(set(keys)):
        raise ValueError("duplicate key")
    return dict(pairs)


def _canonical(value):
    if value is None or isinstance(value, float):
        raise ValueError("type")
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        if not 0 <= value <= 2**53 - 1:
            raise ValueError("number")
        return str(value)
    if isinstance(value, str):
        if any(0xD800 <= ord(c) <= 0xDFFF for c in value):
            raise ValueError("surrogate")
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(_canonical(v) for v in value) + "]"
    if isinstance(value, dict):
        # Keys are compared by UTF-16 code units (JCS).
        keys = sorted(value, key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(f"{_canonical(k)}:{_canonical(value[k])}" for k in keys) + "}"
    raise ValueError("type")


def parse_canonical(raw: bytes, stage: str):
    try:
        text = raw.decode("utf-8", errors="strict")
        if text.startswith("﻿"):
            raise ValueError("bom")
        value = json.loads(text, object_pairs_hook=_no_duplicates)
        if _canonical(value) != text:
            raise ValueError("not canonical")
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise Reject("NON_CANONICAL_JSON", stage)
    return value


# --- records (§9.6) --------------------------------------------------------

ID = {t: re.compile(rf"^{p}_[0-9a-hjkmnp-tv-z]{{26}}$") for t, p in
      [("entry", "ent"), ("recording", "rec"), ("transcriptSegment", "seg")]}
FIELDS = {
    "entry": ({"t", "id", "kind", "status", "createdAtMs", "updatedAtMs"}, {"title", "sourceText"}),
    "recording": ({"t", "id", "entryId", "state", "startedAtMs", "durationMs", "pcmBytes", "pcmSha256"},
                  {"endedAtMs", "finishReason"}),
    "transcriptSegment": ({"t", "id", "entryId", "recordingId", "engineRevision", "ordinal", "startMs",
                           "endMs", "text", "state", "source", "createdAtMs"}, {"modelId", "supersedesSegmentId"}),
}


def is_uint(v):
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def record_ok(r):
    try:
        return bool(_record_ok(r))
    except (TypeError, KeyError, AttributeError):
        return False  # wrong field types are invalid records, not crashes


def _record_ok(r):
    t = r.get("t")
    if t not in FIELDS:
        return False
    required, optional = FIELDS[t]
    if not required <= set(r) or not set(r) <= required | optional or not ID[t].match(r["id"]):
        return False
    if t == "entry":
        title, text = r.get("title"), r.get("sourceText")
        return (r["kind"] in ("voice", "written") and r["status"] in ("ready", "recovery_required")
                and is_uint(r["createdAtMs"]) and is_uint(r["updatedAtMs"]) and r["updatedAtMs"] >= r["createdAtMs"]
                and (title is None or (isinstance(title, str) and 0 < len(title.encode("utf-16-le")) // 2 <= 200
                                       and title == " ".join(title.split())))
                and ((r["kind"] == "written") == (text is not None))
                and (text is None or (isinstance(text, str) and text.strip() != ""
                                      and len(text.encode("utf-16-le")) // 2 <= 200_000)))
    if t == "recording":
        ready = r["state"] == "ready"
        return (ID["entry"].match(r["entryId"]) and r["state"] in ("ready", "recoverable")
                and is_uint(r["startedAtMs"]) and is_uint(r["durationMs"]) and r["durationMs"] <= 3_600_000
                and ("endedAtMs" not in r or (is_uint(r["endedAtMs"]) and r["endedAtMs"] >= r["startedAtMs"]))
                and (not ready or ("endedAtMs" in r and "finishReason" in r))
                and r.get("finishReason", "user") in ("user", "duration_limit", "storage_low", "recovered")
                and is_uint(r["pcmBytes"]) and 0 < r["pcmBytes"] <= 115_200_032 and r["pcmBytes"] % 2 == 0
                and abs(r["pcmBytes"] - r["durationMs"] * 32) <= 32
                and re.fullmatch(r"[0-9a-f]{64}", r["pcmSha256"]) is not None)
    s = r
    corrected, user = s["state"] == "corrected", s["source"] == "user"
    return (ID["entry"].match(s["entryId"]) and ID["recording"].match(s["recordingId"])
            and all(is_uint(s[k]) for k in ("engineRevision", "ordinal", "startMs", "endMs", "createdAtMs"))
            and s["endMs"] >= s["startMs"] and isinstance(s["text"], str)
            and len(s["text"].encode("utf-16-le")) // 2 <= 4000
            and s["state"] in ("provisional", "final", "corrected") and s["source"] in ("engine", "user")
            and corrected == user == ("supersedesSegmentId" in s)
            and (s["state"] == "provisional") == (s["engineRevision"] == 0)
            and (s["state"] == "final") == ("modelId" in s)
            and ("modelId" not in s or re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", s["modelId"]) is not None)
            and ("supersedesSegmentId" not in s or ID["transcriptSegment"].match(s["supersedesSegmentId"])))


def check_relations(records):
    by = {t: {r["id"]: r for r in records if r["t"] == t} for t in TYPES}
    owned = set()
    for rec in by["recording"].values():
        entry = by["entry"].get(rec["entryId"])
        if not entry or entry["kind"] != "voice" or entry["id"] in owned:
            raise Reject("DANGLING_REFERENCE", "records")
        owned.add(entry["id"])
    if any(e["kind"] == "voice" and e["id"] not in owned for e in by["entry"].values()):
        raise Reject("DANGLING_REFERENCE", "records")
    full_pass, superseded = set(), set()
    for seg in by["transcriptSegment"].values():
        rec = by["recording"].get(seg["recordingId"])
        if not rec or rec["entryId"] != seg["entryId"]:
            raise Reject("DANGLING_REFERENCE", "records")
        if seg["endMs"] > rec["durationMs"]:
            raise Reject("INVALID_RECORD", "records")
        if seg["engineRevision"] > 0:
            full_pass.add(seg["recordingId"])
        target_id = seg.get("supersedesSegmentId")
        if target_id:
            target = by["transcriptSegment"].get(target_id)
            if (not target or target["recordingId"] != seg["recordingId"] or target_id in superseded
                    or target["engineRevision"] != seg["engineRevision"] or target["state"] == "provisional"):
                raise Reject("DANGLING_REFERENCE", "records")
            superseded.add(target_id)
    if any(s["state"] == "provisional" and s["recordingId"] in full_pass for s in by["transcriptSegment"].values()):
        raise Reject("INVALID_RECORD", "records")
    return by


# --- reader (§9.2, §9.3, §9.5, §9.10) --------------------------------------


def read(file: bytes, secret: bytes, kind: int, context: dict, policy: dict, limits: dict, kek_hint=None):
    s = "header"
    if len(file) < 8 or file[:8] != MAGIC:
        raise Reject("NOT_AJB1", s)
    if len(file) < HEADER + 16:
        raise Reject("TRUNCATED", s)
    if len(file) > limits["maxArchiveBytes"]:
        raise Reject("LIMIT_EXCEEDED", s)
    version, header_len = struct.unpack(">HH", file[8:12])
    if version != 1:
        raise Reject("UNSUPPORTED_VERSION", s)
    domain = struct.unpack(">H", file[42:44])[0]
    if (header_len != HEADER or file[15] != 0 or any(file[112:128]) or file[40] != 1
            or file[41] not in (1, 2) or struct.unpack(">I", file[44:48])[0] != L or domain == 0):
        raise Reject("MALFORMED_HEADER", s)
    if domain > 1:
        raise Reject("UNSUPPORTED_SCHEMA", s)
    if file[12] != 1 or file[13] != 0x13:
        raise Reject("UNSUPPORTED_KDF", s)
    p, (m, t) = file[14], struct.unpack(">II", file[16:24])
    lo, hi = policy["floor"], policy["ceiling"]
    if not (lo["m"] <= m <= hi["m"] and lo["t"] <= t <= hi["t"] and lo["p"] <= p <= hi["p"] and m >= 8 * p):
        raise Reject("KDF_PARAMS_REJECTED", s)
    if (len(file) - HEADER) % BLOCK < 16:
        raise Reject("TRUNCATED", s)
    if context.get("purpose") == "restore" and context["availableBytes"] < len(file) + limits["restoreReserveBytes"]:
        raise Reject("INSUFFICIENT_STORAGE", s)
    if kind != file[41]:
        raise Reject("SECRET_KIND_MISMATCH", s)

    salt = file[24:40]
    kek = Argon2id(salt=salt, length=32, iterations=t, lanes=p, memory_cost=m).derive(secret)
    if kek_hint is not None and kek.hex() != kek_hint:
        raise AssertionError("OpenSSL Argon2id disagrees with the recorded KEK")
    header = file[:HEADER]
    try:
        dek = AESGCM(kek).decrypt(header[52:64], header[64:112], header[:64])
    except InvalidTag:
        raise Reject("AUTH_FAILED", "unwrap")
    header_hash = hashlib.sha256(header).digest()
    body = file[HEADER:]
    count = len(body) // BLOCK + 1
    plain = bytearray()
    for i in range(count):
        block = body[i * BLOCK:(i + 1) * BLOCK]
        aad = header_hash + struct.pack(">QB", i, 1 if i == count - 1 else 0)
        try:
            plain += AESGCM(dek).decrypt(header[48:52] + struct.pack(">Q", i), block, aad)
        except InvalidTag:
            raise Reject("AUTH_FAILED", "segment")
    return parse_sections(bytes(plain), domain, limits)


def parse_sections(plain: bytes, domain: int, limits: dict):
    at = 0

    def head(stage="sections"):
        nonlocal at
        if len(plain) - at < 12:
            raise Reject("MALFORMED_SECTION", stage)
        kind, reserved, length = plain[at], plain[at + 1:at + 4], struct.unpack(">Q", plain[at + 4:at + 12])[0]
        if any(reserved):
            raise Reject("MALFORMED_SECTION", stage)
        return kind, length, at + 12

    def take(start, length, cap, stage):
        nonlocal at
        if length > cap:
            raise Reject("LIMIT_EXCEEDED", stage)
        if start + length > len(plain):
            raise Reject("MALFORMED_SECTION", stage)
        at = start + length
        return plain[start:at]

    kind, length, start = head()
    if kind != 1:
        raise Reject("MALFORMED_SECTION", "sections")
    manifest = parse_canonical(take(start, length, limits["maxManifestBytes"], "manifest"), "manifest")
    keys = {"createdAtMs", "domainSchemaVersion", "format", "formatVersion", "pcm", "records"}
    try:
        counts = manifest["records"]["counts"]
        shape_ok = (set(manifest) == keys and set(manifest["pcm"]) == {"bytes", "recordings"}
                    and set(manifest["records"]) == {"bytes", "counts", "lines", "sha256"}
                    and set(counts) == set(TYPES) and manifest["format"] == "AJB1"
                    and manifest["formatVersion"] == 1 and manifest["domainSchemaVersion"] == domain
                    and re.fullmatch(r"[0-9a-f]{64}", manifest["records"]["sha256"]) is not None
                    and all(is_uint(v) for v in [manifest["createdAtMs"], *manifest["pcm"].values(),
                                                 manifest["records"]["bytes"], manifest["records"]["lines"],
                                                 *counts.values()]))
    except (TypeError, KeyError, AttributeError):
        shape_ok = False
    if not shape_ok:
        raise Reject("MALFORMED_MANIFEST", "manifest")
    if (counts["entry"] > limits["maxEntries"] or counts["recording"] > limits["maxRecordings"]
            or counts["transcriptSegment"] > limits["maxTranscriptSegments"]
            or manifest["records"]["bytes"] > limits["maxRecordsBytes"]
            or manifest["pcm"]["bytes"] > limits["maxTotalPcmBytes"]):
        raise Reject("LIMIT_EXCEEDED", "manifest")
    if manifest["pcm"]["recordings"] != counts["recording"] or manifest["records"]["lines"] != sum(counts.values()):
        raise Reject("COUNT_MISMATCH", "manifest")

    kind, length, start = head()
    if kind != 2:
        raise Reject("MALFORMED_SECTION", "sections")
    if length != manifest["records"]["bytes"]:
        raise Reject("COUNT_MISMATCH", "records")
    raw = take(start, length, limits["maxRecordsBytes"], "records")
    if hashlib.sha256(raw).hexdigest() != manifest["records"]["sha256"]:
        raise Reject("DIGEST_MISMATCH", "records")
    records, seen = [], set()
    if raw:
        if not raw.endswith(b"\n"):
            raise Reject("NON_CANONICAL_JSON", "records")
        for line in raw[:-1].split(b"\n"):
            if not line or len(line) > limits["maxLineBytes"]:
                raise Reject("NON_CANONICAL_JSON", "records")
            value = parse_canonical(line, "records")
            if not isinstance(value, dict) or not record_ok(value):
                raise Reject("INVALID_RECORD", "records")
            if value["id"] in seen:
                raise Reject("DUPLICATE_ID", "records")
            if records:
                prev = records[-1]
                if (TYPES.index(prev["t"]), prev["id"]) > (TYPES.index(value["t"]), value["id"]):
                    raise Reject("INVALID_RECORD", "records")
            seen.add(value["id"])
            records.append(value)
    if {t: sum(r["t"] == t for r in records) for t in TYPES} != counts:
        raise Reject("COUNT_MISMATCH", "records")
    by = check_relations(records)
    recordings = [r for r in records if r["t"] == "recording"]
    if sum(r["pcmBytes"] for r in recordings) != manifest["pcm"]["bytes"]:
        raise Reject("COUNT_MISMATCH", "records")
    pcm = {}
    for rec in recordings:
        kind, length, start = head("recordings")
        if kind != 3 or length != 30 + rec["pcmBytes"]:
            raise Reject("MALFORMED_SECTION", "recordings")
        body = take(start, length, 30 + 115_200_032, "recordings")
        if body[:30].decode("latin-1") != rec["id"]:
            raise Reject("MALFORMED_SECTION", "recordings")
        if hashlib.sha256(body[30:]).hexdigest() != rec["pcmSha256"]:
            raise Reject("DIGEST_MISMATCH", "recordings")
        pcm[rec["id"]] = hashlib.sha256(body[30:]).hexdigest()
    kind, length, start = head()
    if kind != 4 or length != 0:
        raise Reject("MALFORMED_SECTION", "sections")
    if start != len(plain):
        raise Reject("MALFORMED_SECTION", "sections")
    return manifest, raw, pcm


# --- mutations (§9.11) and secrets (§9.7) ----------------------------------


def mutate(base: bytes, m: dict, files: dict) -> bytes:
    data = bytearray(base)
    blocks = [bytes(data[i:i + BLOCK]) for i in range(HEADER, len(data), BLOCK)]
    join = lambda parts: bytes(data[:HEADER]) + b"".join(parts)
    op = m["op"]
    if op == "truncate":
        return bytes(data[:m["length"]])
    if op == "append":
        return bytes(data) + bytes.fromhex(m["hex"])
    if op in ("xor", "set"):
        patch = bytes.fromhex(m["hex"])
        for i, b in enumerate(patch):
            data[m["offset"] + i] = data[m["offset"] + i] ^ b if op == "xor" else b
        return bytes(data)
    if op == "swapBlocks":
        blocks[m["a"]], blocks[m["b"]] = blocks[m["b"]], blocks[m["a"]]
    elif op == "duplicateBlock":
        blocks[m["to"]] = blocks[m["from"]]
    elif op == "dropBlock":
        del blocks[m["index"]]
    elif op == "spliceBlock":
        other = files[m["fromVector"]]
        blocks[m["to"]] = other[HEADER + m["fromIndex"] * BLOCK:HEADER + (m["fromIndex"] + 1) * BLOCK]
    else:
        raise AssertionError(op)
    return join(blocks)


def secret_bytes(secret: dict, words: list):
    if secret["kind"] == "password":
        return unicodedata.normalize("NFC", secret["input"]).encode("utf-8"), 1
    tokens = secret["input"].split()
    bits = "".join(format(words.index(t), "011b") for t in tokens)
    entropy = int(bits[:256], 2).to_bytes(32, "big")
    assert int(bits[256:], 2) == hashlib.sha256(entropy).digest()[0], "checksum"
    return entropy, 2


def main(directory: str):
    root = Path(directory)
    v = json.loads((root / "vectors.json").read_text(encoding="utf-8"))
    wordlist = (root.parents[2] / "tools/ajb1-reference/wordlists/bip39-english.txt").read_bytes()
    assert hashlib.sha256(wordlist).hexdigest() == v["wordlist"]["sha256"]
    words = wordlist.decode("ascii").split()
    policy, limits = v["kdfPolicy"], v["limits"]
    for name, secret in v["secrets"].items():
        assert secret_bytes(secret, words)[0].hex() == secret["kdfInputHex"], name
    files = {}
    checked = 0
    for vec in v["valid"]:
        data = (root / vec["file"]).read_bytes()
        assert hashlib.sha256(data).hexdigest() == vec["sha256"], vec["name"]
        files[vec["name"]] = data
        secret, kind = secret_bytes(v["secrets"][vec["secret"]], words)
        manifest, raw, pcm = read(data, secret, kind, {}, policy, limits, kek_hint=vec["kekHex"])
        expect = vec["expect"]
        assert manifest == expect["manifest"], vec["name"]
        assert raw == (root / expect["recordsFile"]).read_bytes(), vec["name"]
        assert hashlib.sha256(raw).hexdigest() == expect["recordsSha256"], vec["name"]
        assert pcm == {p["id"]: p["sha256"] for p in expect["pcm"]}, vec["name"]
        checked += 1
    for vec in v["hostile"]:
        if "file" in vec:
            data = (root / vec["file"]).read_bytes()
            assert hashlib.sha256(data).hexdigest() == vec["sha256"], vec["name"]
            files[Path(vec["file"]).stem] = data
    for vec in v["hostile"]:
        if vec.get("expect", {}).get("ok"):
            continue
        if "file" in vec:
            data = (root / vec["file"]).read_bytes()
        elif vec.get("mutation"):
            data = mutate(files[vec["base"]], vec["mutation"], files)
        else:
            data = files[vec["base"]]
        secret, kind = secret_bytes(v["secrets"][vec["secret"]], words)
        try:
            read(data, secret, kind, vec.get("context") or {}, policy, limits)
        except Reject as reject:
            got = (reject.code, reject.stage)
        else:
            got = ("accepted", "")
        want = (vec["expect"]["code"], vec["expect"]["stage"])
        assert got == want, f"{vec['name']}: want {want}, got {got}"
        checked += 1
    for case in v["recoveryKeys"]["encode"]:
        entropy = bytes.fromhex(case["entropyHex"])
        bits = "".join(format(b, "08b") for b in entropy) + format(hashlib.sha256(entropy).digest()[0], "08b")
        assert " ".join(words[int(bits[i:i + 11], 2)] for i in range(0, 264, 11)) == case["words"]
        checked += 1
    for case in v["passwords"]:
        if "kdfInputHex" in case:
            assert unicodedata.normalize("NFC", case["input"]).encode("utf-8").hex() == case["kdfInputHex"]
            checked += 1
    print(f"verified {checked} AJB1 vectors independently (Python, cryptography AES-GCM, OpenSSL Argon2id)")


if __name__ == "__main__":
    main(sys.argv[1])
