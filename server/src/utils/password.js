import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const KEY_LEN = 64;

/**
 * Hash a password for the seed users.
 * Format: scrypt$<salt hex>$<hash hex>
 * Login in M1 should verify this format, or switch algorithm and re-seed.
 */
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, KEY_LEN);
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, salt, hex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hex) return false;
  const derived = await scryptAsync(password, salt, KEY_LEN);
  const actual = Buffer.from(hex, 'hex');
  if (actual.length !== derived.length) return false;
  return timingSafeEqual(actual, derived);
}
