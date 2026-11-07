import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyNkRecipientAcceptance } from '../server/nk-direct-recipient-evidence';
import { consignmentClientAcceptanceCandidate } from '../server/etrn-dispatch';
import type { SabyObject } from '../server/saby-client';
const carrier=Buffer.from('<?xml version="1.0" encoding="utf-8"?><Файл ИдФайл="T2-SYNTHETIC" ВерсФорм="5.01"><Документ КНД="1110340" ДатИнфПрвПрием="20.10.2026" ВрИнфПрвПрием="10:00:00"><СодИнфПрвПрием УИД_ТрН="uid-synthetic"/></Документ></Файл>');
const receipt='<?xml version="1.0" encoding="utf-8"?><Файл ИдФайл="T3-SYNTHETIC" ВерсФорм="5.01"><Документ КНД="1110341"><ИдИнфПрвПрием ИдФайлИнфПрвПрием="T2-SYNTHETIC" ДатФайлПрвПрием="20.10.2026" ВрФайлПрвПрием="10:00:00" ЭП="c3ludGhldGlj"/><СодИнфГП УИД_ТрН="uid-synthetic" СодОпПр="Груз принят"><ПриемГрузГП/></СодИнфГП><Подписант/></Документ></Файл>';

test('positive T3 must reference the exact signed T2 and consignment UID',()=>{
  assert.doesNotThrow(()=>verifyNkRecipientAcceptance(Buffer.from(receipt),carrier,Buffer.from('synthetic')));
  for(const changed of [receipt.replace('СодОпПр="Груз принят"','СодОпОтк="Груз отклонён" ПричОтк="Причина"'),receipt.replace('СодОпПр="Груз принят"','СодОпПр="Груз принят" СодОпОтк="Отказ"'),receipt.replace('СодОпПр="Груз принят"','СодОпПр="Груз принят" ПричОтк="Причина"'),receipt.replace('<ПриемГрузГП/>',''),receipt.replace('uid-synthetic','uid-other'),receipt.replace('T2-SYNTHETIC','T2-other'),receipt.replace('20.10.2026','21.10.2026'),receipt.replace('10:00:00','10:00:01'),receipt.replace('c3ludGhldGlj','b3RoZXI='),receipt.replace('<Подписант/>','<Подписант/><Подписант/>')])assert.throws(()=>verifyNkRecipientAcceptance(Buffer.from(changed),carrier,Buffer.from('synthetic')));
});

test('recipient metadata excludes wrong recipient, missing stage binding, stale titles and every error representation',()=>{
  const recipient={inn:'7707083893',kpp:'770701001'},file={Идентификатор:'T3',Подтип:'1110341',ВерсияФормата:'5.01',Подпись:[{Сертификат:{ИНН:recipient.inn,Отпечаток:'ab'.repeat(20)},Файл:{Ссылка:'https://disk.saby.ru/synthetic.sgn'}}]};
  const remote:SabyObject={Тип:'ConsignmentNote',Редакция:[{Идентификатор:'revision',Актуален:'Да'}],Вложение:[file],Этап:[{Идентификатор:'recipient',Название:'Приемка груза',Завершен:'Да',Исполнитель:[{Контрагент:{СвЮЛ:{ИНН:recipient.inn,КПП:recipient.kpp}}}],Вложение:[{Идентификатор:'T3'}]}]};
  assert.equal(consignmentClientAcceptanceCandidate(remote,recipient),true);
  const changes:((copy:SabyObject)=>void)[]=[copy=>{copy.Ошибки=['synthetic'];},copy=>{copy.Состояние={Код:'22'};},copy=>{copy.Вложение[0].Ошибки=['synthetic'];},copy=>{copy.Вложение[0].Подпись[0].Ошибки=['synthetic'];},copy=>{copy.Вложение[0].Подпись[0].Сертификат.Отпечаток='invalid';},copy=>{copy.Вложение[0].Подпись[0].Сертификат.ИНН='9999999999';},copy=>{copy.Вложение[0].Редакция={Идентификатор:'old'};},copy=>{copy.Вложение[0].Редакция='old';},copy=>{copy.Этап[0].Вложение=[];},copy=>{copy.Этап[0].Завершен='Нет';},copy=>{copy.Этап[0].Исполнитель[0].Контрагент.СвЮЛ.КПП='999999999';}];
  for(const change of changes){const copy=structuredClone(remote);change(copy);assert.equal(consignmentClientAcceptanceCandidate(copy,recipient),false);}
});
