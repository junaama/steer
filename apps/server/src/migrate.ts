// DB migration runner. Populated in U2/U3 (drizzle migrate against DATABASE_URL).
// For now it is a clean no-op so the compose `migrate` one-shot exits 0 and the
// server can boot behind it.

// eslint-disable-next-line no-console
console.log('[migrate] no migrations yet — U2/U3 wire up drizzle migrations')
process.exit(0)
