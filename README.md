# movie-api

The backend of **RuengFlix**, the Khmer short-drama streaming site (`../../nuxt/movie-frontend`). It serves the series catalog and stores what viewers do: votes, plays, problem reports, Telegram follows and new-episode alerts.

It has no database of its own. It reads and writes **VideoLingo's PostgreSQL** through Prisma:

```
browser → RuengFlix (Nuxt) → movie-api (Nest) → VideoLingo's PostgreSQL ← VideoLingo (Java) ← videolingo-web
```

- **Content** is managed in videolingo-web. A Public collection with **Show on RuengFlix** switched on is a series. Its videos that are enabled, Public, and not archived or in the trash are its episodes, in collection order.
- **The schema belongs to VideoLingo.** Its Flyway migrations create every table, including the RuengFlix ones (`V16__streaming_series.sql`, `V17__streaming_viewer_data.sql`). Never run `prisma migrate` or `prisma db push` here.
- **Only RuengFlix's server calls movie-api.** Every route except `/health` needs `Authorization: Bearer <MOVIE_API_TOKEN>`.

## Run it

```bash
cp .env.example .env    # then fill in DATABASE_URL and MOVIE_API_TOKEN
npm install             # also generates the Prisma client (src/generated, ignored by git)
npm run start:dev       # http://localhost:3020
```

VideoLingo must have run its migrations on that database, at least up to V18.

On RuengFlix, set `NUXT_MOVIE_API_BASE=http://localhost:3020` and `NUXT_MOVIE_API_TOKEN` to the same token.

| Variable | |
|---|---|
| `DATABASE_URL` | VideoLingo's PostgreSQL |
| `MOVIE_API_TOKEN` | Shared secret with RuengFlix, at least 24 characters (`openssl rand -hex 24`) |
| `PORT` | Default 3020 |
| `DB_TIME_ZONE` | Time zone of VideoLingo's server; default is this machine's zone (see below) |
| `AWS_*`, `S3_*`, `MEDIA_SIGNED_URLS`, `MEDIA_URL_TTL_MINUTES` | The same values as VideoLingo, so stored videos and images get signed links |

## API

| Method and path | What it does |
|---|---|
| `GET /series` | Series with at least one released episode, newest episode first; `featuredRank` is the hero order set in videolingo-web |
| `GET /series/:id` | One series and its episodes; a locked VIP episode has no `videoUrl` or `subtitlesUrl` |
| `GET /episodes/:videoId/subtitles.vtt` | WebVTT for a released, unlocked episode; 404 otherwise |
| `POST /plays` | `{ seriesId, episode, event: "START" \| "COMPLETE" }` |
| `POST /votes` | `{ seriesId, episode, vote: 1 \| -1 \| 0, previous? }`; returns the episode's `{ likes, dislikes }` |
| `GET /series/:id/stats` | Per episode: starts, completes, likes, dislikes |
| `GET /likes` | Likes and dislikes per series |
| `POST /reports`, `GET /reports?includeResolved=true`, `PUT /reports/:id` | Problem reports; `PUT` takes `{ resolved, resolvedBy? }` |
| `POST /follows`, `DELETE /follows/:seriesId/:chatId` | Follow or unfollow a series from a Telegram chat |
| `GET /series/:id/followers`, `GET /chats/:chatId/follows`, `DELETE /chats/:chatId/follows` | Who follows a series, what a chat follows, stop a chat's alerts |
| `POST /series/:id/alerts` | `{ alert, episodes }`. `alert` is true exactly once per new episode count, however many RuengFlix instances ask. |
| `POST /series/:id/alerts/log` | `{ episode, source: "AUTO" \| "MANUAL", followers, sent, removed, failed }`: records an alert RuengFlix sent |
| `GET /site` | `{ prices }`: the prices set in videolingo-web (Streaming › Prices), or the defaults |
| `GET /health` | No token needed; 200 when the database answers |

Writes are accepted only for listed series and released episodes; anything else gets 404. Unknown body fields get 400.

## Things to know

- **Time zones:** VideoLingo stores times as `timestamp without time zone` in its server's local time, and Prisma reads those values as UTC. `src/common/db-time.ts` converts both ways using `DB_TIME_ZONE`, so the API returns real UTC instants and writes local times the way VideoLingo does. Set `DB_TIME_ZONE` when movie-api runs in a different zone from VideoLingo.
- **Prisma 7** uses the `pg` driver adapter. It needs no engine download, so `npm install` works on networks that can't reach `binaries.prisma.sh`. The schema (`prisma/schema.prisma`) maps only the tables and columns RuengFlix uses.
- **Tests:** `npm test` runs the unit tests:
  - episode rules;
  - VTT output;
  - signed links;
  - time-zone conversion;
  - vote arithmetic.
