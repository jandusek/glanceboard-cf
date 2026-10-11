# glanceboard-cf

A Cloudflare Worker that draws today's calendar as an illustration for a 7.3" Spectra 6 e-ink frame (Waveshare PhotoPainter).

On each scheduled hour the Worker:
1. reads today's events from an iCal feed
2. gets the forecast from Open-Meteo
3. asks Workers AI to reword the events (with an emoji each) and write a scene description; this step is optional, and its result is cached per day's inputs
4. fills in your prompt template
5. sends it to a Gemini image model, along with photos of today's characters
6. crops the result to 800×480, dithers it to the six e-ink inks, and stores it in R2 (settings and run state are in KV)

The frame fetches the result from `/display`. If nothing has changed since the last picture, the Worker skips the Gemini call.

This is a serverless rewrite of [google-gemini/glanceboard](https://github.com/google-gemini/glanceboard). The original is a Python server you host on a VM, a container or a Raspberry Pi. This version runs entirely on Cloudflare: Workers for the dashboard and scheduler, R2 for pictures, KV for settings, and Workers AI for the text step. There's no infra to host or maintain.

## Cost

Everything runs on one Cloudflare account and one Gemini API key.

- **Cloudflare:** the Workers Paid plan, $5/month (see [Deploy](#deploy) for why). R2, KV and cron usage at one picture a day stay well within what that plan includes.
- **Workers AI:** the optional text step uses a few thousand tokens a day. That fits within the free 10,000 neurons a day, and even at list price it's under $1 a year.
- **Gemini:** the only cost that grows with use. It's billed per generated image (October 2026 [list prices](https://ai.google.dev/gemini-api/docs/pricing), ~1K image), and the API's free tier doesn't cover image models:

| Image model | Per image | One image a day, per year |
|---|---|---|
| Nano Banana 2.1 (default) | $0.034 | ~$12 |
| Gemini 3 Pro Image | $0.134 | ~$49 |
| Gemini 3.1 Flash Image | $0.067 | ~$25 |
| Gemini 3.1 Flash Lite Image | $0.034 | ~$12 |

Character photos and the prompt add about a cent a day in input tokens with the Pro model, and less with the others. Each extra scheduled hour that produces a new picture adds the same amount again. Hours where nothing changed are skipped without calling Gemini.

All in, at one picture a day: about $72–115 a year, $60 of which is the Workers plan.

## Layout

| Path | What it is |
|---|---|
| `src/index.ts` | Routes and the cron handler |
| `src/pipeline.ts` | Builds the prompt, generates, stores; also runs the schedule |
| `src/calendar.ts` | iCal parsing and recurrence expansion (`ical.js`), with times converted to the board's zone |
| `src/weather.ts` | Open-Meteo forecast, clothing hint, season |
| `src/prompt.ts` | Default template, placeholders, character casting |
| `src/image.ts` | Decode, crop/resize, Floyd–Steinberg dither, battery line, PNG encoder |
| `src/gemini.ts` | The Gemini `generateContent` call |
| `src/polish.ts` | Workers AI rewording of events and the scene description, cached in R2 |
| `public/` | The dashboard: static HTML, CSS and JS with no build step and hash-routed pages |

Storage:
- **KV** (`KV` binding):
  - `config`: settings
  - `state`: last run, prompt, errors
  - `polish:<hash>`: cached Workers AI results, which expire after two days
- **R2** (`glanceboard-cf` bucket):
  - `display.png`, `display.idx`, `original.png`: the latest picture
  - `characters/*`: character photos

## Deploy

```bash
npm install
cp wrangler.example.jsonc wrangler.jsonc       # then set your domain in "routes"
npx wrangler r2 bucket create glanceboard-cf
npx wrangler kv namespace create glanceboard-cf   # put the id in wrangler.jsonc
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put DISPLAY_TOKEN   # optional, see below
npx wrangler deploy
```

This needs the Workers Paid plan. Decoding, dithering and encoding a picture takes about 250 ms of CPU, which is over the free plan's 10 ms limit.

### Cloudflare Access

The Worker does no authentication itself.
1. Create an Access application covering the Worker's hostname.
2. Add a second application, or a Bypass policy, for the path `/display`. The frame can't complete an Access login.

Because `/display` bypasses Access, it is public unless `DISPLAY_TOKEN` is set. With the token set, the frame must send it as `Authorization: Bearer …` (the PhotoPainter's Access Token field). The dashboard's Display page shows both the URL and the token.

### The frame

Paste the Picture URL from the Display page into the PhotoPainter's Image URL, and the Access token into its Access Token field. If battery level is turned on, the Worker draws a 1px line on the right edge based on the frame's `X-Battery-Percentage` header.

## Develop

```bash
cp .dev.vars.example .dev.vars
cp wrangler.example.jsonc wrangler.jsonc   # if you haven't already
npm run dev                      # http://localhost:8787, local R2
npm test
npm run check                    # TypeScript
```

The AI binding is always remote, so prompt previews in local dev use real Workers AI. Generate now calls Gemini and is billed.

To trigger the cron locally: `curl "http://localhost:8787/cdn-cgi/handler/scheduled"`.

## Prompt placeholders

| Placeholder | Filled with |
|---|---|
| `{{day}}` | Weekday name |
| `{{date}}` | Date, e.g. 8 October |
| `{{events}}` | Today's events (reworded by Workers AI when enabled), or the empty-day lines |
| `{{scene}}` | Scene description from Workers AI |
| `{{characters}}` | Who appears today |
| `{{countdown}}` | Birthdays and holidays in the next two weeks, up to three |
| `{{weather}}` | Weather stamp |
| `{{clothing}}` | What to wear |
| `{{season}}` | Season |
| `{{location}}` | Location name |

`{{#name}}…{{/name}}` keeps its contents only when `name` is non-empty.

## License

[MIT](LICENSE)
