"""Synthetic-only tests: never read real XML, PDF, credentials or CRM stores."""

from __future__ import annotations

from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET

SPEC = importlib.util.spec_from_file_location("etrn_replay", Path(__file__).resolve().parents[1] / "scripts/lib/etrn_replay.py")
assert SPEC and SPEC.loader
replay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(replay)

ORIGINAL_UUID = "11111111-1111-4111-8111-111111111111"
REPLAY_UUID = "22222222-2222-4222-8222-222222222222"
AT = "2026-09-29T12:34:56+03:00"
FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures/saby"
SCHEMA = FIXTURE_DIR / "consignment-note-1110339-5.01.xsd"
COMPLETE_SYNTHETIC = FIXTURE_DIR / "consignment-note.synthetic.xml"


def fixture(extra: str = "") -> bytes:
    # All identities and values below are made up for testing.
    xml = f'''<?xml version="1.0" encoding="windows-1251"?>
<Файл ВерсПрог="Synthetic" ВерсФорм="5.01" ИдФайл="ON_TRNACLGROT_TESTREC_TESTSEND_0_20260915_{ORIGINAL_UUID}">
 <Документ КНД="1110339" ДатИнфГО="15.09.2026" ВрИнфГО="09:10:11" ПоФактХЖ="1">
  <СодИнфГО УИД_ТрН="33333333-3333-4333-8333-333333333333" НомерТрН="TEST-7" ДатаТрН="15.09.2026" НомЗак="TEST-5" ДатаЗак="14.09.2026">
   <СвГО><РекИдентГО><ИдСв><СвЮЛУч НаимОрг="Синтетический отправитель &amp; тест" ИННЮЛ="0000000000" КПП="000000000" /></ИдСв></РекИдентГО></СвГО>
   <СвГП><АдресДостГр><АдресИнф АдрТекст="Тестовый адрес 1" КодСтр="643" /></АдресДостГр></СвГП>
   <СвПер><ИдСв><СвЮЛУч НаимОрг="Синтетический перевозчик" ИННЮЛ="1111111111" /></ИдСв></СвПер>
   <СвВодит СерВУ="0000" НомВУ="111111"><ФИО Фамилия="Тестов" Имя="Тест" Отчество="Тестович" /><Тлф>+70000000000</Тлф><Тлф>+70000000001</Тлф></СвВодит>
   <СвТС><ТС РегНомер="Т000ТТ00"><ПарТС Вместим="9.000" Грузопод="27.90" /><ОснАрЛиз НаимДок="Тестовый договор" НомерДок="SYN-1" ДатаДок="01.01.2026" /></ТС></СвТС>
   <СвГруз><ОпГруз НаимГруз="Синтетический груз" Объем="8.001" КолМестГр="1" СпУпак="налив"><ПлМасГруз МасБрутЗнач="6718.0100" /><СвОпГруз НомООН="1202" /></ОпГруз></СвГруз>
   <СвПогруз ФДатВрПриб="15.09.2026T11:12:13" ФДатВрУбыт="15.09.2026T12:13:14" />
   <ИнфПол ИдФайлИнфПол="44444444-4444-4444-8444-444444444444"><ТекстИнф Идентиф="Тест" Значение="" /></ИнфПол>
   <Неизвестное Поле="Точное значение 00.1000"><Пустой /><Пробел> </Пробел></Неизвестное>
   {extra}
  </СодИнфГО>
  <Подписант Должн="Тестовая должность" СтатПодп="1"><ФИО Фамилия="Синтетический" Имя="Подписант" /></Подписант>
 </Документ>
</Файл>'''
    return xml.encode("cp1251")


def generated(source: bytes | None = None) -> bytes:
    return replay.generate_title(replay.import_snapshot(source or fixture()), AT, REPLAY_UUID)


def mutate(data: bytes, path: str, attr: str | None, value: str | None) -> bytes:
    root = ET.fromstring(data.decode("cp1251"))
    node = root.find(path)
    assert node is not None
    if attr:
        if value is None:
            del node.attrib[attr]
        else:
            node.set(attr, value)
    else:
        node.text = value
    return ET.tostring(root, encoding="windows-1251", xml_declaration=True)


class ReplayTests(unittest.TestCase):
    def test_business_and_signatory_exact_from_actual_xml(self):
        rows = replay.compare_titles(fixture(), generated())
        substantive = [r for r in rows if r["category"] in ("business", "signatory")]
        self.assertTrue(substantive)
        self.assertTrue(all(r["match"] for r in substantive))
        self.assertEqual(len([r for r in rows if not r["match"]]), 6)

    def test_model_is_json_serializable_and_editable(self):
        snapshot = json.loads(json.dumps(replay.import_snapshot(fixture()), ensure_ascii=False))
        root = snapshot["root"]
        self.assertIsInstance(root["attributes"], list)
        content = root["children"][0]["children"][0]
        driver = next(n for n in content["children"] if n["tag"] == "СвВодит")
        driver["attributes"][0][1] = "9999"
        result = replay.generate_title(snapshot, AT, REPLAY_UUID)
        rows = replay.compare_titles(fixture(), result)
        self.assertEqual([r["generated"] for r in rows if r["path"].endswith("/@СерВУ")], ["9999"])

    def test_business_mutations_are_detected(self):
        cases = [("./Документ/СодИнфГО/СвГруз/ОпГруз/ПлМасГруз", "МасБрутЗнач", "6718.01"),
                 ("./Документ/СодИнфГО/СвГП/АдресДостГр/АдресИнф", "АдрТекст", "Иной адрес"),
                 ("./Документ/СодИнфГО/СвТС/ТС/ОснАрЛиз", "НомерДок", "SYN-2"),
                 ("./Документ/СодИнфГО/Неизвестное", "Поле", "00.1"),
                 ("./Документ/СодИнфГО/СвПогруз", "ФДатВрПриб", "15.09.2026T11:12:14")]
        for path, attr, value in cases:
            with self.subTest(attr=attr):
                rows = replay.compare_titles(fixture(), mutate(generated(), path, attr, value))
                diff = [r for r in rows if r["category"] == "business" and not r["match"]]
                self.assertEqual(len(diff), 1)
                self.assertEqual(diff[0]["generated"], value)

    def test_empty_attribute_is_not_absent(self):
        rows = replay.compare_titles(fixture(), mutate(generated(), "./Документ/СодИнфГО/ИнфПол/ТекстИнф", "Значение", None))
        diff = next(r for r in rows if r["path"].endswith("/@Значение"))
        self.assertEqual(diff["reference"], "")
        self.assertIsNone(diff["generated"])
        self.assertFalse(diff["match"])

    def test_empty_element_is_not_absent(self):
        root = ET.fromstring(generated().decode("cp1251"))
        unknown = root.find("./Документ/СодИнфГО/Неизвестное")
        unknown.remove(unknown.find("Пустой"))
        rows = replay.compare_titles(fixture(), ET.tostring(root, encoding="windows-1251"))
        diff = next(r for r in rows if r["path"].endswith("/Пустой[1]"))
        self.assertEqual(diff["reference"], "<present>")
        self.assertIsNone(diff["generated"])

    def test_extra_field_is_detected(self):
        rows = replay.compare_titles(fixture(), generated(fixture('<Добавлено Новое="значение" />')))
        self.assertTrue(any(r["reference"] is None and r["generated"] == "значение" and not r["match"] for r in rows))

    def test_repeated_paths_are_indexed(self):
        rows = replay.flatten_title(fixture())
        phones = [r for r in rows if "/СвВодит[1]/Тлф[" in r["path"] and r["kind"] == "text"]
        self.assertEqual(len(phones), 2)
        self.assertIn("Тлф[1]", phones[0]["path"])
        self.assertIn("Тлф[2]", phones[1]["path"])
        result = mutate(generated(), "./Документ/СодИнфГО/СвВодит/Тлф[2]", None, "+70000000002")
        diffs = [r for r in replay.compare_titles(fixture(), result) if r["category"] == "business" and not r["match"]]
        self.assertEqual(len(diffs), 1)
        self.assertIn("Тлф[2]", diffs[0]["path"])

    def test_child_order_is_preserved_and_detected(self):
        root = ET.fromstring(generated().decode("cp1251"))
        driver = root.find("./Документ/СодИнфГО/СвВодит")
        child = driver[0]
        driver.remove(child)
        driver.append(child)
        rows = replay.compare_titles(fixture(), ET.tostring(root, encoding="windows-1251"))
        self.assertTrue(any(r["kind"] == "order" and not r["match"] for r in rows))

    def test_signature_content_is_removed(self):
        source = fixture('<СвПодп ЭП="SYNTHETIC_SIGNATURE" /><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignatureValue>OTHER_SYNTHETIC_SIGNATURE</ds:SignatureValue></ds:Signature>')
        snapshot = replay.import_snapshot(source)
        self.assertEqual(len(snapshot["removed_crypto_paths"]), 2)
        self.assertNotIn("SYNTHETIC_SIGNATURE", json.dumps(snapshot))
        result = replay.generate_title(snapshot, AT, REPLAY_UUID)
        self.assertNotIn(b"SYNTHETIC_SIGNATURE", result)
        rows = replay.compare_titles(source, result)
        crypto = [r for r in rows if r["kind"] == "crypto"]
        self.assertEqual(len(crypto), 2)
        self.assertTrue(all(r["category"] == "service" and r["generated"] is None and r["reference"].startswith("sha256:") for r in crypto))
        self.assertTrue(all(r["match"] for r in rows if r["category"] == "signatory"))

    def test_injected_snapshot_signature_is_also_removed(self):
        snapshot = replay.import_snapshot(fixture())
        snapshot["root"]["attributes"].append(["ЭП", "INJECTED_TEST_SIGNATURE"])
        self.assertNotIn(b"INJECTED_TEST_SIGNATURE", replay.generate_title(snapshot, AT, REPLAY_UUID))

    def test_windows1251_and_utf8_inputs(self):
        source = fixture().decode("cp1251").replace('encoding="windows-1251"', 'encoding="utf-8"').encode("utf-8")
        result = generated(source)
        self.assertIn(b"encoding='windows-1251'", result[:100])
        self.assertTrue(all(r["match"] for r in replay.compare_titles(fixture(), result) if r["category"] == "business"))

    def test_wrong_document_kind_and_version_rejected(self):
        for token, replacement in (("1110339", "1110361"), ("5.01", "5.02"), ("ON_TRNACLGROT", "ON_TRNACLPPRIN")):
            with self.subTest(token=token), self.assertRaises(replay.ReplayError):
                replay.import_snapshot(fixture().replace(token.encode(), replacement.encode()))

    def test_four_titles_can_be_flattened_but_only_first_imported(self):
        for knd, prefix in replay.TITLE_PREFIXES.items():
            source = fixture().replace(b"1110339", knd.encode()).replace(b"ON_TRNACLGROT", prefix.encode())
            self.assertTrue(replay.flatten_title(source))
            if knd != "1110339":
                with self.assertRaises(replay.ReplayError):
                    replay.import_snapshot(source)

    def test_dtd_entity_and_malformed_xml_rejected(self):
        payloads = [b'<!DOCTYPE root [<!ENTITY x "value">]><root>&x;</root>',
                    b'<!DOCTYPE root SYSTEM "file:///not-read"><root/>',
                    b'<root><broken></root>', b'<!ENTITY x SYSTEM "https://not-called">']
        for payload in payloads:
            with self.subTest(payload=payload[:20]), self.assertRaises(replay.ReplayError):
                replay.import_snapshot(payload)

    def test_file_identifier_validation(self):
        for bad in ("OTHER_20260915_" + ORIGINAL_UUID, "ON_TRNACLGROT_TEST_20261399_" + ORIGINAL_UUID,
                    "ON_TRNACLGROT_TEST_20260915_BAD", "ON_TRNACLGROT_../TEST_20260915_" + ORIGINAL_UUID,
                    "ON_TRNACLGROT__20260915_" + ORIGINAL_UUID):
            with self.subTest(case=bad[:20]), self.assertRaises(replay.ReplayError):
                source = mutate(fixture(), ".", "ИдФайл", bad)
                replay.import_snapshot(source)

    def test_timezone_and_uuid_required(self):
        snapshot = replay.import_snapshot(fixture())
        for at, uid in (("2026-09-29T12:00:00", REPLAY_UUID), ("invalid", REPLAY_UUID), (AT, "abc"), (AT, ORIGINAL_UUID)):
            with self.subTest(at=at, uid=uid), self.assertRaises(replay.ReplayError):
                replay.generate_title(snapshot, at, uid)

    def test_deterministic_output_and_new_uuid(self):
        a, b = generated(), generated()
        self.assertEqual(a, b)
        root = ET.fromstring(a.decode("cp1251"))
        self.assertTrue(root.get("ИдФайл").endswith("20260929_" + REPLAY_UUID))
        self.assertNotEqual(root.find("./Документ/СодИнфГО").get("УИД_ТрН"), "33333333-3333-4333-8333-333333333333")
        other = replay.generate_title(replay.import_snapshot(fixture()), AT, "55555555-5555-4555-8555-555555555555")
        self.assertNotEqual(a, other)

    def test_source_model_is_not_mutated(self):
        snapshot = replay.import_snapshot(fixture())
        original = deepcopy(snapshot)
        replay.generate_title(snapshot, AT, REPLAY_UUID)
        self.assertEqual(snapshot, original)

    def test_mixed_content_and_leaf_whitespace_are_preserved(self):
        source = fixture('<Смешанное> <Внутри />хвост<Следующее /> </Смешанное>')
        rows = replay.compare_titles(source, generated(source))
        self.assertTrue(all(r["match"] for r in rows if r["category"] == "business"))
        self.assertTrue(any(r["reference"] == " " for r in rows if r["kind"] == "text"))

    def test_no_whitespace_only_indentation_differences(self):
        source = fixture()
        compact = source.replace(b"\n ", b"").replace(b"\n</", b"</")
        rows = replay.compare_titles(source, compact)
        self.assertTrue(all(r["match"] for r in rows))

    def test_invalid_snapshot_and_nonstring_numbers_rejected(self):
        for mutation in (lambda s: s["root"]["attributes"].append(["ВерсФорм", "5.01"]),
                         lambda s: s["root"]["attributes"].append(["Number", 1.234]),
                         lambda s: s["root"].update(text=42),
                         lambda s: s.update(scope="TransportOrder")):
            with self.subTest(mutation=mutation), self.assertRaises(replay.ReplayError):
                snapshot = replay.import_snapshot(fixture())
                mutation(snapshot)
                replay.generate_title(snapshot, AT, REPLAY_UUID)

    def test_comments_inside_root_rejected_explicitly(self):
        with self.assertRaises(replay.ReplayError):
            replay.import_snapshot(fixture("<!-- unsupported -->"))

    def test_comments_and_pi_outside_root_rejected(self):
        for extra in (b"<!-- trailing -->", b"<?processing ignored?>"):
            with self.subTest(extra=extra), self.assertRaises(replay.ReplayError):
                replay.import_snapshot(fixture() + extra)

    def test_signature_with_mixed_tail_rejected(self):
        with self.assertRaises(replay.ReplayError):
            replay.import_snapshot(fixture('<Signature>test</Signature>meaningful tail'))

    def test_deep_xml_rejected(self):
        with self.assertRaises(replay.ReplayError):
            replay.import_snapshot(fixture("<Deep>" * 105 + "</Deep>" * 105))

    def test_exact_decimal_conversions_no_float(self):
        cases = [("6718", "kg", "t", "6.718"), ("6.7180100", "t", "kg", "6718.0100"),
                 ("8001", "l", "m3", "8.001"), ("8.001", "m3", "l", "8001"),
                 ("123456789012345678901234567890.123456", "kg", "t", "123456789012345678901234567.890123456")]
        for value, source, target, expected in cases:
            with self.subTest(value=value):
                self.assertEqual(replay.exact_convert(value, source, target), expected)
        for value in (1.5, "NaN", "1e6", "8,001", "1.0 kg"):
            with self.subTest(value=value), self.assertRaises(replay.ReplayError):
                replay.exact_convert(value, "kg", "t")


class SchemaRegressionTests(unittest.TestCase):
    """Serializer regression against the public schema compatibility copy.

    All data is synthetic and describes no actual consignment. The XSD's
    separate Schematron annotations are not executed by xmllint. See the
    fixture README for provenance and the two regex compatibility changes.
    """

    def validate(self, data: bytes) -> subprocess.CompletedProcess:
        xmllint = shutil.which("xmllint")
        self.assertIsNotNone(xmllint, "xmllint is required for offline official-schema regression tests")
        with tempfile.TemporaryDirectory(prefix="etrn-synthetic-xsd-") as directory:
            title = Path(directory) / "synthetic-title.xml"
            title.write_bytes(data)
            return subprocess.run([xmllint, "--nonet", "--noout", "--schema", str(SCHEMA), str(title)],
                                  capture_output=True, text=True, check=False)

    def test_complete_synthetic_reference_passes_xsd(self):
        result = self.validate(COMPLETE_SYNTHETIC.read_bytes())
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rebuilt_complete_title_passes_xsd_and_preserves_fields(self):
        source = COMPLETE_SYNTHETIC.read_bytes()
        output = replay.generate_title(replay.import_snapshot(source), "2025-05-06T01:02:03Z", REPLAY_UUID)
        result = self.validate(output)
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = replay.compare_titles(source, output)
        self.assertTrue(all(row["match"] for row in rows if row["category"] != "service"))
        doc = ET.fromstring(output.decode("cp1251")).find("Документ")
        self.assertEqual(doc.get("ДатИнфГО"), "06.05.2025")
        self.assertEqual(doc.get("ВрИнфГО"), "01:02:03")
        # The explicit caller timezone is used, independently of the host TZ.
        same = replay.generate_title(replay.import_snapshot(source), "2025-05-06T01:02:03+00:00", REPLAY_UUID)
        self.assertEqual(output, same)

    def test_schema_rejects_extra_fractional_digit_without_rounding(self):
        source = COMPLETE_SYNTHETIC.read_bytes()
        output = replay.generate_title(replay.import_snapshot(source), AT, REPLAY_UUID)
        mutated = mutate(output, "./Документ/СодИнфГО/СвГруз/ОпГруз/ПлМасГруз", "МасБрутЗнач", "5123.1251")
        result = self.validate(mutated)
        self.assertNotEqual(result.returncode, 0)
        rows = replay.compare_titles(source, mutated)
        row = next(row for row in rows if row["path"].endswith("/@МасБрутЗнач"))
        self.assertFalse(row["match"])
        self.assertEqual(row["generated"], "5123.1251")

    def test_schema_rejects_lost_required_driver_and_cargo_fields(self):
        output = replay.generate_title(replay.import_snapshot(COMPLETE_SYNTHETIC.read_bytes()), AT, REPLAY_UUID)
        for path, attribute in (("./Документ/СодИнфГО/СвВодит/ФИО", "Фамилия"),
                                ("./Документ/СодИнфГО/СвГруз/ОпГруз", "НаимГруз")):
            with self.subTest(attribute=attribute):
                result = self.validate(mutate(output, path, attribute, None))
                self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
