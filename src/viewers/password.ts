import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Viewer passwords, hashed with scrypt (Node's built-in; no native dependency). Stored as
 * "scrypt$N$r$p$<salt base64>$<hash base64>" so the cost can be raised later and old hashes still check.
 */
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

function derive(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_LENGTH,
      { N: n, r, p, maxmem: 64 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await derive(
    password,
    Buffer.from(salt, 'base64'),
    Number(n),
    Number(r),
    Number(p),
  );
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A hash of a random password: login checks it when the phone is unknown, so timing doesn't reveal which phones have accounts */
export const DUMMY_HASH_PROMISE = hashPassword(randomBytes(12).toString('hex'));
