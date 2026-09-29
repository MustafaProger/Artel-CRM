#!/usr/bin/env python3
"""Optional pypdf presentation audit. Writes all values to private output only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import xml.etree.ElementTree as ET
from pypdf import PdfReader


def normalized(value):
    return re.sub(r'\s+', '', value).casefold()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    repo = Path(__file__).resolve().parents[1]
    if output.is_relative_to(repo) or any(p.is_symlink() for p in [args.output, *args.output.parents]):
        raise ValueError('Private output outside checkout required')
    os.umask(0o077)
    files = {}
    texts = {}
    for name in ['reference', 'test-document']:
        file = output / (name + '.pdf')
        if file.is_symlink():
            raise ValueError('Symlink refused')
        reader = PdfReader(file)
        pages = [page.extract_text() or '' for page in reader.pages]
        texts[name] = '\n'.join(pages)
        files[name] = {'pages': len(pages), 'characters': sum(map(len, pages)), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()}
    root = ET.fromstring((output / 'generated-title-1.xml').read_bytes())
    xml_sha = hashlib.sha256((output / 'generated-title-1.xml').read_bytes()).hexdigest()
    browser = json.loads((output / 'browser-checks.json').read_text())
    if browser['generatedXmlSha256'] != xml_sha or browser['pdfSha256'] != files['test-document']['sha256']:
        raise ValueError('Rendered PDF does not match current generated XML')
    checks = []
    # Long visible business values make a meaningful PDF extraction coverage check;
    # short numbers/codes can occur elsewhere and cannot prove field placement.
    for node in root.find('Документ').find('СодИнфГО').iter():
        for key, value in [*node.attrib.items(), ('text', node.text or '')]:
            if key in ['УИД_ТрН', 'ИдФайлИнфПол'] or len(value.strip()) < 8:
                continue
            checks.append({'element': node.tag, 'field': key, 'value': value,
                           'in_our_pdf': normalized(value) in normalized(texts['test-document']),
                           'in_reference_pdf': normalized(value) in normalized(texts['reference'])})
    result = {'files': files, 'checks': checks, 'generated_xml_sha256': xml_sha, 'render_evidence_matches': True,
              'our_visible_long_values_missing': sum(not row['in_our_pdf'] for row in checks),
              'same_layout': False, 'same_bytes': False, 'new_signatures': False,
              'differences': ['Наш PDF отображает только титул 1; исходный — совокупность четырёх титулов.',
                              'QR и штампы сертификатов исходника не воспроизводились.',
                              'Верстка и количество страниц различаются; короткие коды проверяются по XML.',
                              'Наличие текста не доказывает визуальную читаемость, требуется просмотр страниц.']}
    target = output / 'pdf-comparison.json'
    if target.is_symlink():
        raise ValueError('Symlink output refused')
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    target.chmod(0o600)
    print(json.dumps({'reference_pages': files['reference']['pages'], 'our_pages': files['test-document']['pages'], 'visible_long_values_checked': len(checks), 'missing_from_our_pdf': result['our_visible_long_values_missing']}))
    return bool(result['our_visible_long_values_missing'])


if __name__ == '__main__':
    raise SystemExit(main())
