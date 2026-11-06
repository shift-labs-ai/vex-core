import { customAlphabet } from "nanoid";

const generate = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz");

export function id(size = 12): string {
  return generate(size);
}
