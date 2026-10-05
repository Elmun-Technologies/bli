import { inspectImportSource } from '@/lib/imports/parse';
import { validateImportRows } from '@/lib/imports/validation';
import type { ColumnMapping } from '@/lib/imports/column-mapping';

const FORMULA_NAME = "=HYPERLINK('http://evil.example','x')";
const RUN_ID = 'X';
const CSV = [
  'Mijoz,Telefon,Manzil,Shirote,Uzunlik,Savdo,Buyurtma,Segments,Tashqi ID',
  `Ali Valiyev,+998901112233,"Toshkent, Amir Temur 1",,,1250000.50,12,retail,smoke-${RUN_ID}-1`,
  `Zuhra Karimova,+998902223344,"Samarqand, Registon 5",,,980000,7,wholesale,smoke-${RUN_ID}-2`,
  `"${FORMULA_NAME}",+998903334455,,,,n/a,3,retail,smoke-${RUN_ID}-3`,
  `Dilnoza Yusupova,+998904445566,"Toshkent, Chilonzor 9",41.2856,69.2034,450000,0,retail,smoke-${RUN_ID}-4`,
  `Jasur Toshmatov,+998905556677,"Toshkent, Yunusabad 4",,,100,1,retail,smoke-${RUN_ID}-5`,
].join('\n');

const mapping: ColumnMapping = {
  Mijoz: 'name', Telefon: 'phone', Manzil: 'address', Shirote: 'latitude', Uzunlik: 'longitude',
  Savdo: 'revenue', Buyurtma: 'order_count', Segments: 'segment', 'Tashqi ID': 'external_id',
};

async function main(){
const parsed = await inspectImportSource(new TextEncoder().encode(CSV), 'smoke.csv');
console.log('headers:', JSON.stringify(parsed.headers));
console.log('rowNumbers:', JSON.stringify(parsed.rowNumbers));
const stagedInputs = parsed.rows.map((row, index) => ({
  rowNumber: parsed.rowNumbers[index],
  rawData: Object.fromEntries(parsed.headers.map((header, column) => [header, row[column] ?? ''])),
}));
const { results } = validateImportRows(stagedInputs, mapping, 'customers');
const invalid = results.find((r) => r.status === 'invalid');
console.log('invalid rowNumber:', invalid?.rowNumber);
console.log('invalid errors:', JSON.stringify(invalid?.errors));
console.log('staged rawData for that row:', JSON.stringify(stagedInputs.find((r) => r.rowNumber === invalid?.rowNumber)?.rawData, null, 1));
console.log('name verbatim?', stagedInputs[2].rawData['Mijoz'] === FORMULA_NAME, JSON.stringify(stagedInputs[2].rawData['Mijoz']));

}
void main();
