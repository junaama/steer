CREATE TABLE "environments" (
	"id" text PRIMARY KEY NOT NULL,
	"env" text,
	"host" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
