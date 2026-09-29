"""Offline, sample-derived first-title ЭТрН replay. No storage or network access.

The JSON model preserves the XML element infoset: ordered attributes/children,
text, tails, and empty element presence. It is intentionally not a domain-wide
ConsignmentNote generator. XML lexical details (quotes, entity spelling, empty
tag spelling, declaration and indentation) are not evidence of a new signature.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime
from decimal import Decimal, InvalidOperation, localcontext
from hashlib import sha256
import re
from typing import Any
from uuid import UUID, uuid5
import xml.etree.ElementTree as ET


SCOPE = "ConsignmentNote/1110339/5.01/first-title"
DSIG = "http://www.w3.org/2000/09/xmldsig#"
TITLE_PREFIXES = {
    "1110339": "ON_TRNACLGROT",
    "1110340": "ON_TRNACLPPRIN",
    "1110341": "ON_TRNACLGRPO",
    "1110342": "ON_TRNACLPVYN",
}
CRYPTO_TAGS = {"ЭП", "ЭлектроннаяПодпись", "Signature"}
CRYPTO_ATTRS = {"ЭП"}
SERVICE_REASONS = {
    "/Файл[1]/@ИдФайл": "Новый идентификатор локального тестового файла и дата формирования; маршрутизация участников сохранена из эталона.",
    "/Файл[1]/@ВерсПрог": "Указан локальный генератор Artel-CRM offline; это не документ, выпущенный Saby.",
    "/Файл[1]/Документ[1]/@ДатИнфГО": "Дата локального формирования; дата перевозки сохранена отдельно.",
    "/Файл[1]/Документ[1]/@ВрИнфГО": "Время локального формирования; времена бизнес-событий сохранены отдельно.",
    "/Файл[1]/Документ[1]/СодИнфГО[1]/@УИД_ТрН": "Новый локальный UUID тестовой накладной; регистрации в Saby или ГИС ЭПД нет.",
}
_ROUTING_ATTRS = {"ИдОтпр", "ИдПол", "ИдОтпрДок", "ИдПолДок"}


class ReplayError(ValueError):
    """Safe validation error; messages deliberately exclude source values."""


def _local(name: str) -> str:
    return name.rsplit("}", 1)[-1]


def _crypto_tag(tag: str) -> bool:
    return tag.startswith("{" + DSIG + "}") or _local(tag) in CRYPTO_TAGS


def _crypto_attr(name: str) -> bool:
    return name.startswith("{" + DSIG + "}") or _local(name) in CRYPTO_ATTRS


def _parse(data: bytes) -> ET.Element:
    if not isinstance(data, bytes) or not data or len(data) > 10_000_000:
        raise ReplayError("XML must be nonempty bytes, at most 10 MB")
    declaration = re.match(br"\s*<\?xml\s[^?]*encoding\s*=\s*['\"]([^'\"]+)['\"]", data[:256])
    try:
        encoding = declaration.group(1).decode("ascii").lower() if declaration else "utf-8-sig"
    except UnicodeError as exc:
        raise ReplayError("Invalid XML encoding declaration") from exc
    if encoding not in {"utf-8", "utf-8-sig", "windows-1251", "cp1251"}:
        raise ReplayError("Unsupported XML encoding; only UTF-8 and Windows-1251 are supported")
    try:
        content = data.decode(encoding)
    except (UnicodeError, LookupError) as exc:
        raise ReplayError("XML encoding is invalid") from exc
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", content, re.IGNORECASE):
        raise ReplayError("DTD and entity declarations are forbidden")
    without_declaration = re.sub(r"^\ufeff?\s*<\?xml\s[^?]*\?>", "", content, count=1)
    if "<!--" in content or "<?" in without_declaration:
        raise ReplayError("XML comments and processing instructions are unsupported")
    # Explicitly reject comments/PIs rather than silently dropping unknown data.
    try:
        parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True, insert_pis=True))
        root = ET.fromstring(content, parser=parser)
    except ET.ParseError as exc:
        raise ReplayError("Malformed XML") from exc
    for node in root.iter():
        if not isinstance(node.tag, str):
            raise ReplayError("XML comments and processing instructions are unsupported")
    pending = [(root, 0)]
    while pending:
        node, depth = pending.pop()
        if depth > 100:
            raise ReplayError("XML nesting exceeds the supported depth")
        pending.extend((child, depth + 1) for child in node)
    return root


def _validate_title(root: ET.Element, first_only: bool = False) -> ET.Element:
    if root.tag != "Файл" or root.get("ВерсФорм") != "5.01":
        raise ReplayError("Expected Файл root with format 5.01")
    documents = root.findall("Документ")
    if len(documents) != 1:
        raise ReplayError("Expected exactly one Документ")
    document = documents[0]
    knd = document.get("КНД", "")
    if knd not in TITLE_PREFIXES or (first_only and knd != "1110339"):
        raise ReplayError("Unsupported KND; replay requires ConsignmentNote first title 1110339")
    file_id = root.get("ИдФайл", "")
    prefix = TITLE_PREFIXES[knd] + "_"
    if not file_id.startswith(prefix) or re.search(r"[\s/\\\x00]", file_id):
        raise ReplayError("Invalid title file identifier or mismatched title prefix")
    parts = file_id.rsplit("_", 2)
    if len(parts) != 3 or not all(parts) or not re.fullmatch(r"\d{8}", parts[1]):
        raise ReplayError("File identifier must end with a date and UUID")
    if any(not part for part in parts[0].split("_")):
        raise ReplayError("File identifier contains an empty routing component")
    try:
        datetime.strptime(parts[1], "%Y%m%d")
        _uuid(parts[2])
    except ValueError as exc:
        raise ReplayError("File identifier date or UUID is invalid") from exc
    if first_only:
        contents = document.findall("СодИнфГО")
        if len(contents) != 1:
            raise ReplayError("Expected exactly one first-title content section СодИнфГО")
        if not all(document.get(key) for key in ("ДатИнфГО", "ВрИнфГО")):
            raise ReplayError("First title lacks generation date or time")
        try:
            _uuid(contents[0].get("УИД_ТрН", ""))
        except ValueError as exc:
            raise ReplayError("First title requires a valid consignment UUID") from exc
    return document


def _uuid(value: str) -> UUID:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", value):
        raise ReplayError("UUID must use canonical hyphenated form")
    return UUID(value)


def _walk(root: ET.Element):
    def visit(node: ET.Element, path: str):
        yield node, path
        counts: Counter[str] = Counter()
        for child in node:
            counts[child.tag] += 1
            yield from visit(child, f"{path}/{child.tag}[{counts[child.tag]}]")
    yield from visit(root, f"/{root.tag}[1]")


def _strip_crypto(root: ET.Element) -> list[str]:
    removed: list[str] = []
    def visit(node: ET.Element, path: str):
        for name in list(node.attrib):
            if _crypto_attr(name):
                removed.append(path + "/@" + name)
                del node.attrib[name]
        counts: Counter[str] = Counter()
        for child in list(node):
            counts[child.tag] += 1
            child_path = f"{path}/{child.tag}[{counts[child.tag]}]"
            if _crypto_tag(child.tag):
                # Moving meaningful mixed content across a removed signature
                # would change field paths; refuse that unsupported ambiguity.
                if child.tail and child.tail.strip():
                    raise ReplayError("Mixed content adjacent to a signature is unsupported")
                index = list(node).index(child)
                if child.tail:
                    previous = node[index - 1] if index else None
                    if previous is not None:
                        previous.tail = (previous.tail or "") + child.tail
                    else:
                        node.text = (node.text or "") + child.tail
                node.remove(child)
                removed.append(child_path)
            else:
                visit(child, child_path)
    visit(root, f"/{root.tag}[1]")
    return removed


def _to_model(node: ET.Element) -> dict[str, Any]:
    return {"tag": node.tag, "attributes": [[k, v] for k, v in node.attrib.items()],
            "text": node.text, "tail": node.tail, "children": [_to_model(c) for c in node]}


def _from_model(model: Any, depth: int = 0) -> ET.Element:
    if not isinstance(model, dict) or set(model) != {"tag", "attributes", "text", "tail", "children"} or depth > 100:
        raise ReplayError("Invalid snapshot node structure")
    if not isinstance(model["tag"], str) or not model["tag"]:
        raise ReplayError("Snapshot tag must be a nonempty string")
    if not isinstance(model["attributes"], list) or not isinstance(model["children"], list):
        raise ReplayError("Snapshot attributes and children must be ordered lists")
    attrs: dict[str, str] = {}
    for pair in model["attributes"]:
        if not isinstance(pair, list) or len(pair) != 2 or not all(isinstance(v, str) for v in pair) or not pair[0] or pair[0] in attrs:
            raise ReplayError("Snapshot attributes must contain unique string pairs")
        attrs[pair[0]] = pair[1]
    for key in ("text", "tail"):
        if model[key] is not None and not isinstance(model[key], str):
            raise ReplayError("Snapshot text and tails must be strings or null")
    node = ET.Element(model["tag"], attrs)
    node.text, node.tail = model["text"], model["tail"]
    for child in model["children"]:
        node.append(_from_model(child, depth + 1))
    return node


def import_snapshot(xml_bytes: bytes) -> dict[str, Any]:
    """Import a private first-title XML into an editable, signature-free model."""
    root = _parse(xml_bytes)
    _validate_title(root, first_only=True)
    removed = _strip_crypto(root)
    return {"schema_version": 1, "scope": SCOPE, "source_sha256": sha256(xml_bytes).hexdigest(),
            "removed_crypto_paths": removed, "root": _to_model(root)}


def generate_title(snapshot: dict[str, Any], generated_at: str, replay_id: str) -> bytes:
    """Rebuild the first title; historical business data stays exact, no signing."""
    if not isinstance(snapshot, dict) or snapshot.get("schema_version") != 1 or snapshot.get("scope") != SCOPE:
        raise ReplayError("Unsupported snapshot schema or document scope")
    uid = _uuid(replay_id)
    try:
        at = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    except (ValueError, AttributeError) as exc:
        raise ReplayError("generated_at must be an ISO datetime with an explicit timezone") from exc
    if at.tzinfo is None or at.utcoffset() is None:
        raise ReplayError("generated_at must include a timezone")
    root = _from_model(snapshot.get("root"))
    # Validate reserialized model too, catching invalid names and XML controls.
    root = _parse(ET.tostring(root, encoding="utf-8", xml_declaration=True))
    document = _validate_title(root, first_only=True)
    _strip_crypto(root)
    old_id = root.attrib["ИдФайл"]
    if uid == _uuid(old_id.rsplit("_", 1)[1]):
        raise ReplayError("Replay UUID must differ from the original file UUID")
    root.set("ИдФайл", f"{old_id.rsplit('_', 2)[0]}_{at:%Y%m%d}_{uid}")
    root.set("ВерсПрог", "Artel-CRM offline")
    document.set("ДатИнфГО", at.strftime("%d.%m.%Y"))
    document.set("ВрИнфГО", at.strftime("%H:%M:%S"))
    content = document.find("СодИнфГО")
    assert content is not None
    content.set("УИД_ТрН", str(uuid5(uid, "consignment")))
    for index, info in enumerate(content.findall("ИнфПол")):
        if "ИдФайлИнфПол" in info.attrib:
            info.set("ИдФайлИнфПол", str(uuid5(uid, f"information-field:{index}")))
    result = ET.tostring(root, encoding="windows-1251", xml_declaration=True)
    _validate_title(_parse(result), first_only=True)
    return result


def _category(path: str) -> str:
    if "/Подписант[" in path:
        return "signatory"
    if (path in SERVICE_REASONS or path == "/Файл[1]/@ВерсФорм" or
            re.fullmatch(r"/Файл\[1\]/Документ\[1\]/СодИнфГО\[1\]/ИнфПол\[\d+\]/@ИдФайлИнфПол", path) or
            any(f"/@{name}" == path[path.rfind("/@"):] for name in _ROUTING_ATTRS)):
        return "service"
    # Subsequent-title generation/link metadata is shown separately; not replayed.
    if re.fullmatch(r"/Файл\[1\]/Документ\[1\]/@(Дат|Вр)Инф(ПрвПрием|ГП|ПрвВыд)", path):
        return "service"
    if re.search(r"/(ИдИнфГО|ИдИнфПрвПрием|ИдИнфГП)\[", path) or path.endswith("/@УИД_ТрН"):
        return "service"
    return "business"


def flatten_title(xml_bytes: bytes) -> list[dict[str, Any]]:
    """Exact indexed field rows for any of the four 5.01 titles.

    Element presence and child order are explicit structural rows. None is never
    a present value; compare uses it for absence. Whitespace-only indentation is
    ignored, but whitespace in a leaf value is preserved. Crypto payloads are
    represented by hashes, never copied into a new title or snapshot.
    """
    root = _parse(xml_bytes)
    _validate_title(root)
    rows: list[dict[str, Any]] = []
    def add(path: str, value: str, kind: str, crypto: bool = False):
        category = "service" if crypto else _category(path)
        rows.append({"path": path, "category": category, "value": value, "kind": kind})
    def visit(node: ET.Element, path: str):
        if _crypto_tag(node.tag):
            add(path, "sha256:" + sha256(ET.tostring(node, encoding="utf-8")).hexdigest(), "crypto", True)
            return
        add(path, "<present>", "element")
        for name, value in node.attrib.items():
            crypto = _crypto_attr(name)
            add(path + "/@" + name, "sha256:" + sha256(value.encode()).hexdigest() if crypto else value,
                "crypto" if crypto else "attribute", crypto)
        mixed = bool(len(node) and ((node.text and node.text.strip()) or
                                   any(child.tail and child.tail.strip() for child in node)))
        if node.text is not None and (not len(node) or mixed):
            add(path + "/text()", node.text, "text")
        if len(node):
            # Crypto child order is excluded, because its removal is deliberate.
            tags = [child.tag for child in node if not _crypto_tag(child.tag)]
            if tags:
                add(path + "/children-order()", " | ".join(tags), "order")
        counts: Counter[str] = Counter()
        for child in node:
            counts[child.tag] += 1
            child_path = f"{path}/{child.tag}[{counts[child.tag]}]"
            visit(child, child_path)
            if child.tail is not None and mixed:
                add(child_path + "/tail()", child.tail, "text")
    visit(root, f"/{root.tag}[1]")
    return rows


def compare_titles(reference: bytes, generated: bytes) -> list[dict[str, Any]]:
    """Compare reparsed serialized output, never the in-memory snapshot."""
    left = {row["path"]: row for row in flatten_title(reference)}
    right = {row["path"]: row for row in flatten_title(generated)}
    result: list[dict[str, Any]] = []
    for path in dict.fromkeys([*left, *right]):
        a, b = left.get(path), right.get(path)
        source = a or b
        assert source is not None
        av, bv = a["value"] if a else None, b["value"] if b else None
        matched = a is not None and b is not None and av == bv
        kind, category = source["kind"], source["category"]
        if matched:
            reason = "Точное совпадение"
            if category == "signatory":
                reason = "Исторические сведения подписанта сохранены; криптографической подписи нет."
            elif path == "/Файл[1]/@ИдФайл":
                reason = "Совпадает идентификатор исходного файла; не является новым обменом."
        elif kind == "crypto" and b is None:
            reason = "Исходная криптографическая подпись удалена; новая подпись не создавалась."
        elif path in SERVICE_REASONS:
            reason = SERVICE_REASONS[path]
        elif re.fullmatch(r"/Файл\[1\]/Документ\[1\]/СодИнфГО\[1\]/ИнфПол\[\d+\]/@ИдФайлИнфПол", path):
            reason = "Новый локальный UUID информационного поля; его текстовые значения сохранены."
        elif a is None:
            reason = "Дополнительное поле в нашем документе; требуется сверка."
        elif b is None:
            reason = "Поле эталона отсутствует в нашем документе; требуется сверка."
        else:
            reason = "Значение различается; без округления или нормализации."
        result.append({"path": path, "category": category, "kind": kind,
                       "reference": av, "generated": bv, "match": matched, "reason": reason})
    return result


def exact_convert(value: str, from_unit: str, to_unit: str) -> str:
    """Exact decimal kg/t and litre/m³ conversion; caller chooses presentation."""
    exponents = {("kg", "t"): -3, ("t", "kg"): 3, ("l", "m3"): -3, ("m3", "l"): 3}
    if not isinstance(value, str) or not re.fullmatch(r"[+-]?\d+(?:\.\d+)?", value):
        raise ReplayError("Decimal quantity must be a plain string, never float")
    if (from_unit, to_unit) not in exponents:
        raise ReplayError("Unsupported unit conversion")
    try:
        with localcontext() as ctx:
            ctx.prec = max(28, len(value) + 10)
            result = Decimal(value).scaleb(exponents[(from_unit, to_unit)])
            return format(result, "f")
    except InvalidOperation as exc:
        raise ReplayError("Invalid decimal quantity") from exc
