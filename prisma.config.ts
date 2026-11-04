import { defineConfig } from 'prisma/config';

// Only `prisma generate` is used; the schema is owned by VideoLingo's Flyway migrations.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
