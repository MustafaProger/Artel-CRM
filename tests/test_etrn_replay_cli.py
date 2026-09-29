"""Synthetic-only regressions for the offline ЭТрН report and private outputs.

These tests use fresh temporary directories and made-up XML. They never read
the saved real sample, CRM storage, browser sessions, or Saby credentials.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
SPEC = importlib.util.spec_from_file_location("etrn_replay_cli", SCRIPTS / "replay_saby_etrn.py")
assert SPEC and SPEC.loader
cli = importlib.util.module_from_spec(SPEC)
sys.path.insert(0, str(SCRIPTS))
try:
    SPEC.loader.exec_module(cli)
finally:
    sys.path.pop(0)


def synthetic_title(volume: str = "3.125", mass: str = "2500.01200") -> bytes:
    root = ET.Element("Файл", {
        "ИдФайл": "ON_TRNACLGROT_TESTREC_TESTSEND_0_20300102_11111111-1111-4111-8111-111111111111",
        "ВерсФорм": "5.01", "ВерсПрог": "Synthetic CLI fixture",
    })
    doc = ET.SubElement(root, "Документ", {
        "КНД": "1110339", "ДатИнфГО": "02.01.2030", "ВрИнфГО": "10:20:30", "ПоФактХЖ": "1",
    })
    content = ET.SubElement(doc, "СодИнфГО", {
        "НомерТрН": "SYN-42", "ДатаТрН": "01.01.2030",
        "УИД_ТрН": "22222222-2222-4222-8222-222222222222",
    })
    cargo = ET.SubElement(ET.SubElement(content, "СвГруз"), "ОпГруз", {
        "Объем": volume, "НаимГруз": 'Synthetic <script>alert("fixture")</script> & cargo',
    })
    ET.SubElement(cargo, "ПлМасГруз", {"МасБрутЗнач": mass})
    vehicle = ET.SubElement(ET.SubElement(content, "СвТС"), "ТС", {"РегНомер": "TEST-VEHICLE"})
    ET.SubElement(vehicle, "ПарТС", {"Вместим": "10", "Грузопод": "12.345"})
    ET.SubElement(ET.SubElement(content, "СвВодит"), "ФИО", {"Имя": "Синтетический"})
    return ET.tostring(root, encoding="windows-1251", xml_declaration=True)


def make_archive(directory: Path) -> tuple[Path, bytes]:
    archive = directory / "archive"
    originals = archive / "originals"
    originals.mkdir(parents=True)
    raw = b"synthetic immutable archive bytes\n"
    (originals / "sample.xml").write_bytes(raw)
    manifest = {"file_count": 1, "files": [{
        "path": "sample.xml", "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
    }]}
    (archive / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return archive, raw


class GeneratedDocumentTests(unittest.TestCase):
    def test_missing_cargo_or_mass_can_still_be_reported(self):
        for missing in ['cargo', 'mass']:
            root = ET.fromstring(synthetic_title())
            cargo = root.find('.//СвГруз/ОпГруз')
            if missing == 'cargo':
                root.find('.//СвГруз').remove(cargo)
            else:
                cargo.remove(cargo.find('ПлМасГруз'))
            raw = ET.tostring(root, encoding='windows-1251', xml_declaration=True)
            summary = cli.generated_diagnostics(raw)
            self.assertIsNone(summary['mass_kg'])
            self.assertIsNone(summary['mass_tonnes'])
            self.assertIn('— отсутствует —', cli.make_document(raw, summary))

    def test_metrics_are_derived_from_generated_xml_with_exact_precision(self):
        raw = synthetic_title()
        summary = cli.generated_diagnostics(raw)
        self.assertEqual(summary["volume_m3"], "3.125")
        self.assertEqual(summary["volume_litres"], "3125")
        self.assertEqual(summary["mass_kg"], "2500.01200")
        self.assertEqual(summary["mass_tonnes"], "2.50001200")
        document = cli.make_document(raw, summary)
        self.assertIn("3125 л</strong>", document)
        self.assertIn("2.50001200 т</strong>", document)
        self.assertIn(hashlib.sha256(raw).hexdigest(), document)

    def test_mutated_generated_values_change_the_visible_metrics(self):
        first = synthetic_title()
        changed = synthetic_title(volume="4.000001", mass="3333.33300")
        original_document = cli.make_document(first, cli.generated_diagnostics(first))
        changed_document = cli.make_document(changed, cli.generated_diagnostics(changed))
        self.assertIn("3125 л</strong>", original_document)
        self.assertIn("4000.001 л</strong>", changed_document)
        self.assertIn("3.33333300 т</strong>", changed_document)
        self.assertNotIn("3125 л</strong>", changed_document)
        self.assertNotIn("2.50001200 т</strong>", changed_document)

    def test_source_values_are_escaped_in_html(self):
        raw = synthetic_title()
        document = cli.make_document(raw, cli.generated_diagnostics(raw))
        self.assertNotIn('<script>alert("fixture")</script>', document)
        self.assertIn("&lt;script&gt;alert(&quot;fixture&quot;)&lt;/script&gt; &amp; cargo", document)
        self.assertIn("ТЕСТ · БЕЗ ПОДПИСИ · НЕ ОТПРАВЛЕНО", document)

    def test_table_distinguishes_absence_from_empty_value(self):
        result = cli.table([{
            "path": "/Synthetic/@empty", "reference": "", "generated": None,
            "match": False, "reason": "Synthetic missing attribute",
        }])
        self.assertIn("〈пустое значение〉", result)
        self.assertIn("— отсутствует —", result)
        self.assertIn("Synthetic missing attribute", result)


class RenderedArtifactsTests(unittest.TestCase):
    def test_only_known_derived_artifacts_are_invalidated(self):
        derived = {
            "test-document.pdf", "test-document-1440.png", "test-document-390.png",
            "comparison-1440.png", "comparison-390.png", "browser-checks.json",
            "pdf-comparison.json",
        }
        retained = {
            "reference.pdf", "snapshot.json", "scenario.json", "generated-title-1.xml",
            "comparison.json", "test-document.html", "comparison.html", "private-notes.txt",
            "unknown-preview.png",
        }
        with tempfile.TemporaryDirectory(prefix="etrn-cli-synthetic-") as folder:
            output = Path(folder)
            for name in derived | retained:
                (output / name).write_text("synthetic " + name, encoding="utf-8")
            cli.invalidates_rendered(output)
            self.assertEqual({p.name for p in output.iterdir()}, retained)
            for name in retained:
                self.assertEqual((output / name).read_text(), "synthetic " + name)
            # First-time runs and repeated invalidation must also be supported.
            cli.invalidates_rendered(output)
            self.assertEqual({p.name for p in output.iterdir()}, retained)

    def test_derived_symlink_never_modifies_its_target(self):
        with tempfile.TemporaryDirectory(prefix="etrn-cli-synthetic-") as folder:
            base = Path(folder)
            output = base / "output"
            output.mkdir()
            target = base / "reference-like-synthetic.pdf"
            target.write_bytes(b"synthetic immutable bytes")
            (output / "test-document.pdf").symlink_to(target)
            try:
                cli.invalidates_rendered(output)
            except ValueError:
                # Refusing the symlink or unlinking just it both protect its target.
                pass
            self.assertEqual(target.read_bytes(), b"synthetic immutable bytes")


class ArchiveIntegrityTests(unittest.TestCase):
    def test_manifest_verification_is_read_only(self):
        with tempfile.TemporaryDirectory(prefix="etrn-cli-synthetic-") as folder:
            archive, raw = make_archive(Path(folder))
            before = {p.relative_to(archive): p.read_bytes() for p in archive.rglob("*") if p.is_file()}
            result = cli.verify_archive(archive)
            self.assertEqual(result["files"], 1)
            self.assertTrue(result["sha256_verified"])
            self.assertEqual((archive / "originals/sample.xml").read_bytes(), raw)
            self.assertEqual(before, {p.relative_to(archive): p.read_bytes() for p in archive.rglob("*") if p.is_file()})

    def test_parent_traversal_and_absolute_paths_are_refused(self):
        for kind in ("parent", "absolute"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(prefix="etrn-cli-synthetic-") as folder:
                archive, raw = make_archive(Path(folder))
                outside = archive / "outside.xml"
                outside.write_bytes(raw)
                manifest_path = archive / "manifest.json"
                manifest = json.loads(manifest_path.read_text())
                manifest["files"][0]["path"] = "../outside.xml" if kind == "parent" else str(outside)
                manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "Unsafe manifest path"):
                    cli.verify_archive(archive)
                self.assertEqual(outside.read_bytes(), raw)

    def test_symlink_in_manifest_is_refused(self):
        with tempfile.TemporaryDirectory(prefix="etrn-cli-synthetic-") as folder:
            archive, raw = make_archive(Path(folder))
            target = archive / "originals/sample.xml"
            target.unlink()
            outside = Path(folder) / "outside.xml"
            outside.write_bytes(raw)
            target.symlink_to(outside)
            with self.assertRaisesRegex(ValueError, "Unsafe manifest path"):
                cli.verify_archive(archive)
            self.assertEqual(outside.read_bytes(), raw)

    def test_unlisted_file_and_modified_bytes_are_refused(self):
        for kind in ("extra", "modified"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(prefix="etrn-cli-synthetic-") as folder:
                archive, _ = make_archive(Path(folder))
                if kind == "extra":
                    (archive / "originals/unlisted.xml").write_bytes(b"synthetic additional file")
                else:
                    (archive / "originals/sample.xml").write_bytes(b"synthetic changed bytes")
                with self.assertRaises(ValueError):
                    cli.verify_archive(archive)


if __name__ == "__main__":
    unittest.main()
