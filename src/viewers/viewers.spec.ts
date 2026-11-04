import { cleanName, identityKey } from './viewers.service';
import { displayPhone, normalizePhone } from './phone';
import { hashPassword, verifyPassword } from './password';

describe('normalizePhone', () => {
  it.each([
    ['012 345 678', '+85512345678'],
    ['012-345-678', '+85512345678'],
    ['+855 12 345 678', '+85512345678'],
    ['85512345678', '+85512345678'],
    ['+855 012 345 678', '+85512345678'],
    ['096 123 4567', '+855961234567'],
    ['12345678', '+85512345678'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each([
    '',
    '12345',
    '0123456789012',
    '+66 81 234 5678',
    'abc',
    '012 345 67a',
    42,
  ])('rejects %p', (input) => {
    expect(normalizePhone(input)).toBeNull();
  });
});

describe('displayPhone', () => {
  it('writes numbers the local way', () => {
    expect(displayPhone('+85512345678')).toBe('012 345 678');
    expect(displayPhone('+855961234567')).toBe('096 123 4567');
  });
});

describe('passwords', () => {
  it('verifies the right password only', async () => {
    const stored = await hashPassword('correct horse');
    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$/);
    await expect(verifyPassword('correct horse', stored)).resolves.toBe(true);
    await expect(verifyPassword('wrong horse', stored)).resolves.toBe(false);
  });

  it('salts every hash and rejects junk', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
    await expect(verifyPassword('x', 'plain-text')).resolves.toBe(false);
  });
});

describe('identityKey', () => {
  it('finds Telegram accounts by numeric id', () => {
    expect(identityKey({ provider: 'telegram', subject: '123456789' })).toEqual(
      {
        telegramId: 123456789n,
      },
    );
    expect(() =>
      identityKey({ provider: 'telegram', subject: 'abc' }),
    ).toThrow();
  });

  it('finds Google accounts by sub', () => {
    expect(identityKey({ provider: 'google', subject: '1098-x' })).toEqual({
      googleSub: '1098-x',
    });
  });
});

describe('cleanName', () => {
  it('tidies spaces and caps the length', () => {
    expect(cleanName('  Sok   Dara ')).toBe('Sok Dara');
    expect(cleanName('x'.repeat(80))).toHaveLength(60);
  });

  it('never returns an empty name', () => {
    expect(cleanName('   ')).toBe('អ្នកមើល');
  });
});
