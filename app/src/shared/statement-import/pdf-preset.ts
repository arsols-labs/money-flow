/** Known text-layer layouts. Kept out of the PDF.js module so the Data screen can list presets. */
export type PdfLayoutId = 'bps-izvod' | 'bps-fx' | 'bofa';

export function pdfLayoutsForTemplate(id: string | null | undefined): readonly PdfLayoutId[] | null {
  if (id === 'us-bofa' || id === 'us-bofa-pdf') return ['bofa'];
  if (id === 'rs-bps' || id === 'rs-bps-pdf') return ['bps-izvod', 'bps-fx'];
  return null;
}
