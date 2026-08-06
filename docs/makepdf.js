const { chromium } = require('playwright');
const { PDFDocument } = require('pdf-lib');
const path = require('path');
const fs = require('fs');

const fileUrl = f => 'file:///' + path.join(__dirname, f).replace(/\\/g, '/');

const headerTemplate = `
<div style="width:100%; margin:0 22mm; -webkit-print-color-adjust:exact;">
  <div style="display:flex; justify-content:space-between; font-family:'Segoe UI',Arial,sans-serif; font-size:8px; color:#0f1b3d; padding-bottom:4px;">
    <span style="letter-spacing:2px; font-weight:600;">PLAYDOIT MONITOR</span>
    <span style="color:#667;">Documentación Técnica Corporativa</span>
  </div>
  <div style="height:2.5px; background:linear-gradient(90deg, #0f1b3d 0%, #1a2f5e 55%, #b3122f 100%);"></div>
</div>`;

const footerTemplate = `
<div style="width:100%; text-align:center; font-family:'Segoe UI',Arial,sans-serif; font-size:8px; color:#888;">
  Página <span class="pageNumber"></span> de <span class="totalPages"></span>
</div>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto(fileUrl('cover.html'));
  const coverPdf = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '0', bottom: '0', left: '0', right: '0' },
  });

  await page.goto(fileUrl('documentacion.html'));
  const contentPdf = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '22mm', bottom: '14mm', left: '0', right: '0' },
    displayHeaderFooter: true,
    headerTemplate,
    footerTemplate,
  });
  await browser.close();

  const out = await PDFDocument.create();
  for (const buf of [coverPdf, contentPdf]) {
    const doc = await PDFDocument.load(buf);
    const pages = await out.copyPages(doc, doc.getPageIndices());
    pages.forEach(p => out.addPage(p));
  }
  fs.writeFileSync(path.join(__dirname, 'Playdoit_Monitor_Documentacion.pdf'), await out.save());
  console.log('PDF generado');
})();
