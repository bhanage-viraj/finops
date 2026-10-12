import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'samples', 'receipts');

function svg(lines) {
  const text = lines.map((line, index) => `<text x="32" y="${56 + index * 36}" font-size="22" font-family="Arial">${line}</text>`).join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="${80 + lines.length * 36}"><rect width="100%" height="100%" fill="white"/>${text}</svg>`);
}

const samples = [
  ['sample-fuel-maju.png', ['SPBU Maju Lancar', 'Jl. Melati 12, Bandung', '09/10/2026  14:32', 'No. F-1001', 'Pertalite', '10.031 L', 'Rp 10.000 / L', 'Total Rp 100.310', 'Tunai', 'B 1001 K']],
  ['sample-work-order-sari.png', ['Order kerja', '09/10/2026', 'Nama: Sari Staff', 'Helper', 'HP 081200000099', 'Jam 08:00-12:00', 'Tujuan: Gudang Utara', 'Angkut galon kosong', 'Upah Rp 150.000']],
  ['sample-supplier-surya.png', ['Toko Kemasan Surya', '28/09/2026', 'Galon kosong  20 pcs  Rp 15.000  Rp 300.000', 'Tutup galon  20 pcs  Rp 2.000  Rp 40.000', 'Subtotal Rp 340.000', 'Total Rp 340.000']],
];

await fs.mkdir(outDir, { recursive: true });
for (const [name, lines] of samples) {
  await sharp(svg(lines)).png().toFile(path.join(outDir, name));
  console.log(name);
}
