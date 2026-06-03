// Schema spine — the single source of truth for the data model.
// Populated in U2: drizzle tables (sessions, append-only events, controls),
// drizzle-zod row schemas, tool I/O schemas, and the read-only/side-effecting
// tool policy map. For now this stub keeps the workspace resolvable.

export const SCHEMA_VERSION = '0.0.0' as const
