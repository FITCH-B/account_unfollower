# account_unfollower

Unfollow the X accounts you follow that don't follow you back. Slowly, with a dry run first, from your own X
developer app. One file, no dependencies, Node.js 18 or newer.

## What it does

1. It signs in to X with your own app's keys (OAuth 1.0a, from the environment). The keys are never written to disk and are
   never sent anywhere except `api.x.com`.
2. It reads your following and followers lists and writes the plan: everyone you follow who does not follow you,
   minus your keep-list. Nothing is unfollowed. Review `unfollow-plan.csv`.
3. With `--apply` it asks how many to unfollow now (default 50, never more than 400 a day in total) and how far apart (default 20 to 60 seconds), then unfollows, and stops at the first error or
   rate limit. Progress is saved in `unfollow-state.json`, so you can run it again tomorrow and it continues.

## Read this first

- **X's rules.** X forbids following or unfollowing "in a bulk, aggressive, or indiscriminate manner". Large, fast
  unfollow runs can get an account restricted. The defaults are deliberately slow. Raising `--max-per-day` is your
  call and your risk (hard maximum 400).
- **Cost.** On X's pay-per-use API, reading your lists is billed per account returned. The tool shows an estimate and
  asks before reading. Set `--price-per-read` to your plan's current price; the default `0.01` is only a guess.
- **"Follows you" is a snapshot.** The plan reflects the moment you built it. Use `--refresh` to rebuild.
- X does not say when you followed someone, so there is no "followed in the last N days" filter. Use the keep-list.

## Setup (once): OAuth 1.0a keys, the tested way in

1. Create a developer account and an app at [console.x.com](https://console.x.com), and add API credits (X's API is
   pay per use; without credits it answers 402).
2. In the app's **User authentication settings**, set **App permissions** to **Read and write** and save.
3. In **Keys and tokens > OAuth 1.0 Keys**, copy the **Consumer Key** and **Consumer Secret**, then **Generate** the
   **Access Token** and **Access Token Secret** (they must show "Read and write"; regenerate them if you changed the
   permissions afterwards).

Pass the four keys in the environment for each command. They are never written anywhere:

```bash
export X_CONSUMER_KEY=... X_CONSUMER_SECRET=... X_OAUTH1_TOKEN=... X_OAUTH1_TOKEN_SECRET=...
```

These keys do not expire on their own. Treat them like a password: never paste them anywhere public, and regenerate
them in the console if they leak. Close the terminal when you are done so they do not linger in it.

## Use

```bash
# 1. Build the plan. Reads both lists after you confirm the estimate; unfollows nobody.
node unfollow.mjs --keep keep.txt --skip-verified

# 2. Check unfollow-plan.csv, then start. It asks how many now and how far apart.
node unfollow.mjs --apply

# 3. Later or tomorrow: the same command continues where it stopped.
node unfollow.mjs --apply
```

## Other ways to log in

- **Console OAuth 2.0 token:** `X_ACCESS_TOKEN=... node unfollow.mjs`. Fine for building the plan, but tokens from the
  console's Generate button come with read scopes only (`users.read follows.read tweet.read`), so `--apply` gets 403.
  They also expire after about two hours.
- **Browser login:** `node unfollow.mjs --client-id YOUR_OAUTH2_CLIENT_ID` (OAuth 2.0 with PKCE). Needs the app set to
  **Native App** with the callback `http://127.0.0.1:8723/callback` (or your `--port`). X refused this login for some
  apps during testing with only "You weren't able to give access to the App" and no reason, so prefer the keys above.
  If it fails, check that the settings saved (a saved Native App shows no OAuth 2.0 Client Secret), that the Client ID
  is the OAuth 2.0 one from the same app, and that the account has API credits. A confidential (Web App) client also
  needs `X_CLIENT_SECRET` in the environment.

## Options

| Option | Meaning |
|---|---|
| `--keep file.txt` | Never unfollow these. One `@handle`, handle or numeric user id per line; `#` comments. |
| `--skip-verified` | Never unfollow verified accounts. |
| `--max-per-day 50` | How many to unfollow in this run, 1 to 400. Without it, `--apply` asks (Enter keeps 50). Never more than 400 in one calendar day (UTC), counting every run. |
| `--delay-min 20` `--delay-max 60` | Seconds between unfollows (random in that range). Without them, `--apply` asks: `30` or `20-60` (Enter keeps 20-60). Minimum 5; averaging under 18 s hits X's 50-per-15-minutes limit. |
| `--refresh` | Read the lists again and rebuild the plan. |
| `--port 8723` | Local port for the login callback. Must match the app's callback URI. |
| `--price-per-read 0.01` | Your plan's price per account read, for the estimate. |
| `--yes` | Skip the confirmation prompts. |

## Files it writes (keep them private)

- `unfollow-plan.csv`: who would be unfollowed.
- `unfollow-state.json`: the plan, progress and daily counts. No token.

Both name real accounts. `.gitignore` excludes them; don't publish them.

## Tests

```bash
node --test unfollow.test.mjs
```

## Licence

MIT. See `LICENSE`. Provided as is; you run it on your own account at your own risk.
