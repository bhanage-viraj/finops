const TYPES = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/webp': null,
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
};

function matches(bytes, signature) {
  if (!signature) return false;
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function isWebp(bytes) {
  return bytes.length > 12
    && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP';
}

export function inspectUpload({ filename = 'document', bytes, maxBytes }) {
  if (!bytes || bytes.length === 0) {
    return { ok: false, error: `${filename} is empty.` };
  }
  if (bytes.length > maxBytes) {
    return { ok: false, error: `${filename} is too large.` };
  }
  let mime = null;
  if (matches(bytes, TYPES['image/jpeg'])) mime = 'image/jpeg';
  else if (matches(bytes, TYPES['image/png'])) mime = 'image/png';
  else if (isWebp(bytes)) mime = 'image/webp';
  else if (matches(bytes, TYPES['application/pdf'])) mime = 'application/pdf';
  if (!mime) {
    return { ok: false, error: `${filename} must be a JPEG, PNG, WebP or PDF. The file contents do not match an allowed type.` };
  }
  return { ok: true, mime };
}

export function pdfPageCount(bytes) {
  if (!bytes || bytes.length < 5 || bytes.toString('ascii', 0, 4) !== '%PDF') return null;
  const text = bytes.toString('latin1');
  const pages = text.match(/\/Type\s*\/Page(?!s)/g);
  return pages?.length || null;
}
