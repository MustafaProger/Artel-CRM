# Saby transport order schema

`transport-order-1110361-5.01.xsd` is the public Saby-generated XSD for the customer title of a transport order, KND `1110361`, format `5.01`. Retrieved on 2026-09-28 from the official [format page](https://formats.saby.ru/edo/trucking/130957?version=130957).

The page's public download action calls `ФорматДокумента.СохранитьВФайл` at `https://formats.saby.ru/service/` with parameters `{"ИдО":130957,"Формат":0,"Специализация":""}`. The decoded `result.Данные` source uses Windows-1251; original SHA-256: `408d85ddccc1c8538c9285b072846adfafc7d0deae07d3150094705328461166`. The checked-in public schema is transcoded to UTF-8, with its XML declaration updated and trailing whitespace removed. Schema definitions are unchanged. This normalization concerns the public schema only; signed transport documents must preserve their original bytes.

Use this functional schema for synthetic serializer tests. It does not contain real CRM documents or driver details. Passing XSD validation does not prove authorization, acceptance by Saby/GIS EPD, or signature validity. Saby's generated XSD is not independently presented here as the original FNS reference schema.

The official [transport-order API workflow](https://link.sbis.ru/page/kbase_entity/2ecadb1a-5bd4-4858-83f4-74d83eb5735a?folderId=8f551622-a492-491f-8e75-605e0c41998d) distinguishes writing/generating the customer title from preparation, signing and sending. The carrier response uses KND `1110362` and is a separate title.
