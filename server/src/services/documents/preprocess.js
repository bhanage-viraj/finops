// Builds a reading copy. The original file is never overwritten.

export async function preprocessImage(bytes) {
  const sharp = (await import('sharp')).default;
  const pipeline = sharp(bytes, { failOn: 'error', limitInputPixels: 40_000_000 }).rotate();
  const meta = await pipeline.metadata();
  let image = pipeline;
  if ((meta.width || 0) > 2000) image = image.resize({ width: 2000, withoutEnlargement: true });
  const output = await image.normalize().jpeg({ quality: 85 }).toBuffer();
  return {
    bytes: output,
    mimeType: 'image/jpeg',
    note: 'EXIF rotation applied and contrast normalized. The original file is unchanged.',
  };
}
