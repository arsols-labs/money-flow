// Synthetic statement PDFs. Placeholders only: no real names, accounts, or bank files.
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';

function text(page: PDFPage, font: PDFFont, value: string, x: number, y: number, size = 9): void {
  page.drawText(value, { x, y, size, font });
}

async function document(): Promise<{ doc: PDFDocument; font: PDFFont }> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  return { doc, font };
}

async function save(doc: PDFDocument): Promise<Uint8Array> {
  return new Uint8Array(await doc.save());
}

export async function syntheticBpsRsdPdf(options: { mismatch?: boolean } = {}): Promise<Uint8Array> {
  const { doc, font } = await document();
  const first = doc.addPage([575, 842]);
  text(first, font, 'Strana: 1 od: 2   Štampano: 04.11.26 13:05:00', 36, 820);
  text(first, font, 'IZVOD BROJ 7', 36, 800, 12);
  text(first, font, 'Od: 01.06.2026 - 30.06.2026', 36, 784);
  text(first, font, 'Komitent: PLACEHOLDER', 36, 768);
  text(first, font, 'Racun: 265000000000000001', 36, 752);
  text(first, font, 'Sif.pl', 220, 730);
  text(first, font, 'Potražuje', 300, 730);
  text(first, font, 'Duguje', 400, 730);
  text(first, font, 'Stanje', 490, 730);

  text(first, font, '1.', 36, 710);
  text(first, font, '01.06.2026', 60, 710);
  text(first, font, '1,234.56', 300, 710);
  text(first, font, '10,000.00', 490, 710);
  text(first, font, 'PLACEHOLDER GROCER', 70, 694);
  text(first, font, 'Poziv za reklamaciju: REF-1001', 70, 680);
  text(first, font, 'Vreme prijema: 01.06.2026', 70, 666);

  text(first, font, '2.', 36, 640);
  text(first, font, '02.06.2026', 60, 640);
  text(first, font, '102.', 220, 640);
  text(first, font, '50.00', 400, 640);
  text(first, font, '9,950.00', 490, 640);
  text(first, font, 'Kartica : 400000******0000', 70, 624);
  text(first, font, 'PLACEHOLDER MERCHANT', 70, 610);
  text(first, font, 'CITY BRANCH', 70, 596);
  text(first, font, 'Poziv za reklamaciju: REF-1002', 70, 582);
  text(first, font, 'Iznos transakcije: 50.00 u valuti RSD Iznos u obracunskoj valuti: 50.00', 70, 568);

  text(first, font, '3.', 36, 550);
  text(first, font, '03.06.2026', 60, 550);
  text(first, font, '400.', 250, 550);
  text(first, font, '10.00', 400, 550);
  text(first, font, '9,940.00', 490, 550);
  text(first, font, 'PLACEHOLDER FEE', 70, 534);
  text(first, font, 'Asseco SEE;ks2stampaizv2t,; Rel 1.2 PLACEHOLDER, Racun: 265000000000000001 , IZVOD BROJ 7 od: 1 br.Oper: 9999', 36, 40, 7);

  const second = doc.addPage([575, 842]);
  text(second, font, 'Strana: 2 od: 2   Štampano: 04.11.26 13:05:01', 36, 820);
  text(second, font, '4.', 36, 780);
  text(second, font, '04.06.2026', 60, 780);
  text(second, font, '25.00', 300, 780);
  text(second, font, '9,965.00', 490, 780);
  text(second, font, 'PLACEHOLDER PAGE TWO', 70, 764);
  text(second, font, 'WRAPPED LINE', 70, 750);
  text(second, font, 'Poziv za reklamaciju: REF-1004', 70, 736);
  text(second, font, 'UKUPNO ZA IZVOD', 36, 700, 11);
  text(second, font, 'Prethodno stanje: 8,765.44', 36, 680);
  text(second, font, 'Ukupno uplata: 2 1,259.56', 36, 664);
  text(second, font, 'Ukupno isplata: 2 60.00', 36, 648);
  text(second, font, options.mismatch ? 'Novo stanje: 1.00' : 'Novo stanje: 9,965.00', 36, 632);
  text(second, font, 'NEREALIZOVANI CEKOVI', 36, 600);
  text(second, font, 'KAMATNE STOPE PLACEHOLDER', 36, 584);
  return save(doc);
}

export async function syntheticBpsFxPdf(options: { currency?: 'USD' | 'EUR'; mismatch?: boolean } = {}): Promise<Uint8Array> {
  const currency = options.currency ?? 'USD';
  const { doc, font } = await document();
  const first = doc.addPage([595.28, 841.89]);
  text(first, font, 'Izvod br: 4 formiran: 05.05.26', 40, 800);
  text(first, font, `ZA TEKUCI RACUN BROJ: 265-0000000000001-23 - PROMENE U PERIODU: 28.12.25 - 05.01.26`, 40, 780, 8);
  text(first, font, `u ${currency}`, 40, 762);
  text(first, font, 'DATUM', 40, 740);
  text(first, font, 'OPIS', 140, 740);
  text(first, font, 'PROMENA', 360, 740);
  text(first, font, 'SALDO', 470, 740);
  text(first, font, 'Valuta', 40, 720);
  text(first, font, 'PRETHODNO STANJE', 140, 720);
  text(first, font, '999,99', 470, 720);
  text(first, font, '29.12', 40, 700);
  text(first, font, 'EB 00000000000 - otkup strane', 140, 700);
  text(first, font, '100,00-', 360, 700);
  text(first, font, '899,99', 470, 700);
  text(first, font, 'valute preko m', 140, 686);
  text(first, font, '02.01', 40, 660);
  text(first, font, '1234 VI/PLACEHOLDER MERCHANT,', 140, 660);
  text(first, font, ',50-', 360, 660);
  text(first, font, '899,49', 470, 660);
  text(first, font, 'CITY', 140, 646);

  const second = doc.addPage([595.28, 841.89]);
  text(second, font, '03.01', 24, 780);
  text(second, font, 'PLACEHOLDER FX PAGE TWO', 90, 780);
  text(second, font, '20,00', 300, 780);
  text(second, font, options.mismatch ? '1,00' : '919,49', 400, 780);
  return save(doc);
}

export async function syntheticBofaPdf(options: { mismatch?: boolean } = {}): Promise<Uint8Array> {
  const { doc, font } = await document();
  const first = doc.addPage([612, 792]);
  text(first, font, 'Adv SafeBalance Banking', 40, 760, 14);
  text(first, font, 'for May 1, 2026 to May 31, 2026  Account number: 9999 9999 9999', 40, 740, 8);
  text(first, font, 'Beginning balance $1,000.00', 40, 720);
  text(first, font, 'Deposits and other additions $100.00', 40, 706);
  text(first, font, 'ATM and debit card subtractions $20.00', 40, 692);
  text(first, font, 'Other subtractions $5.00', 40, 678);
  text(first, font, 'Service fees $2.50', 40, 664);
  text(first, font, options.mismatch ? 'Ending balance $1.00' : 'Ending balance $1,072.50', 40, 650);
  text(first, font, 'Deposits and other additions', 40, 620, 11);
  text(first, font, 'Date', 40, 604);
  text(first, font, 'Description', 120, 604);
  text(first, font, 'Amount', 420, 604);
  text(first, font, '05/01/26', 40, 586);
  text(first, font, 'PAYROLL PLACEHOLDER', 120, 586);
  text(first, font, '100.00', 420, 586);
  text(first, font, 'Withdrawals and other subtractions', 40, 560, 11);
  text(first, font, 'ATM and debit card subtractions', 40, 544);
  text(first, font, '05/02/26', 40, 526);
  text(first, font, 'ATM WITHDRAWAL', 120, 526);
  text(first, font, '-20.00', 420, 526);
  text(first, font, 'continued on the next page', 40, 500);

  const second = doc.addPage([612, 792]);
  text(second, font, 'Other subtractions - continued', 40, 760, 11);
  text(second, font, 'Date', 40, 744);
  text(second, font, 'Description', 120, 744);
  text(second, font, 'Amount', 420, 744);
  text(second, font, '05/03/26', 40, 726);
  text(second, font, 'PLACEHOLDER STORE', 120, 726);
  text(second, font, '-5.00', 420, 726);
  text(second, font, 'SECOND LINE', 120, 712);
  text(second, font, 'Service fees', 40, 680, 11);
  text(second, font, 'Date', 40, 664);
  text(second, font, 'Transaction description', 120, 664);
  text(second, font, 'Amount', 420, 664);
  text(second, font, '05/04/26', 40, 646);
  text(second, font, 'MONTHLY FEE', 120, 646);
  text(second, font, '-2.50', 420, 646);
  text(second, font, 'PULL: B CYCLE: 1 Page 2 of 3', 40, 40, 7);
  text(second, font, 'PLACEHOLDER ! Account # 9999 ! May 1, 2026 to May 31, 2026', 40, 28, 7);

  const third = doc.addPage([612, 792]);
  text(third, font, 'IMPORTANT INFORMATION', 40, 740, 12);
  text(third, font, 'Watch for scam tips about this account', 40, 720);
  text(third, font, 'This page intentionally left blank', 40, 700);
  text(third, font, '© 2026 PLACEHOLDER', 40, 40);
  return save(doc);
}

export async function emptyTextPdf(): Promise<Uint8Array> {
  const { doc } = await document();
  doc.addPage([612, 792]);
  return save(doc);
}

export async function unknownLayoutPdf(): Promise<Uint8Array> {
  const { doc, font } = await document();
  const page = doc.addPage([612, 792]);
  text(page, font, 'Hello from PLACEHOLDER BANK', 40, 700, 12);
  return save(doc);
}

export async function encryptedPdf(): Promise<Uint8Array> {
  const { doc } = await document();
  doc.addPage([300, 300]);
  const raw = new TextDecoder().decode(await doc.save({ useObjectStreams: false }));
  const injected = raw.replace(
    /trailer\s*<<([^>]*)>>/,
    (_match, inner: string) => `4 0 obj\n<< /Filter /Standard /V 1 /R 2 /O <00000000000000000000000000000000> /U <00000000000000000000000000000000> /P -4 >>\nendobj\ntrailer\n<<${inner} /Encrypt 4 0 R >>`,
  );
  return new TextEncoder().encode(injected);
}
