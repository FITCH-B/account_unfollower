#!/usr/bin/env node
// account_unfollower: unfollow X accounts that don't follow you back, slowly and with a dry run first.
// Uses YOUR OWN X developer app and YOUR login (OAuth 2.0 with PKCE). No dependencies; Node.js 18+.
// The access token lives in memory for one run only. It is never written to disk or sent anywhere but api.x.com.
//
//   node unfollow.mjs --client-id <id>                 log in, read lists, write the plan (dry run, unfollows nobody)
//   node unfollow.mjs --client-id <id> --apply         unfollow up to today's cap from the saved plan
//   options: --keep keep.txt  --skip-verified  --max-per-day 50 (per run; at most 400 a day in total)  --delay-min 20  --delay-max 60  --refresh  --port 8723
//            --price-per-read 0.01  --yes
//   with --apply and no --max-per-day / --delay-* flags, it asks for both (Enter keeps 50 and 20-60 s).
//   a confidential app also needs X_CLIENT_SECRET in the environment.
//   or skip the browser login: set X_ACCESS_TOKEN to an OAuth 2.0 user token for your own account (the console's
//   "OAuth 2.0 Keys > Access Token > Generate"); then --client-id is not needed.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const API = 'https://api.x.com/2';
// The dry run asks X for read access only; write access is requested only with --apply.
export const scopesFor = apply => 'tweet.read users.read follows.read' + (apply ? ' follows.write' : '');
const STATE_FILE = 'unfollow-state.json';
const HARD_DAILY_MAX = 400;   // X's own limit is 50 unfollows per 15 minutes; bulk churn risks restrictions.
const MIN_DELAY = 5;          // seconds; below ~18 s on average you will hit X's 50-per-15-minutes limit.

export function parseArgs(argv) {
  const o = {maxPerDay: 50, delayMin: 20, delayMax: 60, asked: {count: false, delay: false}, port: 8723, pricePerRead: 0.01, keep: null, apply: false, refresh: false, skipVerified: false, yes: false, clientId: null};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--client-id') o.clientId = v();
    else if (a === '--apply') o.apply = true;
    else if (a === '--refresh') o.refresh = true;
    else if (a === '--skip-verified') o.skipVerified = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '--keep') o.keep = v();
    else if (a === '--max-per-day') {o.maxPerDay = Number(v());o.asked.count = true;}
    else if (a === '--delay-min') {o.delayMin = Number(v());o.asked.delay = true;}
    else if (a === '--delay-max') {o.delayMax = Number(v());o.asked.delay = true;}
    else if (a === '--port') o.port = Number(v());
    else if (a === '--price-per-read') o.pricePerRead = Number(v());
    else throw Error('Unknown option ' + a);
  }
  if (!o.clientId && !process.env.X_ACCESS_TOKEN && !oauth1FromEnv()) throw Error('Pass --client-id <your X app OAuth 2.0 client ID>, or set X_ACCESS_TOKEN (see README).');
  if (!Number.isInteger(o.maxPerDay) || o.maxPerDay < 1 || o.maxPerDay > HARD_DAILY_MAX) throw Error(`--max-per-day must be 1 to ${HARD_DAILY_MAX}.`);
  checkDelays(o.delayMin, o.delayMax);
  return o;
}

export function checkDelays(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < MIN_DELAY || max < min || max > 3600) throw Error(`Delays must satisfy ${MIN_DELAY} <= min <= max <= 3600 seconds.`);
}
// "30" or "15-45" style answers; empty keeps the default.
export function parseCount(answer, def) {
  const a = String(answer || '').trim(); if (!a) return def;
  const n = Number(a); if (!Number.isInteger(n) || n < 1 || n > HARD_DAILY_MAX) throw Error(`Enter a whole number from 1 to ${HARD_DAILY_MAX}.`); return n;
}
export function parseDelay(answer, [dmin, dmax]) {
  const a = String(answer || '').trim(); if (!a) return [dmin, dmax];
  const m = a.match(/^(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?$/); if (!m) throw Error('Enter seconds like 30 or 20-60.');
  const min = Number(m[1]), max = m[2] ? Number(m[2]) : min; checkDelays(min, max); return [min, max];
}
// Keep-list: one @handle or numeric user id per line; # starts a comment.
export function readKeepList(file) {
  if (!file) return {ids: new Set(), handles: new Set()};
  const ids = new Set(), handles = new Set();
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    if (/^\d{1,25}$/.test(line)) ids.add(line); else handles.add(line.replace(/^@/, '').toLowerCase());
  }
  return {ids, handles};
}

// Accounts you follow that don't follow you, minus the keep-list and (optionally) verified accounts.
export function planUnfollows(following, followers, {keep = {ids: new Set(), handles: new Set()}, skipVerified = false} = {}) {
  const back = new Set(followers.map(u => u.id));
  const out = [], kept = [];
  for (const u of following) {
    if (back.has(u.id)) continue;
    const reason = keep.ids.has(u.id) || keep.handles.has(String(u.username).toLowerCase()) ? 'keep-list'
      : skipVerified && (u.verified || (u.verified_type && u.verified_type !== 'none')) ? 'verified' : null;
    (reason ? kept : out).push({id: u.id, username: u.username, name: u.name, ...(reason ? {reason} : {})});
  }
  return {unfollow: out, kept};
}

// OAuth 1.0a user context (HMAC-SHA1, RFC 5849): the developer console's Consumer Keys plus the account's Access
// Token and Secret. X accepts it for unfollowing, and the console shows these keys "Read and write".
const pct = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export function oauth1Header(method, url, k, {nonce = crypto.randomBytes(16).toString('hex'), timestamp = Math.floor(Date.now() / 1000)} = {}) {
  const u = new URL(url), params = {oauth_consumer_key: k.consumerKey, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: String(timestamp), oauth_token: k.token, oauth_version: '1.0'};
  const all = [...Object.entries(params), ...u.searchParams.entries()].map(([a, b]) => [pct(a), pct(b)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1);
  const base = [method.toUpperCase(), pct(u.origin + u.pathname), pct(all.map(([a, b]) => a + '=' + b).join('&'))].join('&');
  const sig = crypto.createHmac('sha1', pct(k.consumerSecret) + '&' + pct(k.tokenSecret)).update(base).digest('base64');
  return 'OAuth ' + Object.entries({...params, oauth_signature: sig}).map(([a, b]) => pct(a) + '="' + pct(b) + '"').join(', ');
}
export function oauth1FromEnv(env = process.env) {
  const k = {consumerKey: env.X_CONSUMER_KEY, consumerSecret: env.X_CONSUMER_SECRET, token: env.X_OAUTH1_TOKEN, tokenSecret: env.X_OAUTH1_TOKEN_SECRET};
  const set = Object.values(k).filter(Boolean).length;
  if (set && set < 4) throw Error('OAuth 1.0a needs all four: X_CONSUMER_KEY, X_CONSUMER_SECRET, X_OAUTH1_TOKEN, X_OAUTH1_TOKEN_SECRET.');
  return set ? k : null;
}
export function makeClient(token, {fetcher = fetch, log = console.log, oauth1 = null} = {}) {
  async function call(method, url) {
    const auth = oauth1 ? oauth1Header(method, url, oauth1) : 'Bearer ' + token;
    const r = await fetcher(url, {method, headers: {Authorization: auth}, redirect: 'manual', signal: AbortSignal.timeout(20000)});
    if (r.status === 429) {
      const reset = Number(r.headers.get('x-rate-limit-reset')) * 1000;
      throw Object.assign(Error('X rate limit reached' + (reset ? ', resets at ' + new Date(reset).toLocaleTimeString() : '')), {rateLimited: true});
    }
    if (r.status === 402) throw Error('X answered 402 Payment Required: this developer account has no API credits. Add credits in the X developer console (Billing), then run again. Nothing was charged.');
    if (r.status === 403 && method === 'DELETE') throw Error('X answered 403 to the unfollow: this login lacks unfollow permission (follows.write). Use the OAuth 1.0a keys (see README) or a browser login with --client-id, with the app set to Read and write.');
    if (r.status === 401) throw Error('X answered 401: the token is invalid or expired. Log in again (console tokens last about two hours).');
    if (!r.ok) throw Error(`X answered HTTP ${r.status} for ${method} ${new URL(url).pathname}`);
    return method === 'DELETE' ? r.json().catch(() => ({})) : r.json();
  }
  return {
    me: () => call('GET', `${API}/users/me?user.fields=public_metrics,verified,verified_type`).then(b => b.data),
    async list(userId, kind) {
      const users = [];let next = '';
      do {
        const u = new URL(`${API}/users/${userId}/${kind}`);
        u.searchParams.set('max_results', '1000');u.searchParams.set('user.fields', 'verified,verified_type');
        if (next) u.searchParams.set('pagination_token', next);
        const b = await call('GET', u.href);
        users.push(...(b.data || []));next = b.meta?.next_token || '';
        log(`  ${kind}: ${users.length} read`);
      } while (next);
      return users;
    },
    unfollow: (me, target) => call('DELETE', `${API}/users/${me}/following/${target}`),
  };
}

// --- login: OAuth 2.0 authorization code with PKCE, local callback --------------------------------------------
function b64url(buf) {return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');}
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {spawn(cmd[0], cmd[1], {stdio: 'ignore', detached: true}).unref();} catch {}
}
async function login({clientId, port, apply}) {
  const verifier = b64url(crypto.randomBytes(32)), state = b64url(crypto.randomBytes(16));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const redirect = `http://127.0.0.1:${port}/callback`;
  const auth = new URL('https://x.com/i/oauth2/authorize');
  for (const [k, v] of Object.entries({response_type: 'code', client_id: clientId, redirect_uri: redirect, scope: scopesFor(apply), state, code_challenge: challenge, code_challenge_method: 'S256'})) auth.searchParams.set(k, v);
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, redirect);
      if (u.pathname !== '/callback') {res.writeHead(404).end();return;}
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      const why = u.searchParams.get('error');
      res.writeHead(ok ? 200 : 400, {'Content-Type': 'text/plain'}).end(ok ? 'Logged in. You can close this tab and return to the terminal.' : 'Login failed or was cancelled.');
      server.close();ok ? resolve(u.searchParams.get('code')) : reject(Error('Login failed or was cancelled' + (why ? ' (' + why + ')' : '') + '. See "If login fails" in the README.'));
    }).listen(port, '127.0.0.1');
    console.log('\nOpening X to log in. If no browser opens, visit:\n' + auth.href + '\n');
    openBrowser(auth.href);
  });
  const headers = {'Content-Type': 'application/x-www-form-urlencoded'};
  if (process.env.X_CLIENT_SECRET) headers.Authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(process.env.X_CLIENT_SECRET)}`).toString('base64');
  const r = await fetch('https://api.x.com/2/oauth2/token', {method: 'POST', headers, body: new URLSearchParams({grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, client_id: clientId})});
  const b = await r.json().catch(() => ({}));
  if (!r.ok || !b.access_token) throw Error('Token exchange failed (HTTP ' + r.status + '). Check the client ID, callback URL and app permissions in the README.');
  return b.access_token;
}

// --- state: plan + progress, never the token --------------------------------------------------------------------
const today = () => new Date().toISOString().slice(0, 10);
const loadState = () => {try {return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));} catch {return null;}};
const saveState = s => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n');
const csv = rows => 'id,username,name\n' + rows.map(r => [r.id, r.username, JSON.stringify(r.name || '')].join(',')).join('\n') + '\n';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ask(question) {
  const rl = readline.createInterface({input: process.stdin, output: process.stdout});
  try {return await rl.question(question);} finally {rl.close();}
}
async function confirm(question, yes) {
  if (yes) return true;
  const rl = readline.createInterface({input: process.stdin, output: process.stdout});
  const a = (await rl.question(question + ' Type yes to continue: ')).trim().toLowerCase();rl.close();return a === 'yes';
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  // A token generated in the developer console for your own account skips the browser login. It is read from the
  // environment only and never written anywhere.
  const oauth1 = oauth1FromEnv();
  const token = oauth1 ? null : process.env.X_ACCESS_TOKEN ? process.env.X_ACCESS_TOKEN.trim() : await login(o);
  const x = makeClient(token, {oauth1});
  const me = await x.me();
  console.log(`Logged in as @${me.username}: following ${me.public_metrics.following_count}, followers ${me.public_metrics.followers_count}.`);
  let s = loadState();
  if (s && s.userId !== me.id) throw Error(`${STATE_FILE} belongs to another account (@${s.username}). Move it away first.`);

  let fresh = false;
  if (!s || o.refresh || !o.apply) {
    const reads = me.public_metrics.following_count + me.public_metrics.followers_count;
    console.log(`\nBuilding the plan reads about ${reads} accounts. At ~$${o.pricePerRead}/account (check your X plan's current price), that is about $${(reads * o.pricePerRead).toFixed(2)}.`);
    if (!s || o.refresh) {
      if (!await confirm('Read both lists now?', o.yes)) return console.log('Stopped. Nothing was read.');
      const following = await x.list(me.id, 'following'), followers = await x.list(me.id, 'followers');
      const plan = planUnfollows(following, followers, {keep: readKeepList(o.keep), skipVerified: o.skipVerified});
      s = {userId: me.id, username: me.username, builtAt: new Date().toISOString(), todo: plan.unfollow, kept: plan.kept, done: [], perDay: {}};
      saveState(s);fs.writeFileSync('unfollow-plan.csv', csv(plan.unfollow));fresh = true;
    }
    console.log(`\nPlan (${s.builtAt}): ${s.todo.length} to unfollow, ${s.done.length} already done, ${s.kept.length} kept by your rules.`);
    console.log('Review unfollow-plan.csv. Nothing was unfollowed. Run again with --apply to start.');
    // A freshly built plan is always reviewed first, even with --apply.
    if (!o.apply || fresh) return;
  }

  // Ask for today's amount and the spacing unless they came as flags (or --yes keeps the defaults).
  const used = s.perDay[today()] || 0;
  if (!o.yes && !o.asked.count) for (;;) {try {o.maxPerDay = parseCount(await ask(`How many to unfollow now? (${s.todo.length} left in the plan, ${used} already done today) [${o.maxPerDay}]: `), o.maxPerDay);break;} catch (e) {console.log(e.message);}}
  if (!o.yes && !o.asked.delay) for (;;) {try {[o.delayMin, o.delayMax] = parseDelay(await ask(`Seconds between unfollows, as N or MIN-MAX [${o.delayMin}-${o.delayMax}]: `), [o.delayMin, o.delayMax]);break;} catch (e) {console.log(e.message);}}
  if ((o.delayMin + o.delayMax) / 2 < 18) console.log("Note: averaging under 18 s between unfollows will hit X's limit of 50 per 15 minutes; the run stops there and saves progress.");
  // The answer (or --max-per-day) is how many to do in this run; HARD_DAILY_MAX still bounds the day's total.
  const budget = Math.min(o.maxPerDay, s.todo.length, HARD_DAILY_MAX - used);
  if (!s.todo.length) return console.log('Plan complete. Nothing left to unfollow.');
  if (budget <= 0) return console.log(`${used} unfollowed today, the daily maximum of ${HARD_DAILY_MAX}. Run again tomorrow.`);
  const span = o.delayMin === o.delayMax ? `${o.delayMin} s` : `${o.delayMin}-${o.delayMax} s`;
  if (!await confirm(`Unfollow ${budget} account(s) now as @${me.username}, ${span} apart?`, o.yes)) return console.log('Stopped.');
  for (let i = 0; i < budget; i++) {
    const u = s.todo[0];
    try {await x.unfollow(me.id, u.id);}
    catch (e) {console.log(`Stopped: ${e.message}. Progress is saved; run again later.`);break;}
    s.todo.shift();s.done.push({...u, at: new Date().toISOString()});s.perDay[today()] = (s.perDay[today()] || 0) + 1;saveState(s);
    console.log(`  unfollowed @${u.username} (${s.done.length} done, ${s.todo.length} left)`);
    if (i < budget - 1) await sleep(1000 * (o.delayMin + Math.random() * (o.delayMax - o.delayMin)));
  }
  console.log('Done for now. Progress is in ' + STATE_FILE + '.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => {console.error('Error: ' + e.message);process.exitCode = 1;});
}
