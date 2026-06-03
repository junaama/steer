export function randomId(prefix = 's'): string {
  return `${prefix}-${crypto.randomUUID()}`
}
