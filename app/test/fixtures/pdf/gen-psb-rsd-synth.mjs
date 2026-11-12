// Regenerates the invented BPS RSD lookalike next to this file.
// Needs pdf-lib, @pdf-lib/fontkit, and Liberation fonts. Not run by CI.
// The committed PDF and expected JSON are what the regression test loads.
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const OUT = path.dirname(fileURLToPath(import.meta.url)) + path.sep;
const F = '/usr/share/fonts/truetype/liberation/';
const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
doc.setTitle('SYNTH0000000000000000000000000000E.pdf'); doc.setAuthor('Oracle Reports');
doc.setCreator('Oracle12c AS Reports Services'); doc.setProducer('Oracle PDF driver');
const fz = {};
for (const [k, f] of Object.entries({ r: 'LiberationSerif-Regular', b: 'LiberationSerif-Bold', bi: 'LiberationSerif-BoldItalic', i: 'LiberationSerif-Italic', m: 'LiberationMono-Regular', mb: 'LiberationMono-Bold' }))
  fz[k] = await doc.embedFont(readFileSync(F + f + '.ttf'), { subset: true });

// ---- invented data ----
const ACC = '999-0000000000001-11', CLIENT = 'SYNTH CLIENT (TEST) PERSON', IZV = 10;
const PERIOD = '01.10.2026 - 31.10.2026', PRINTED = '02.11.26 10:00:00';
const CARD_A = '400000******0001', CARD_B = '400000******0002';
const OPEN = 500000; // minor
const tx = [
  ['01.10.2026', 'card', -45000, 'SYNTH SHOP 1, GRAD', CARD_A],
  ['01.10.2026', 'card', -125040, 'SYNTH MARKET 2, GRAD', CARD_A],
  ['01.10.2026', 'fx', 1000000, 100],
  ['01.10.2026', 'fee', -25000],
  ['03.10.2026', 'card', -234567, 'SYNTH PHARMACY 3, GRAD', CARD_A],
  ['05.10.2026', 'card', -99999, 'SYNTH TELECOM 4 doo, GRAD', CARD_B],
  ['06.10.2026', 'card', -321000, 'SYNTH GROCER 5, GRAD', CARD_A],
  ['08.10.2026', 'fx', 1500000, 150],
  ['10.10.2026', 'card', -111111, 'SYNTH SHOP 1, GRAD', CARD_A],
  ['12.10.2026', 'card', -67890, 'SYNTH CAFE 6, GRAD', CARD_A],
  ['15.10.2026', 'card', -450000, 'SYNTH MARKET 2, GRAD', CARD_A],
  ['18.10.2026', 'card', -80000, 'SYNTH TELECOM 4 doo, GRAD', CARD_B],
  ['20.10.2026', 'fx', 12000000, 1200],
  ['25.10.2026', 'card', -1234560, 'SYNTH ELECTRO 7, GRAD', CARD_A],
  ['31.10.2026', 'card', -200000, 'SYNTH GROCER 5, GRAD', CARD_A],
  ['31.10.2026', 'fee', -25000],
];
const fmt = (m) => { const a = Math.abs(m); const s = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); return s + '.' + String(a % 100).padStart(2, '0'); };
const prevDay = (d) => { const [dd, mm, yy] = d.split('.').map(Number); const t = new Date(Date.UTC(yy, mm - 1, dd - 1)); return [t.getUTCDate(), t.getUTCMonth() + 1].map((n) => String(n).padStart(2, '0')).join('.') + '.' + t.getUTCFullYear(); };

// ---- draw ops collected per page, emitted in Oracle-like column order ----
const ORDER = ['footer', 'stamp', 'strana', 'client', 'credit', 'debit', 'rowno', 'hdr', 'card', 'ref', 'poziv', 'stanjeHdr', 'bal', 'desc', 'formiran', 'vdate', 'vlabel', 'prodaja', 'iznos', 'date', 'code', 'sifHdr', 'sum'];
const pages = [];
let ops;
const put = (bucket, s, x, y, size = 8, font = 'r') => ops.push({ bucket, s, x, y, size, font });
const putR = (bucket, s, right, y, size = 8, font = 'm') => put(bucket, s, right - fz[font].widthOfTextAtSize(s, size), y, size, font);
const newPage = () => { ops = []; pages.push(ops); };

const rows = []; let bal = OPEN, sn = 0;
newPage();
const pageHead = () => {};
// page-1 header
put('client', CLIENT, 291.3, 713.8, 12, 'b');
put('hdr', 'Komitent:', 284.5, 727.4, 12, 'bi');
put('hdr', 'Potražuje', 343.7, 645.9, 8, 'bi'); put('hdr', 'Duguje', 438.8, 645.9, 8, 'bi');
put('hdr', 'SINTETIČKA 1', 292.9, 699.2, 11); put('hdr', '11000 BEOGRAD-TEST', 293.0, 684.9, 11);
put('hdr', 'Banka SINTETIČKA štedionica, akcionarsko društvo, Beograd', 20.6, 784.9, 12, 'b');
put('hdr', 'Sintetička ulica 9', 20.6, 769.3, 12); put('hdr', '11000 Beograd (Test)', 20.6, 753.8, 12);
put('hdr', `IZVOD BROJ ${IZV}`, 18.4, 724.7, 14, 'b'); put('hdr', `Od: ${PERIOD}`, 18.7, 703.6, 11);
put('hdr', `Račun: ${ACC}`, 23.1, 644.5, 10, 'b');
put('stanjeHdr', 'Stanje:', 528.4, 645.9, 8, 'bi');
put('formiran', 'Formiran dana: 02.11.2026', 18.7, 688.7, 11);
put('sifHdr', 'Šif.pl', 251.1, 645.9, 8, 'bi');

let y = 628.3;
const PITCH = { card: 68.8, fx: 70.8, fee: 58.7 };
tx.forEach((t, i) => {
  const [date, kind, amt, desc, card] = t;
  if (y - PITCH[kind] < 60) { newPage(); y = 794.5; }
  bal += amt; sn++;
  const code = kind === 'card' ? '102.' : kind === 'fx' ? '793.' : '400.';
  const ref = kind === 'card' ? `10000000${String(sn).padStart(5, '0')}-3` : `20000000000${String(sn).padStart(5, '0')}-${kind === 'fx' ? 2 : 3}`;
  put('rowno', `${sn}.`, 19.6, y); put('date', date, 52.7, y - 0.8); put('code', code, 252.3, y - 0.2);
  if (card) put('card', `Kartica : ${card}`, 114.7, y - 0.8);
  putR(amt > 0 ? 'credit' : 'debit', fmt(amt), amt > 0 ? 373.4 : 461.1, y + 0.6);
  putR('bal', fmt(bal), 549.8, y + 0.6);
  let description, extra = null;
  if (kind === 'card') { description = desc; extra = `Iznos transakcije: ${fmt(amt)} u valuti RSD Iznos u obračunskoj valuti: ${fmt(amt)} u valuti RSD`; }
  else if (kind === 'fx') { description = `EB 900000000${String(sn).padStart(2, '0')} - otkup strane valute preko m-banking kanala`; extra = `'Prodaja ${fmt(amt)} RSD po kursu 100.0000 za ${t[3]}.00 USD'`; }
  else description = 'Naplata mesecne naknade za vodenje racuna';
  put('desc', description, 52.8, y - 25.4);
  put('poziv', 'Poziv za reklamaciju:', 48.5, y - 34.8); put('ref', ref, 120.3, y - 35.6);
  put('vlabel', 'Vreme prijema:', 67.5, y - 46.0); put('vdate', kind === 'card' ? prevDay(date) : date, 153.2, y - 45.5);
  if (kind === 'card') put('iznos', extra, 22.0, y - 56.3);
  if (kind === 'fx') put('prodaja', extra, 21.4, y - 57.5);
  rows.push({ sourceIndex: sn, date: date.split('.').reverse().join('-'), code: code.slice(0, 3), card: card ?? null, description, extraLine: extra, reference: ref, amountMinor: amt, balanceMinor: bal });
  y -= PITCH[kind];
});
// summary block
if (y + PITCH[tx[tx.length - 1][1]] - 63.5 - 145 < 50) { newPage(); y = 794.5 - 63.5 + PITCH[tx[tx.length - 1][1]] ; }
const sy = y + PITCH[tx[tx.length - 1][1]] - 63.5;
const credits = rows.filter((r) => r.amountMinor > 0), debits = rows.filter((r) => r.amountMinor < 0);
const cin = credits.reduce((a, r) => a + r.amountMinor, 0), cout = -debits.reduce((a, r) => a + r.amountMinor, 0);
put('sum', 'UKUPNO ZA IZVOD', 21.2, sy, 10, 'b'); put('sum', 'Ukupno potr.', 400.0, sy + 1.5, 8, 'bi'); put('sum', 'Ukupno dugu.', 501.6, sy + 1.5, 8, 'bi');
put('sum', 'Prethodno stanje:', 141.1, sy - 14.3); putR('sum', fmt(OPEN), 318.7, sy - 13.5);
put('sum', 'Ukupno uplata:', 146.1, sy - 26.3); put('sum', String(credits.length), 207.7, sy - 25.1); putR('sum', fmt(cin), 437.6, sy - 25.7);
put('sum', 'Ukupno isplata:', 145.2, sy - 38.8); put('sum', String(debits.length), 207.3, sy - 38.5); putR('sum', fmt(cout), 547.0, sy - 37.9);
put('sum', 'Novo stanje:', 156.8, sy - 50.5); putR('sum', fmt(bal), 317.1, sy - 49.7);
put('sum', 'NEREALIZOVANI ČEKOVI', 19.8, sy - 67.9, 10, 'b'); put('sum', '0', 553.0, sy - 67.9);
put('sum', 'KAMATNE STOPE U PERIODU IZVODA', 30.0, sy - 90, 8, 'b');
put('sum', 'Tip kamatne stope', 30.0, sy - 104); put('sum', 'Datum Od', 155.0, sy - 104); put('sum', 'Datum Do', 220.0, sy - 104); put('sum', 'Metod obračuna', 380.0, sy - 104); put('sum', 'Stopa', 535.0, sy - 104);
for (const [k, [n, r]] of [['REDOVNA', '0.00%'], ['ZATEZNA', '11.75%']].entries()) {
  const yy = sy - 116 - k * 22;
  put('sum', n, 30.0, yy); put('sum', '01.10.2026', 155.0, yy); put('sum', '31.10.2026', 220.0, yy);
  put('sum', 'Proporcionalni metod - godišnja stopa', 380.0, yy); putR('sum', r, 556.0, yy, 8, 'r'); put('sum', '(365 dana)', 380.0, yy - 10);
}
// headers/footers on every page; emit ops in column order
pages.forEach((pg, p) => {
  ops = pg;
  put('footer', `${CLIENT}, Račun: ${ACC} , IZVOD BROJ ${IZV} od: ${PERIOD} br.Oper: 9999`, 213.9, 29.8, 6);
  put('footer', 'Asseco SEE;ks2stampaizv2t,; Rel 1.2', 17.5, 29.8, 6);
  put('stamp', PRINTED, 474.2, 819.4); put('stamp', 'Štampano:', 428.6, 819.4);
  put('strana', 'Strana:', 357.9, 819.3); put('strana', String(p + 1), 386.8, 819.3); put('strana', 'od:', 394.8, 819.3); put('strana', String(pages.length), 409.4, 819.3);
  const page = doc.addPage([575, 842]);
  const sorted = [...pg].sort((a, b) => ORDER.indexOf(a.bucket) - ORDER.indexOf(b.bucket));
  for (const o of sorted) page.drawText(o.s, { x: o.x, y: o.y, size: o.size, font: fz[o.font], color: rgb(0, 0, 0) });
});
writeFileSync(OUT + 'psb-rsd-synth.pdf', await doc.save({ useObjectStreams: false }));
const expected = {
  synthetic: true, note: 'Invented data only. Lookalike of a BPS IZVOD RSD statement layout (column-ordered content stream, no whitespace items between cells).',
  layout: 'bps-izvod', currency: 'RSD', accountRef: ACC, statementNo: IZV, period: { from: '2026-10-01', to: '2026-10-31' }, dateFormat: 'DD.MM.YYYY',
  pages: pages.length,
  totals: { openingMinor: OPEN, creditsCount: credits.length, inMinor: cin, debitsCount: debits.length, outMinor: cout, netMinor: cin - cout, closingMinor: bal, opening: fmt(OPEN), in: fmt(cin), out: fmt(cout), net: fmt(cin - cout), closing: fmt(bal) },
  reconciles: OPEN + cin - cout === bal,
  rows,
};
writeFileSync(OUT + 'psb-rsd-synth.expected.json', JSON.stringify(expected, null, 2));
console.log('pages', pages.length, 'rows', rows.length, expected.totals, 'reconciles', expected.reconciles);
