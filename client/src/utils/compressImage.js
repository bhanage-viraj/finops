// Shrink a photo before upload. If the browser cannot redraw it, the original
// file is kept so a JPEG, PNG, WebP, or iPhone HEIC photo is still saved.
const MAX_EDGE = 1600;

export function displayFileName(name) {
  const base = String(name || 'document').split(/[/\\]/).pop();
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

function isPdf(file) {
  const name = (file?.name || '').toLowerCase();
  return file?.type === 'application/pdf' || name.endsWith('.pdf');
}

function jpegName(name) {
  const base = displayFileName(name).replace(/\.[^.]+$/, '').trim() || 'receipt';
  return `${base.slice(0, 80)}.jpg`;
}

function sourceSize(source) {
  return {
    width: source.naturalWidth || source.width || 0,
    height: source.naturalHeight || source.height || 0,
  };
}

async function canvasJpeg(source, name) {
  const { width: sourceWidth, height: sourceHeight } = sourceSize(source);
  if (!sourceWidth || !sourceHeight) throw new Error('empty');
  const scale = Math.min(1, MAX_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new Error('empty');
  return new File([blob], jpegName(name), { type: 'image/jpeg', lastModified: Date.now() });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ image, url });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('unreadable'));
    };
    image.src = url;
  });
}

async function encodeJpeg(file) {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      return await canvasJpeg(bitmap, file.name);
    } finally {
      bitmap.close?.();
    }
  }
  const loaded = await loadImage(file);
  try {
    return await canvasJpeg(loaded.image, file.name);
  } finally {
    URL.revokeObjectURL(loaded.url);
  }
}

function ascii(bytes, start, end) {
  return String.fromCharCode(...bytes.slice(start, end));
}

export function browserCanUpload(bytes, name = '', type = '') {
  const lowerName = name.toLowerCase();
  const lowerType = type.toLowerCase();
  if (lowerType === 'application/pdf' || lowerName.endsWith('.pdf')) return true;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  if (bytes.length > 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return true;
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    return ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'avif'].includes(brand);
  }
  if (bytes.length >= 5 && ascii(bytes, 0, 4) === '%PDF') return true;
  return false;
}

export async function compressImage(file) {
  if (isPdf(file)) return file;
  try {
    return await encodeJpeg(file);
  } catch {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (browserCanUpload(head, file.name, file.type)) return file;
    throw new Error('This photo could not be read. Choose a JPEG, PNG, or PDF.');
  }
}
