# movie-api, the VideoLingo admin portal and RuengFlix

movie-api is the backend of **RuengFlix**, the site where viewers watch the series. It has no database of its own: it shares everything with the **VideoLingo admin portal**, where the content is managed.

| | Where | What it is |
|---|---|---|
| **Admin portal frontend** | `../../nuxt/videolingo-web` | Nuxt app (:3000) where staff manage collections, videos and subtitles, and turn on **Show on RuengFlix** |
| **Admin portal backend** | `../../java/videolingo` | Spring Boot API (:8080). It owns the database schema and uploads files to the bucket. |
| **movie-api** (this project) | `../../nest/movie-api` | NestJS API (:3020). It serves the catalog to RuengFlix and stores viewer data. |
| **Viewer frontend (RuengFlix)** | `../../nuxt/movie-frontend` | Nuxt app (:3010) for watching: home, browse, search, a binge player, a Shorts feed, VIP unlocks, Telegram alerts, and its own `/admin` for insights and reports |

This page explains how they fit together. For movie-api's routes, see [README.md](README.md).

```
  staff                                                        viewers
    │                                                             │
    ▼                                                             ▼
 admin portal frontend (videolingo-web, :3000)        RuengFlix (movie-frontend, :3010)
    │ /api/** proxied server-side                       │ server-side only            ▲
    ▼                                                   │ Bearer MOVIE_API_TOKEN      │
 admin portal backend (VideoLingo, Java, :8080)         ▼                             │
    │                     │                    movie-api (Nest, :3020)                │
    ▼                     ▼                         │             │                   │
 PostgreSQL videolingo_db ◄─────────── Prisma ──────┘             │ signs links       │
                          MinIO / S3 bucket "videolingo" ◄────────┘                   │
                                   ▲                                                  │
                                   └──── browser plays video and images directly ─────┘
```

## Who owns what

| | Owner | movie-api's access |
|---|---|---|
| Database schema (every table) | VideoLingo, through Flyway (`src/main/resources/db/migration`) | None. Never run `prisma migrate` or `prisma db push`. |
| `collections`, `collection_items`, `videos`, `subtitles`, `subtitle_cues` | VideoLingo (edited in the admin portal) | Read only |
| `streaming_episode_stats`, `streaming_reports`, `streaming_follows`, `streaming_alert_marks` | Created by VideoLingo's `V17__streaming_viewer_data.sql` | movie-api writes them; the admin portal's RuengFlix pages read them and make a few admin changes (see below) |
| `streaming_alert_log`, `collections.featured_rank` | Created by VideoLingo's `V18__streaming_admin.sql` | movie-api writes the alert log and reads the hero order |
| `app_settings` row `streaming` (prices) | VideoLingo (`Settings.Streaming`) | Read only (`GET /site`) |
| `streaming_viewers`, `streaming_viewer_libraries` | Created by VideoLingo's `V19__streaming_viewers.sql` | movie-api creates accounts, checks passwords and stores libraries; the admin portal lists and disables accounts |
| Uploaded files (videos, thumbnails, artwork, audio) | VideoLingo uploads them to the bucket | movie-api only signs download links. It never uploads or deletes. |
| Redis | VideoLingo | Not used |
| Admin portal frontend | videolingo-web | None. It talks only to VideoLingo, never to movie-api. |
| Viewer frontend | movie-frontend (RuengFlix) | movie-api's only caller. Its server calls movie-api; browsers never do. |

The frontend reaches VideoLingo through Nitro's `routeRules` proxy (`/api/** → NUXT_BACKEND_BASE/api/**`), because the backend has no CORS config. Its only RuengFlix code is the series settings in the collection form: `app/components/CollectionFormModal.vue` and `shared/utils/streamingSeries.ts`.

The RuengFlix migrations in VideoLingo are:

- `V16__streaming_series.sql` adds the series settings to `collections` (`streaming`, `series_category`, `series_status`, `vip`, `free_episodes`, `recap_seconds`, `search_keywords`, `region`, `release_year`, `genres`, `banner_url`, `vertical_url`).
- `V17__streaming_viewer_data.sql` creates the four `streaming_*` tables. Rows are deleted along with their collection.
- `V19__streaming_viewers.sql` creates viewer accounts and their synced libraries.
- `V20__viewer_sign_in_methods.sql` lets accounts sign in with Telegram or Google (`telegram_id`, `google_sub` and profile columns; phone and password become optional).
- `V18__streaming_admin.sql` adds `collections.featured_rank` (the home hero order) and the `streaming_alert_log` table (every alert sent, for the admin portal's history).

**To add a series setting**, for example a new `collections` column:

1. **VideoLingo:** add a Flyway migration, then the field on `StreamingSeries` and `StreamingSettingsDto`.
2. **videolingo-web:** add it to `StreamingSettings` and `StreamingForm` in `shared/utils/streamingSeries.ts` and to the form in `CollectionFormModal.vue`. To check the types against the backend, regenerate `shared/api.generated.d.ts` (see that project's README).
3. **movie-api:** after VideoLingo has applied the migration, add the column to `prisma/schema.prisma` by hand, run `npx prisma generate`, and use it in `src/catalog`. Map only the columns movie-api uses.

## Settings: VideoLingo → movie-api

Both projects read the same values. They just spell the database setting differently.

| VideoLingo `.env` | movie-api `.env` |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD` | `DATABASE_URL=postgresql://<DB_USERNAME>:<DB_PASSWORD>@<DB_HOST>:<DB_PORT>/<DB_NAME>` (leave out `:<DB_PASSWORD>` when it's empty) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | Same names, same values |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT` | Same names, same values |
| `MEDIA_SIGNED_URLS`, `MEDIA_URL_TTL_MINUTES` | Same names, same values |
| Server's time zone | `DB_TIME_ZONE`, only if movie-api runs in a different zone (see below) |
| `REDIS_*`, `JWT_SECRET`, `MAIL_*`, AI and pipeline keys | Not needed |

movie-api's own settings are `MOVIE_API_TOKEN` (shared with RuengFlix as `NUXT_MOVIE_API_TOKEN`) and `PORT` (RuengFlix's `NUXT_MOVIE_API_BASE` points to it).

VideoLingo has three settings for its RuengFlix pages:

| VideoLingo `.env` | What for |
|---|---|
| `MOVIE_API_URL` | movie-api's address, for the status panel |
| `RUENGFLIX_URL` | RuengFlix's public address, for preview links, sending alerts and refreshing |
| `RUENGFLIX_NOTIFY_SECRET` | Must equal RuengFlix's `NUXT_NOTIFY_SECRET`; without it, Send alert and Refresh site are disabled |

### Local development

With VideoLingo's defaults (Postgres on 5432 with user `postgres` and no password, MinIO on 9000):

```env
DATABASE_URL=postgresql://postgres@localhost:5432/videolingo_db

AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin
S3_BUCKET=videolingo
S3_ENDPOINT=http://localhost:9000
S3_PUBLIC_ENDPOINT=http://localhost:9000
MEDIA_SIGNED_URLS=true
MEDIA_URL_TTL_MINUTES=180
```

Start them in this order:

1. Postgres and MinIO.
2. VideoLingo (`./mvnw spring-boot:run`). On startup it applies its migrations; movie-api needs at least V19.
3. videolingo-web (`npm run dev`, with `NUXT_BACKEND_BASE=http://localhost:8080`). You only need it to edit content.
4. movie-api (`npm run start:dev`). Check `GET http://localhost:3020/health`, which needs no token.
5. movie-frontend (`npm run dev`, http://localhost:3010) with this in its `.env`:

   ```env
   NUXT_MOVIE_API_BASE=http://localhost:3020
   NUXT_MOVIE_API_TOKEN=<same value as MOVIE_API_TOKEN here>
   NUXT_PUBLIC_VIDEOLINGO_ADMIN_URL=http://localhost:3000   # optional: linked from RuengFlix's /admin
   ```

## The viewer site (RuengFlix)

RuengFlix's server (`server/utils/movieApi.ts` and the other files in `server/utils`) wraps movie-api. The browser only talks to RuengFlix's own `/api` and `/subtitles` routes. The exception is media: video (played with hls.js) and images load from the bucket directly, through signed links.

| RuengFlix feature | RuengFlix server file | movie-api route |
|---|---|---|
| Home, browse, search, series page | `utils/movieApi.ts`, `api/catalog.get.ts` | `GET /series` |
| Episode list and player | `utils/movieApi.ts`, `api/series/[id]/episodes.get.ts` | `GET /series/:id` |
| Khmer subtitles (`/subtitles/<series>/<ep>.vtt`) | `routes/subtitles/[id]/[file].ts` | `GET /episodes/:videoId/subtitles.vtt` |
| 👍/👎 at the end of an episode | `utils/ratings.ts` | `POST /votes`, `GET /series/:id/stats`, `GET /likes` |
| Plays, and Insights on `/admin` | `utils/insights.ts` | `POST /plays`, `GET /series/:id/stats` |
| Report a problem, and Reports on `/admin` | `utils/reports.ts` | `POST /reports`, `GET /reports?includeResolved=true`, `PUT /reports/:id` |
| Telegram follow and stop (bot webhook) | `utils/follows.ts` | `POST /follows`, `GET /series/:id/followers`, `GET /chats/:chatId/follows`, `DELETE /chats/:chatId/follows` |
| New-episode alerts | `utils/catalog.ts` | `POST /series/:id/alerts` |

Two more movie-api routes:

- `GET /site` returns the prices set in the admin portal. RuengFlix serves them at `/api/site` for its VIP page and unlock wall.
- `POST /series/:id/alerts/log` records each alert RuengFlix sent, with its counts, for the admin portal's alert history.

`DELETE /follows/:seriesId/:chatId` exists in movie-api, but RuengFlix doesn't call it. The admin portal removes followers directly.

How RuengFlix behaves with movie-api:

- **Cache:** RuengFlix caches the `GET` catalog calls for 30 seconds, sending one request per path at a time. New episodes and edits in the admin portal show up within about a minute.
- **If movie-api goes down:** RuengFlix keeps serving the last catalog it fetched. Votes, plays and reports fail with 502 until movie-api is back.
- **Timeouts:** every call has a 5-second timeout and carries `Authorization: Bearer NUXT_MOVIE_API_TOKEN`.
- **Rate limits:** RuengFlix applies its own per-IP limits, for example 30 votes per minute. movie-api has none, so keep it unreachable from the internet.
- **Without `NUXT_MOVIE_API_BASE`:** RuengFlix falls back to its built-in sample series, with viewer data in its local `.data` folder. That's useful for its browser tests, but none of it touches VideoLingo's database.
- **Two admin pages:** RuengFlix's own `/admin` still shows Insights and Reports. The admin portal's RuengFlix pages (below) now cover the same data, so `/admin` can be retired once nobody uses it.
- **Called by the admin portal:** `POST /api/notify` (send an alert now, logged as MANUAL) and `POST /api/refresh` (drop the 30-second cache). Both need `Authorization: Bearer NUXT_NOTIFY_SECRET`.

## Managing RuengFlix from the admin portal

videolingo-web has a **RuengFlix** group in its sidebar, backed by VideoLingo's `/api/admin/streaming/**` (`StreamingAdminController`, permission module `streaming`: GET needs READ, the rest WRITE). Every change is written to the audit log.

| Page | What it does |
|---|---|
| **Overview** (`/ruengflix`) | Status of movie-api, RuengFlix and bucket privacy. Each streaming collection's state (Live, Hidden: not Public, No episodes yet), plays, finish %, votes, followers, open reports and checklist. Home hero order. **Refresh site** button. |
| **Series** (`/ruengflix/:id`) | Checklist of what to fix, plus per-episode plays, finish %, continue % with the biggest drop-off highlighted, and votes. Reset votes for one episode or all. Alert history and **Send alert now**. Telegram followers, with Remove. |
| **Problem reports** (`/ruengflix/reports`) | Open or all reports, filterable by series, with a link to the exact moment on RuengFlix. Resolve or reopen (with Undo); `resolved_by` records the admin's username. |
| **Prices** (`/ruengflix/prices`) | The series-unlock and VIP plan prices RuengFlix shows (`Settings.Streaming`). Display only: payments aren't built. |

The collection form also gained **Upload** buttons for the cover, banner and vertical images (stored like video thumbnails, up to 5 MB) and a **Hero position** field.

**The checklist** (`SeriesReadiness.java`) flags:

- errors: the collection isn't Public, or it has no released episodes;
- warnings: no category, cover or vertical image; a hero pick without a banner; episodes without published Khmer or default subtitles; videos the site skips; VIP with every episode free.

**Not built yet: payments.** Unlocks still live only in the viewer's browser and KHQR isn't connected. Real unlocks need viewer accounts, a payment provider, an unlocks table, and movie-api checking unlocks before returning VIP links.

## Viewer accounts

Viewers can create an account on RuengFlix with a **Cambodian phone number and a password** (`/register`, `/login`, or the account section on the Me page).

- **Where it's stored:** VideoLingo's database (V19). movie-api normalizes the number to E.164 (`012 345 678` → `+85512345678`) and hashes the password with scrypt (Node's built-in). The number isn't verified by SMS yet.
- **Sessions:** RuengFlix keeps the viewer's id in an encrypted, HTTP-only cookie (`rf_viewer`, 60 days). It needs `NUXT_SESSION_SECRET` (32+ characters) and movie-api; without either, the account links stay hidden. Each session remembers the account's `session_version`, so raising the version signs the viewer out everywhere.
- **What syncs:** saved and followed series, watch history with resume positions, unlocked series, votes, "seen" episode counts and recent searches. Player settings stay per device. On sign-in, the device's library and the account's are merged once; after that, changes are saved about two seconds after they happen. Signing out clears the device's copy; it stays in the account.
- **Password change:** keeps this device signed in and signs out every other device.
- **Telegram and Google (V20):** viewers can also sign in with Telegram or Google, or add either to an account they already have (Me page). An account needs at least one way in: phone + password, Telegram or Google (a database check enforces it).
  - **Who checks the sign-in:** RuengFlix's server, then it calls `POST /viewers/identity`. For Telegram, RuengFlix checks the Login Widget's HMAC with the bot token and rejects data older than an hour. For Google, it runs the authorization-code flow with state and PKCE, and checks the ID token's issuer, audience and expiry.
  - **What movie-api does:** finds the viewer by Telegram id or Google `sub`, or creates one. With `linkTo`, it adds the account to that viewer instead (409 `IDENTITY_TAKEN` if another viewer has it).
  - **Telegram alerts:** a viewer's Telegram id is also their chat with the bot. Following a series on the site then turns on alerts directly (RuengFlix `/api/follows`), with no `/start` deep link.
- **Admin portal:** RuengFlix › **Viewers** lists accounts with their ways in (search by name, phone, Telegram username or Google email; filter active or disabled). **Disable** signs the viewer out everywhere and blocks sign-in until they're enabled again.
- **Rate limits (RuengFlix, per IP):** 10 sign-ins per 15 minutes, 5 registrations per hour, 10 password changes per 15 minutes.

movie-api routes, called only by RuengFlix's server:

| Route | |
|---|---|
| `POST /viewers` | Register `{ phone, password, displayName }`; 409 `PHONE_TAKEN`, 400 `PHONE_INVALID` |
| `POST /viewers/login` | `{ phone, password }`; 401 `WRONG_LOGIN`, 403 `DISABLED` |
| `POST /viewers/identity` | A Telegram or Google account RuengFlix verified: `{ provider, subject, displayName, username?, email?, photoUrl?, linkTo? }`. Signs in, creates, or links. 409 `IDENTITY_TAKEN`, 403 `DISABLED` |
| `GET /viewers/:id` | The account, including `sessionVersion` and `disabled` |
| `PUT /viewers/:id/password` | `{ current, next }`; raises `sessionVersion`; 400 `NO_PASSWORD` for Telegram or Google accounts |
| `GET` / `PUT /viewers/:id/library` | The synced library, `{ data }`, at most 256 KB |

Not built yet: SMS verification, "forgot password", and payments tied to accounts (unlocks sync, but nothing can be bought yet).

## Media links

The database stores plain bucket addresses: `S3_PUBLIC_ENDPOINT/S3_BUCKET/<key>`. movie-api's `MediaUrls` (`src/media/media-urls.ts`) is a port of VideoLingo's `storage/MediaUrls.java`. It turns those addresses into signed links that expire after `MEDIA_URL_TTL_MINUTES`, and passes any other link through unchanged.

- The S3 client uses path-style addressing (`forcePathStyle`), which MinIO needs.
- Links are signed against `S3_PUBLIC_ENDPOINT`, because the viewer's browser opens them. If MinIO sits behind another host or a proxy in production, set `S3_PUBLIC_ENDPOINT` to the address browsers use, in both projects.
- Signing only protects files if the bucket is private. For MinIO, run `mc anonymous set none <alias>/videolingo`.

## Publishing a series

In the admin portal frontend, open **Collections** and edit a collection (`/collections` or `/collections/:id`). In the form, switch on **Show on RuengFlix** and fill in the series fields: category, status, VIP and free episodes, recap seconds, release year, genres, region, search keywords, and banner and vertical artwork URLs. If the collection isn't Public, the form warns that it will stay hidden.

The form saves through the backend as `streaming` on `PUT /api/admin/collections/{id}` (`StreamingSettingsDto`), and movie-api reads the result from the `collections` table. A collection appears on RuengFlix when:

1. its visibility is **Public**, and
2. **Show on RuengFlix** is on (`collections.streaming = true`), and
3. at least one of its videos is released.

A video is released when it is enabled and Public and isn't archived or in the trash.

- **Episodes** are the released videos in collection order, numbered 1, 2, 3… Hiding a video renumbers every episode after it.
- **Scheduled videos** (not enabled yet, with a future `publish_at`) count as upcoming. VideoLingo enables them when that time comes.
- **VIP:** with `vip` on, episodes after `free_episodes` are locked. movie-api leaves out their video and subtitle links.
- **Subtitles:** only published subtitles are served, as WebVTT, from `GET /episodes/:videoId/subtitles.vtt`.
- **Artwork:** the banner and vertical artwork fields take any URL. A URL into the bucket gets a signed link; any other URL is passed to viewers unchanged.
- **When changes appear:** movie-api reads the database on every request, but RuengFlix caches the catalog for 30 seconds. Changes saved in the admin portal show up on the site within about a minute.

To check which collections qualify:

```sql
select id, slug, visibility, streaming from collections order by id;
```

## Time zones

VideoLingo stores times as `timestamp without time zone` in its server's local time. `src/common/db-time.ts` converts them to and from real UTC instants using `DB_TIME_ZONE`, which defaults to movie-api's own zone. When both run on the same machine or in the same zone, leave it unset.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `role "…" does not exist` or `password authentication failed` | `DATABASE_URL` doesn't match VideoLingo's `DB_*` settings |
| `relation "streaming_…" does not exist` | VideoLingo hasn't applied V16 and V17 to this database. Start VideoLingo once. |
| `/series` returns `[]` | No Public collection has **Show on RuengFlix** on with a released video |
| The admin portal shows network errors on `/api/...` | VideoLingo isn't running, or videolingo-web's `NUXT_BACKEND_BASE` points to the wrong address |
| RuengFlix shows sample series, not yours | `NUXT_MOVIE_API_BASE` isn't set in movie-frontend |
| RuengFlix returns 502 "movie-api is unreachable" | movie-api is down, or `NUXT_MOVIE_API_TOKEN` doesn't match `MOVIE_API_TOKEN`. RuengFlix reports any movie-api error except 404 as a 502; movie-api's log shows 401 for a wrong token. |
| An edit in the admin portal isn't on RuengFlix yet | RuengFlix's 30-second catalog cache. Wait up to a minute, or press **Refresh site** on RuengFlix › Overview. |
| Send alert or Refresh site is disabled | VideoLingo needs `RUENGFLIX_URL` and `RUENGFLIX_NOTIFY_SECRET` |
| "RuengFlix refused the secret" | `RUENGFLIX_NOTIFY_SECRET` in VideoLingo doesn't equal `NUXT_NOTIFY_SECRET` in RuengFlix |
| `column "featured_rank" does not exist` from movie-api | VideoLingo hasn't applied V18. Start VideoLingo once. |
| Media links return 403 | Wrong S3 keys, or the clocks of movie-api and MinIO disagree |
| Media links don't open in the browser | `S3_PUBLIC_ENDPOINT` isn't reachable from the browser |
