const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function decodeBase58(str: string): Uint8Array {
  if (!str) return new Uint8Array();
  const bytes = [0];
  for (let i = 0; i < str.length; i++) {
    const value = ALPHABET.indexOf(str[i]);
    if (value < 0) throw new Error("base58 tidak valid");
    for (let j = 0; j < bytes.length; j++) bytes[j] *= 58;
    bytes[0] += value;
    let carry = 0;
    for (let j = 0; j < bytes.length; j++) {
      bytes[j] += carry;
      carry = bytes[j] >> 8;
      bytes[j] &= 0xff;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; str[i] === "1" && i < str.length - 1; i++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

export function encodeBase58(buffer: Uint8Array): string {
  const bytes = Array.from(buffer);
  let zero = 0;
  while (zero < bytes.length && bytes[zero] === 0) zero++;
  const prefix = "1".repeat(zero);
  if (zero === bytes.length) return prefix;
  const digits = [0];
  for (let i = zero; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return prefix + digits.reverse().map((d) => ALPHABET[d]).join("");
}
