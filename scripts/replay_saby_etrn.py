#!/usr/bin/env python3
"""Offline, private sample-derived first-title rehearsal. No CRM or Saby client.

Outputs contain personal data. The output directory must be outside the checkout
and the immutable input archive. Console output contains counts only.
"""
import argparse
from collections import Counter
from datetime import datetime
import hashlib
import html
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid
import xml.etree.ElementTree as ET

from lib.etrn_replay import import_snapshot, generate_title, compare_titles, flatten_title, exact_convert

REPO = Path(__file__).resolve().parents[1]
TITLE_NAMES = {
    '1110339': 'Титул 1 · грузоотправитель',
    '1110340': 'Титул 2 · перевозчик при приёме',
    '1110341': 'Титул 3 · грузополучатель',
    '1110342': 'Титул 4 · перевозчик при выдаче',
}
LABELS = {
    'СвГО': 'Грузоотправитель', 'СвГП': 'Грузополучатель и доставка',
    'СвПер': 'Перевозчик', 'СвВодит': 'Водитель', 'СвТС': 'Транспорт и основание использования',
    'СвГруз': 'Груз и количество', 'СвПогруз': 'Погрузка', 'УказГО': 'Указания отправителя',
    'ИнфПол': 'Дополнительные сведения', 'Подписант': 'Заявленные сведения подписанта из образца',
    'ДатаЗак': 'Дата заказа', 'ДатаТрН': 'Дата накладной', 'НомЗак': 'Номер заказа',
    'НомерТрН': 'Номер накладной', 'СодОпер': 'Операция', 'НаимОрг': 'Организация',
    'ИННЮЛ': 'ИНН организации', 'КПП': 'КПП', 'ИННФЛ': 'ИНН физического лица',
    'Имя': 'Имя', 'Отчество': 'Отчество', 'Фамилия': 'Фамилия', 'Тлф': 'Телефон',
    'ДатаВыдВУ': 'Дата выдачи ВУ', 'НомВУ': 'Номер ВУ', 'СерВУ': 'Серия ВУ',
    'РегНомер': 'Госномер', 'НомерВИН': 'VIN', 'ТипВлад': 'Вид владения, код',
    'Вместим': 'Вместимость, м³', 'Грузопод': 'Грузоподъёмность в эталоне, т ⚠',
    'Марка': 'Марка', 'Тип': 'Тип', 'НаимДок': 'Документ-основание',
    'ДатаДок': 'Дата основания', 'НомерДок': 'Номер основания', 'Объем': 'Объём, м³',
    'МасБрутЗнач': 'Масса брутто, кг', 'МасБрутОтгр': 'Масса отгруженная, кг',
    'НаимГруз': 'Наименование груза', 'СостГруз': 'Состояние груза', 'СпУпак': 'Упаковка',
    'ВидТар': 'Тара, код', 'КолМестГр': 'Число мест', 'НомООН': 'Номер ООН',
    'Клас': 'Класс опасности', 'КласКод': 'Классификационный код', 'ГрУп': 'Группа упаковки',
    'ЗнОп': 'Знак опасности', 'КодОгрЧерТун': 'Ограничение тоннелей',
    'НадОтгНаим': 'Надлежащее отгрузочное наименование', 'АдрТекст': 'Адрес',
    'Широта': 'Широта', 'Долгота': 'Долгота', 'ЗаявПогр': 'Заявленная погрузка',
    'ФДатВрПриб': 'Фактическое прибытие', 'ФДатВрУбыт': 'Фактическое убытие',
    'МетОпрМасс': 'Метод определения массы, код', 'Должн': 'Должность',
    'СтатПодп': 'Статус подписанта, код', 'Значение': 'Значение', 'Идентиф': 'Название поля',
    'Дом': 'Дом', 'Улица': 'Улица', 'Кварт': 'Помещение', 'Город': 'Город',
    'Район': 'Район', 'Индекс': 'Индекс', 'КодРегион': 'Регион, код', 'КодСтр': 'Страна, код',
}
CSS = '''
:root{font:15px/1.5 "Arial",sans-serif;color:#182c38;background:#edf1f4}
*{box-sizing:border-box}body{margin:0}main{max-width:1260px;margin:auto;padding:36px}
header{border-top:5px solid #226857;padding:24px 0}h1{font-size:32px;line-height:1.15;margin:12px 0}h2{font-size:21px;margin:24px 0 10px}h3{font-size:16px;margin:0 0 10px}
p{margin:8px 0;overflow-wrap:anywhere}.eyebrow{font-size:12px;letter-spacing:.08em;color:#226857;font-weight:700}.muted{color:#617481}
.notice{background:#fff4d8;border-left:4px solid #bb8625;padding:12px 16px;margin:16px 0}
.metrics{display:flex;gap:14px;flex-wrap:wrap}.metric,.card{background:white;border:1px solid #dce4e8;border-radius:9px;padding:18px}.metric{flex:1;min-width:180px}.metric strong{display:block;font-size:28px}
.cards{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}.wide{grid-column:1/-1}
table{border-collapse:collapse;width:100%;background:white;font-size:12px;table-layout:fixed}th,td{padding:9px 10px;vertical-align:top;border-bottom:1px solid #dce4e8;text-align:left;overflow-wrap:anywhere;white-space:pre-wrap}th{background:#e5eeeb;color:#244b41}th:first-child{width:27%}
.kv td:first-child{width:45%;color:#586b76}.ok{color:#206e46}.different{color:#9c541e}.path{display:block;font-size:10px;color:#6d7c86;margin-top:4px;overflow-wrap:anywhere}code{font-size:11px}details{margin:15px 0}summary{cursor:pointer;font-weight:600;padding:12px;background:#e5eeeb}a{color:#216e60}.links{display:flex;gap:20px;flex-wrap:wrap}.tag{font-size:12px;border:1px solid #c7d6d0;border-radius:20px;padding:5px 10px;display:inline-block}
@media(max-width:760px){main{padding:16px}.cards{grid-template-columns:1fr}h1{font-size:25px}th,td{padding:6px 5px;font-size:11px}.metrics{gap:8px}}
@media print{:root{background:white}@page{size:A4;margin:14mm}body{background:white;font-size:10px}main{padding:0;max-width:none}h1{font-size:25px}h2{font-size:16px}.cards{display:block}.card{padding:12px;margin-bottom:10px;break-inside:avoid}.kv{font-size:10px}.kv td{padding:4px 5px}.kv td:first-child{width:35%}.links,.no-print,.kv .path{display:none}header{padding:8px 0}table{font-size:9px}tr{break-inside:avoid}.notice{font-size:10px}h2,h3{break-after:avoid}}
'''


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(path, data):
    if path.is_symlink():
        raise ValueError('Symlink output refused')
    with open(path, 'wb' if isinstance(data, bytes) else 'w', **({} if isinstance(data, bytes) else {'encoding': 'utf-8'})) as file:
        file.write(data)
    path.chmod(0o600)


def json_save(path, data):
    save(path, json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def invalidates_rendered(output):
    """Prevent a prior PDF from masquerading as the current XML after a replay."""
    names = ['test-document.pdf', 'pdf-comparison.json', 'browser-checks.json',
             'visual-review.json', 'test-document-contact-sheet.png']
    names += [f'{stem}-{width}.png' for stem in ['test-document', 'comparison'] for width in [1440, 390]]
    names += [path.name for path in output.iterdir() if re.fullmatch(r'test-document-page-\d+\.png', path.name)]
    for name in names:
        path = output / name
        if path.is_symlink():
            raise ValueError('Symlink derived artifact refused')
        if path.exists():
            path.unlink()


def e(value):
    if value is None:
        return '— отсутствует —'
    if value == '':
        return '〈пустое значение〉'
    return html.escape(str(value))


def page(title, body):
    return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src \'self\' data:; base-uri \'none\'; form-action \'none\'"><title>' + e(title) + '</title><style>' + CSS + '</style></head><body><main>' + body + '</main></body></html>'


def xml_leaves(node, path=''):
    path = path + '/' + node.tag
    for key, value in node.attrib.items():
        yield path + '/@' + key, key, value
    if node.text and node.text.strip():
        yield path + '/text()', node.tag, node.text
    for child in node:
        yield from xml_leaves(child, path)


def card(title, node):
    rows = ''.join('<tr><td>' + e(LABELS.get(key, key)) + '<small class="path">' + e(path) + '</small></td><td>' + e(value) + '</td></tr>' for path, key, value in xml_leaves(node))
    return '<section class="card"><h3>' + e(title) + '</h3><table class="kv">' + rows + '</table></section>'


def make_document(generated, summary):
    root = ET.fromstring(generated)
    doc = root.find('Документ')
    content = doc.find('СодИнфГО')
    heading = ET.Element('Реквизиты', {k: v for k, v in content.attrib.items() if k != 'УИД_ТрН'})
    body = '<header><span class="eyebrow">АРТЭЛЬ · ЛОКАЛЬНОЕ ВОСПРОИЗВЕДЕНИЕ</span><h1>Транспортная накладная №' + e(content.get('НомерТрН')) + '</h1><p>От ' + e(content.get('ДатаТрН')) + ' · первый титул · КНД 1110339 · формат 5.01</p><span class="tag">ТЕСТ · БЕЗ ПОДПИСИ · НЕ ОТПРАВЛЕНО</span></header>'
    body += '<div class="notice">Данные исторической ЭТрН воспроизведены по разрешению пользователя. Это просмотр нового локального XML первого титула. Фактические события здесь относятся к образцу. Рейс в рабочей CRM и документ в Saby не создавались.</div>'
    body += '<div class="metrics"><div class="metric"><strong>' + e(summary['volume_litres']) + ' л</strong>из ' + e(summary['volume_m3']) + ' м³ в XML</div><div class="metric"><strong>' + e(summary['mass_tonnes']) + ' т</strong>из ' + e(summary['mass_kg']) + ' кг в XML</div><div class="metric"><strong>Титул 1 / 4</strong>Титулы 2–4 не создавались</div></div>'
    body += '<div class="notice">⚠ Значение «Грузопод» воспроизводится ровно из эталона. Оно не подтверждает допустимую грузоподъёмность машины для новой перевозки. Данные подписанта ниже являются сведениями из XML, а не электронной подписью.</div><h2>Содержание нашего XML</h2><div class="cards">' + card('Реквизиты перевозки', heading)
    for child in content:
        body += card(LABELS.get(child.tag, child.tag), child)
    for child in doc:
        if child.tag != 'СодИнфГО':
            body += card(LABELS.get(child.tag, child.tag), child)
    body += '</div><h2>Граница документа</h2><p>Подписи, QR, квитанции ГИС, статусы и факты новых действий участников отсутствуют. Печатное представление Артэль отличается от исходной формы Saby; полное сравнение всех полей и последующих титулов — в отчёте.</p><p class="muted">Источник отображения: заново прочитанный generated-title-1.xml. SHA-256: ' + e(digest(generated)) + '</p>'
    return page('ЭТрН · локальный тестовый первый титул', body)


def table(rows):
    body = '<table><thead><tr><th>Поле XML</th><th>Эталон</th><th>Наш документ</th><th>Совпадение / причина</th></tr></thead><tbody>'
    for row in rows:
        label = row['path'].rsplit('/', 1)[-1].lstrip('@')
        reason = 'Совпадает точно' if row['match'] else row['reason']
        body += '<tr><td>' + e(LABELS.get(label, label)) + '<span class="path">' + e(row['path']) + '</span></td><td>' + e(row['reference']) + '</td><td>' + e(row['generated']) + '</td><td class="' + ('ok' if row['match'] else 'different') + '">' + e(reason) + '</td></tr>'
    return body + '</tbody></table>'


def diagnostics(titles):
    first = ET.fromstring(titles['1110339'])
    third = ET.fromstring(titles['1110341'])
    planned = first.find('.//СвГП/АдресДостГр')
    actual = third.find('.//ПриемГрузГП/АдрВыгруз')
    cargo = first.find('.//СвГруз/ОпГруз')
    mass = cargo.find('ПлМасГруз').get('МасБрутЗнач')
    receive = third.find('.//ПриемГрузГП')
    return {
        'volume_m3': cargo.get('Объем'), 'volume_litres': exact_convert(cargo.get('Объем'), 'm3', 'l'),
        'mass_kg': mass, 'mass_tonnes': exact_convert(mass, 'kg', 't'),
        'planned_delivery_address': planned.find('АдресИнф').get('АдрТекст'),
        'actual_delivery_address': actual.find('АдресИнф').get('АдрТекст'),
        'delivery_address_differs': planned.find('АдресИнф').get('АдрТекст') != actual.find('АдресИнф').get('АдрТекст'),
        'delivery_coordinates_equal': planned.find('Коорд').attrib == actual.find('Коорд').attrib,
        'payload_tonnes_as_sample_only': first.find('.//СвТС/ТС/ПарТС').get('Грузопод'),
        'received_mass_exact': receive.get('МасБрутЗначПрием') == mass,
        'received_volume_exact': receive.get('Объем') == cargo.get('Объем'),
        'receiver_arrival_equals_departure': receive.get('ФДатВрПриб') == receive.get('ФДатВрУбыт'),
    }


def generated_diagnostics(generated):
    first = ET.fromstring(generated)
    cargoes = first.findall('.//СвГруз/ОпГруз')
    cargo = cargoes[0] if len(cargoes) == 1 else None
    mass_node = cargo.find('ПлМасГруз') if cargo is not None else None
    mass = mass_node.get('МасБрутЗнач') if mass_node is not None else None
    volume = cargo.get('Объем') if cargo is not None else None
    def convert(value, source, target):
        try:
            return exact_convert(value, source, target) if value is not None else None
        except ValueError:
            return None
    return {'volume_m3': volume, 'volume_litres': convert(volume, 'm3', 'l'),
            'mass_kg': mass, 'mass_tonnes': convert(mass, 'kg', 't')}


def make_report(comparisons, later, summary, integrity, validation, scenario):
    business = [r for r in comparisons if r['category'] == 'business' and r['kind'] in ('attribute', 'text') and not r['path'].endswith('/@КНД')]
    structure = [r for r in comparisons if r['category'] == 'business' and r not in business]
    different = [r for r in business if not r['match']]
    body = '<header><span class="eyebrow">АРТЭЛЬ · СВЕРКА ЭТАЛОНА</span><h1>ЭТрН №7: эталон и наш документ</h1><p>Приватный отчёт. Точный построчный разбор XML, без округления.</p><div class="links"><a href="test-document.html">Открыть наш документ</a><a href="test-document.pdf">Наш PDF</a><a href="reference.pdf">Исходный PDF</a><a href="generated-title-1.xml">Наш XML</a></div></header>'
    body += '<div class="metrics"><div class="metric"><strong>' + str(len(business)-len(different)) + ' / ' + str(len(business)) + '</strong>бизнес-значений титула 1 совпали</div><div class="metric"><strong>' + str(len(different)) + '</strong>расхождений бизнес-данных титула 1</div><div class="metric"><strong>' + str(integrity['files']) + ' / ' + str(integrity['files']) + '</strong>хешей исходного архива совпали</div></div>'
    body += '<div class="notice">Это воспроизведение сохранённого образца через редактируемый снимок данных и новый XML-сериализатор. Проверка доказывает сохранность данных при импорте и генерации первого титула. Она не доказывает заполнение из рабочего рейса, приём Saby, подписание или завершённый обмен. Титулы 2–4 ниже остаются данными эталона: наш генератор их пока не создаёт.</div>'
    body += '<h2>Содержательные итоги</h2><ul><li>' + ('Принадлежность эталона Олегу подтверждена независимым аудитом с тем же SHA-256 первого титула. Денис исключён.' if summary.get('reference_identity_verified') else 'Принадлежность водителю не подтверждена внешним аудитом этого запуска; проверяйте поля XML.') + '</li><li>Объём: ' + e(summary['volume_m3']) + ' м³ = ' + e(summary['volume_litres']) + ' л; масса: ' + e(summary['mass_kg']) + ' кг = ' + e(summary['mass_tonnes']) + ' т. Исходные строковые значения не округлялись.</li><li>В эталоне адрес доставки и адрес фактической выгрузки ' + ('различаются' if summary['delivery_address_differs'] else 'совпадают') + '; координаты ' + ('совпадают' if summary['delivery_coordinates_equal'] else 'различаются') + '.</li><li>«Грузопод» = ' + e(summary['payload_tonnes_as_sample_only']) + ' т — спорное значение эталона, без подтверждения для новой перевозки. Его значение в нашем документе проверяется ниже, в таблице.</li><li>Стоимость перевозки не подставляется из финансов CRM. Подписи, сертификатные штампы и QR исходника не копируются в новый документ.</li></ul>'
    body += '<table><tr><th>Различие внутри эталона</th><th>Титул 1</th><th>Титул 3</th><th>Результат</th></tr><tr><td>Адрес доставки / выгрузки</td><td>' + e(summary['planned_delivery_address']) + '</td><td>' + e(summary['actual_delivery_address']) + '</td><td>Сохранены раздельно, источник не исправлялся</td></tr></table>'
    body += '<h2>Схема и представление</h2><p>Проверка XML по публичной XSD Saby КНД 1110339 v5.01: эталон — ' + e(validation['reference']['status']) + '; наш документ — ' + e(validation['generated']['status']) + '. Для xmllint в схеме исправлены только два лишних экранирования двоеточия; происхождение описано в репозитории.</p><p>Оригинальный PDF — печатная форма Saby с итогами четырёх титулов, QR и штампами. Наш PDF формируется из нашего XML и показывает только первый титул, без QR и подписей. Верстка, число страниц и наличие разделов отличаются; это отдельное сравнение представления, а не побайтовое совпадение PDF. Подробности свежей проверки PDF: <a href="pdf-comparison.json">pdf-comparison.json</a>.</p>'
    body += '<h2>Титул 1 · бизнес-данные</h2>' + table(business)
    body += '<details><summary>Структура XML, наличие узлов, порядок и КНД (' + str(len(structure)) + ' проверок)</summary>' + table(structure) + '</details>'
    for category, title in [('signatory', 'Титул 1 · заявленные сведения подписанта'), ('service', 'Титул 1 · служебные поля и структура')]:
        body += '<h2>' + title + '</h2>' + table([r for r in comparisons if r['category'] == category])
    for knd, rows in later.items():
        body += '<h2>' + TITLE_NAMES[knd] + ' · только эталон</h2><p>Не сформирован. Значения эталона доступны для следующего этапа; старые подписи не становятся подписями нашего документа.</p>' + table(rows)
    body += '<h2>Повторяемость</h2><p>scenario.json сохраняет время генерации и локальный UUID; snapshot.json — редактируемое содержимое. Повторный запуск с теми же параметрами даёт те же байты XML. comparison.json содержит машинный результат; дополнительные и отсутствующие поля видны отдельно. Оригиналы не меняются.</p><p class="muted">Локальный сценарий ' + e(scenario['replay_id']) + ' · ' + e(scenario['generated_at']) + '</p>'
    return page('Сравнение ЭТрН №7', body)


def verify_archive(archive):
    manifest = json.loads((archive / 'manifest.json').read_text())
    base = archive / 'originals'
    seen = set()
    for item in manifest['files']:
        target = base / item['path']
        if target.is_symlink() or not target.resolve().is_relative_to(base.resolve()):
            raise ValueError('Unsafe manifest path')
        raw = target.read_bytes()
        if digest(raw) != item['sha256'] or len(raw) != item['bytes']:
            raise ValueError('Archive integrity mismatch; originals were not modified by this tool')
        seen.add(target.resolve())
    actual = {f.resolve() for f in base.rglob('*') if f.is_file() and f.name != '.DS_Store'}
    if seen != actual or len(seen) != manifest['file_count']:
        raise ValueError('Archive file inventory mismatch')
    return {'files': len(seen), 'sha256_verified': True, 'manifest_sha256': digest((archive / 'manifest.json').read_bytes())}


def validate_xml(xml_path, schema, output):
    result = subprocess.run(['xmllint', '--nonet', '--noout', '--schema', str(schema), str(xml_path)], capture_output=True)
    save(output, result.stderr)
    return {'status': 'PASS' if result.returncode == 0 else 'FAIL', 'exit_code': result.returncode}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--identity-audit', type=Path, help='Optional private independent audit bound to reference SHA-256')
    parser.add_argument('--snapshot', type=Path, help='An edited PRIVATE snapshot; default: freshly import reference')
    parser.add_argument('--generated-at', help='Aware ISO date/time; retained in scenario.json for repeat runs')
    parser.add_argument('--replay-id', help='Local UUID; retained for repeat runs')
    args = parser.parse_args()
    os.umask(0o077)
    archive, output = args.archive.resolve(), args.output.resolve()
    if output.is_relative_to(REPO) or output.is_relative_to(archive) or archive.is_relative_to(output):
        raise ValueError('Output must be outside checkout and separate from the reference archive')
    if any(p.is_symlink() for p in [args.output, *args.output.parents]):
        raise ValueError('Symlink output directory refused')
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    output.chmod(0o700)
    integrity = verify_archive(archive)
    titles, source_paths = {}, {}
    for path in (archive / 'originals').rglob('*.xml'):
        raw = path.read_bytes()
        # Safe parser rejects DTD/entity declarations before parsing; classify supported titles only.
        if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
            raise ValueError('DTD/entity declarations are not supported')
        root = ET.fromstring(raw)
        doc = root.find('Документ')
        knd = doc.get('КНД') if doc is not None else None
        if knd in TITLE_NAMES:
            if knd in titles:
                raise ValueError('Duplicate title in reference')
            titles[knd], source_paths[knd] = raw, path
    if set(titles) != set(TITLE_NAMES):
        raise ValueError('Expected four ConsignmentNote titles; a transport order is not a substitute')
    scenario_path = output / 'scenario.json'
    scenario = json.loads(scenario_path.read_text()) if scenario_path.exists() else {}
    scenario.update({
        'mode': 'offline-sample-first-title', 'generated_at': args.generated_at or scenario.get('generated_at') or datetime.now().astimezone().isoformat(timespec='seconds'),
        'replay_id': args.replay_id or scenario.get('replay_id') or str(uuid.uuid4()),
        'reference_sha256': digest(titles['1110339']), 'working_store_accessed': False, 'saby_requests': 0,
    })
    snapshot = json.loads(args.snapshot.read_text()) if args.snapshot else import_snapshot(titles['1110339'])
    generated = generate_title(snapshot, scenario['generated_at'], scenario['replay_id'])
    invalidates_rendered(output)
    json_save(scenario_path, scenario)
    json_save(output / 'snapshot.json', snapshot)
    save(output / 'generated-title-1.xml', generated)
    comparisons = compare_titles(titles['1110339'], (output / 'generated-title-1.xml').read_bytes())
    later = {knd: [{**row, 'reference': row['value'], 'generated': None, 'match': False, 'reason': 'Титул не создавался; только исторический эталон'} for row in flatten_title(raw)] for knd, raw in titles.items() if knd != '1110339'}
    summary = diagnostics(titles)
    if args.identity_audit:
        audit = json.loads(args.identity_audit.read_text())
        identity = audit.get('identity', {})
        summary['reference_identity_verified'] = audit.get('reference_first_title_sha256') == digest(titles['1110339']) and all(identity.get(k) is True for k in ['givenNameIsOleg', 'phoneMatchesOlegFleetRow', 'phoneMatchesArchivedCrmCandidate', 'capacityLitresExactMatch', 'vehicleShort442MatchesXmlReg'])
    else:
        summary['reference_identity_verified'] = False
    schema = REPO / 'tests/fixtures/saby/consignment-note-1110339-5.01.xsd'
    validation = {
        'reference': validate_xml(source_paths['1110339'], schema, output / 'reference-xsd.log'),
        'generated': validate_xml(output / 'generated-title-1.xml', schema, output / 'generated-xsd.log'),
        'schema_sha256': digest(schema.read_bytes()),
    }
    pdfs = json.loads((archive / 'extracted/pdf-text.json').read_text())
    pdf_source = max(pdfs, key=lambda item: len(item['pages']))['source']
    pdf_path = archive / 'originals' / pdf_source
    if not pdf_path.resolve().is_relative_to((archive / 'originals').resolve()):
        raise ValueError('Unsafe PDF path')
    save(output / 'reference.pdf', pdf_path.read_bytes())
    json_save(output / 'comparison.json', {'scope': scenario['mode'], 'integrity': integrity, 'validation': validation, 'summary': summary, 'first_title': comparisons, 'reference_only_titles': later})
    save(output / 'test-document.html', make_document(generated, generated_diagnostics(generated)))
    save(output / 'comparison.html', make_report(comparisons, later, summary, integrity, validation, scenario))
    after = verify_archive(archive)
    if integrity != after:
        raise ValueError('Archive changed during replay')
    json_save(output / 'integrity.json', {'before': integrity, 'after': after, 'unchanged': True})
    counts = Counter(r['category'] for r in comparisons)
    business_differences = sum(not r['match'] and r['category'] == 'business' for r in comparisons)
    signatory_differences = sum(not r['match'] and r['category'] == 'signatory' for r in comparisons)
    print(json.dumps({'signatory_differences': signatory_differences, 'archive_files_verified': integrity['files'], 'first_title_rows': dict(counts), 'business_differences': business_differences, 'xsd': {k:v['status'] for k,v in validation.items() if isinstance(v, dict)}, 'working_store_accessed': False, 'saby_requests': 0}))
    return 1 if business_differences or signatory_differences or any(v.get('status') == 'FAIL' for v in validation.values() if isinstance(v, dict)) else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError, ET.ParseError) as error:
        # Never expose XML values, filenames or schema diagnostics on shared console.
        print('Offline replay failed (' + type(error).__name__ + '). Check private inputs and XSD diagnostics.', file=sys.stderr)
        sys.exit(2)
