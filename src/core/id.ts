const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
// The largest multiple of the alphabet's size a byte holds: a byte at
// or past it is drawn again, so every character is equally likely.
const LIMIT = 256 - (256 % ALPHABET.length);

/** A random id of `size` characters from [0-9a-z]. */
export function id(size = 12): string {
  let out = "";
  while (out.length < size) {
    for (const byte of crypto.getRandomValues(new Uint8Array(size * 2))) {
      if (byte < LIMIT) out += ALPHABET[byte % ALPHABET.length];
      if (out.length === size) break;
    }
  }
  return out;
}
