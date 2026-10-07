# account_unfollower

Unfollow the X accounts you follow that don't follow you back. Slowly, with a dry run first, from your own X
developer app. One file, no dependencies, Node.js 18 or newer.

## What it does

1. You log in to X in your browser (OAuth 2.0 with PKCE). The access token stays in memory for that run only. It is
   never written to disk and never sent anywhere except `api.x.com`.
2. It reads your following and followers lists and writes the plan: everyone you follow who does not follow you,
   minus your keep-list. Nothing is unfollowed. Review `unfollow-plan.csv`.
3. With `--apply` it unfollows up to a daily cap (default 50), 20 to 60 seconds apart, and stops at the first error or
   rate limit. Progress is saved in `unfollow-state.json`, so you can run it again tomorrow and it continues.

## Read this first

- **X's rules.** X forbids following or unfollowing "in a bulk, aggressive, or indiscriminate manner". Large, fast
  unfollow runs can get an account restricted. The defaults are deliberately slow. Raising `--max-per-day` is your
  call and your risk (hard maximum 400).
- **Cost.** On X's pay-per-use API, reading your lists is billed per account returned. The tool shows an estimate and
  asks before reading. Set `--price-per-read` to your plan's current price; the default `0.01` is only a guess.
- **"Follows you" is a snapshot.** The plan reflects the moment you built it. Use `--refresh` to rebuild.
- X does not say when you followed someone, so there is no "followed in the last N days" filter. Use the keep-list.

## Setup (once)

1. Create a developer account and an app at [console.x.com](https://console.x.com).
2. In the app's **User authentication settings**:
   - App permissions: **Read and write**
   - Type of App: **Native App** (a public client, so no client secret is needed)
   - Callback URI: `http://127.0.0.1:8723/callback` (or your own port, matching `--port`)
   - Website URL: anything you own
3. Copy the app's **OAuth 2.0 Client ID**.

If your app is a confidential client (Web App), also set its secret in the environment:
`X_CLIENT_SECRET=... node unfollow.mjs ...`. Never put the secret in a file you share.

## If login fails

X's page "You weren't able to give access to the App" usually means one of these:

0. The settings were never saved. If the app shows a **Client Secret**, it is a confidential (Web App) client, so the
   Native App choice and callback did not save: edit User authentication settings again and click Save.
1. The app's **App permissions** are not **Read and write**, or the change was not saved. The plain run asks for read
   access only and `--apply` adds `follows.write`, so if the plain run logs in but `--apply` fails, this is it.
2. The `--client-id` belongs to a different app than the one you configured. Use the **OAuth 2.0 Client ID** under
   Keys and tokens, not the API key (consumer key).
3. The callback in the app settings is not exactly `http://127.0.0.1:8723/callback` (or your `--port`).
4. The app is not attached to a project, or the developer account has no API access or credits yet.

After changing settings, save them and try again; X can take a minute to apply them.

## Login without the browser (your own account)

In the developer console, **Keys and tokens > OAuth 2.0 Keys > Access Token > Generate** makes a token for the
account that owns the app. Put it in the environment for one command; it is never saved:

```bash
X_ACCESS_TOKEN=... node unfollow.mjs
```

The token needs `follows.write` for `--apply`, so the app permissions must be **Read and write** when you generate
it. Console tokens expire after about two hours; generate a fresh one for each session.

## Use

```bash
# 1. Build the plan. Reads both lists after you confirm the estimate; unfollows nobody.
node unfollow.mjs --client-id YOUR_CLIENT_ID --keep keep.txt --skip-verified

# 2. Check unfollow-plan.csv, then start (up to 50 today).
node unfollow.mjs --client-id YOUR_CLIENT_ID --apply

# 3. Next day: same command continues where it stopped.
node unfollow.mjs --client-id YOUR_CLIENT_ID --apply
```

| Option | Meaning |
|---|---|
| `--keep file.txt` | Never unfollow these. One `@handle`, handle or numeric user id per line; `#` comments. |
| `--skip-verified` | Never unfollow verified accounts. |
| `--max-per-day 50` | Unfollows per calendar day (UTC), 1 to 400. |
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
