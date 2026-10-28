import PDFDocument from 'pdfkit';

/** Genera un PDF simple y legible (certificados, desprendibles, liquidaciones). */
export async function crearPdf(dibujar: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, info: { Producer: 'Jornal 360', Creator: 'Jornal 360' } });
  const partes: Buffer[] = [];
  doc.on('data', (b: Buffer) => partes.push(b));
  const fin = new Promise<Buffer>((ok) => doc.on('end', () => ok(Buffer.concat(partes))));
  dibujar(doc);
  doc.end();
  return fin;
}

export function encabezado(doc: PDFKit.PDFDocument, empresa: { razon_social: string; nit: string; dv?: string | null }, titulo: string) {
  doc.fontSize(16).font('Helvetica-Bold').text(empresa.razon_social, { align: 'center' });
  doc.fontSize(10).font('Helvetica').text(`NIT ${empresa.nit}${empresa.dv ? '-' + empresa.dv : ''}`, { align: 'center' });
  doc.moveDown(0.8);
  doc.fontSize(13).font('Helvetica-Bold').text(titulo, { align: 'center' });
  doc.moveDown(1);
  doc.font('Helvetica').fontSize(10);
}

/** Tabla de dos o más columnas con la última alineada a la derecha. */
export function tabla(doc: PDFKit.PDFDocument, columnas: { titulo: string; ancho: number; derecha?: boolean }[], filas: string[][]) {
  const x0 = doc.page.margins.left;
  let y = doc.y;
  const fila = (valores: string[], negrita = false) => {
    if (y > doc.page.height - 80) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    let x = x0;
    doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    let alto = 14;
    valores.forEach((v, i) => {
      const c = columnas[i];
      const h = doc.heightOfString(v ?? '', { width: c.ancho - 6 });
      alto = Math.max(alto, h + 4);
      doc.text(v ?? '', x + 3, y + 2, { width: c.ancho - 6, align: c.derecha ? 'right' : 'left' });
      x += c.ancho;
    });
    y += alto;
    doc.moveTo(x0, y).lineTo(x0 + columnas.reduce((a, c) => a + c.ancho, 0), y).strokeColor('#dddddd').lineWidth(0.5).stroke();
  };
  fila(columnas.map((c) => c.titulo), true);
  for (const f of filas) fila(f);
  doc.y = y + 8;
  doc.x = x0;
}
