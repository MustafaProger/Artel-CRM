# Saby transport order schema

`transport-order-1110361-5.01.xsd` is the public Saby-generated XSD for the customer title of a transport order, KND `1110361`, format `5.01`. Retrieved on 2026-09-28 from the official [format page](https://formats.saby.ru/edo/trucking/130957?version=130957).

The page's public download action calls `ФорматДокумента.СохранитьВФайл` at `https://formats.saby.ru/service/` with parameters `{"ИдО":130957,"Формат":0,"Специализация":""}`. The decoded `result.Данные` source uses Windows-1251; original SHA-256: `408d85ddccc1c8538c9285b072846adfafc7d0deae07d3150094705328461166`. The checked-in public schema is transcoded to UTF-8, with its XML declaration updated and trailing whitespace removed. Schema definitions are unchanged. This normalization concerns the public schema only; signed transport documents must preserve their original bytes.

Use this functional schema for synthetic serializer tests. It does not contain real CRM documents or driver details. Passing XSD validation does not prove authorization, acceptance by Saby/GIS EPD, or signature validity. Saby's generated XSD is not independently presented here as the original FNS reference schema.

The official [transport-order API workflow](https://link.sbis.ru/page/kbase_entity/2ecadb1a-5bd4-4858-83f4-74d83eb5735a?folderId=8f551622-a492-491f-8e75-605e0c41998d) distinguishes writing/generating the customer title from preparation, signing and sending. The carrier response uses KND `1110362` and is a separate title.

## Consignment note sender title, 1110339 5.01

`consignment-note-1110339-5.01.xsd` is derived from Saby's public generated schema for the sender title of a consignment note (`ConsignmentNote` / ЭТрН), KND `1110339`, format `5.01`. Retrieved on 2026-09-29 from the official [format page](https://formats.saby.ru/edo/trucking/126985?version=126985). This is the version of the historical test sample; it is not a claim about the version required for a new shipment.

The public download action uses `ФорматДокумента.СохранитьВФайл` at `https://formats.saby.ru/service/` with parameters `{"ИдО":126985,"Формат":0,"Специализация":""}`. The exact decoded download is preserved as `consignment-note-1110339-5.01.upstream.xsd` (Windows-1251): **602419** bytes; original SHA-256: `e172ea60b98aae59829ee365b9c574b73fa08940e18782d5c10dbae65e95446f`.

The checked-in schema is transcoded to UTF-8, its declaration updated, and trailing whitespace removed. One narrowly scoped compatibility correction is also applied: two occurrences of the time pattern `([0-1]\d|2[0-3])(\:[0-5]\d){2}` become `([0-1]\d|2[0-3])(:[0-5]\d){2}`. The original unnecessary colon escape is rejected by libxml2's XSD regular-expression parser; colon itself is an ordinary literal in XSD regex. No element, attribute, cardinality or other constraint is changed. Checked-in SHA-256: `f3b7a7c7118663b412eeeb049653a8e1148e255b581a278aee47a40b0feb5dcb`.

The unmodified public download fails schema compilation in `xmllint`; do not describe it as having passed validation. The immutable private first-title sample passes the compatibility-corrected schema. That check establishes XML structure only, not current business truth, signature validity, permissions, legal sufficiency or Saby/GIS acceptance. No real document fields are included in these fixtures. The remaining titles `1110340`, `1110341` and `1110342` are outside this schema.
