#!/usr/bin/env node
// account_unfollower: unfollow X accounts that don't follow you back, slowly and with a dry run first.
// Uses YOUR OWN X developer app and YOUR login (OAuth 2.0 with PKCE). No dependencies; Node.js 18+.
// The access token lives in memory for one run only. It is never written to disk or sent anywhere but api.x.com.
//
//   node unfollow.mjs --client-id <id>                 log in, read lists, write the plan (dry run, unfollows nobody)
//   node unfollow.mjs --client-id <id> --apply         unfollow up to today's cap from the saved plan
//   options: --keep keep.txt  --skip-verified  --max-per-day 50  --refresh  --port 8723  --price-per-read 0.01  --yes
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

export function parseArgs(argv) {
  const o = {maxPerDay: 50, port: 8723, pricePerRead: 0.01, keep: null, apply: false, refresh: false, skipVerified: false, yes: false, clientId: null};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--client-id') o.clientId = v();
    else if (a === '--apply') o.apply = true;
    else if (a === '--refresh') o.refresh = true;
    else if (a === '--skip-verified') o.skipVerified = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '--keep') o.keep = v();
    else if (a === '--max-per-day') o.maxPerDay = Number(v());
    else if (a === '--port') o.port = Number(v());
    else if (a === '--price-per-read') o.pricePerRead = Number(v());
    else throw Error('Unknown option ' + a);
  }
  if (!o.clientId && !process.env.X_ACCESS_TOKEN) throw Error('Pass --client-id <your X app OAuth 2.0 client ID>, or set X_ACCESS_TOKEN (see README).');
  if (!Number.isInteger(o.maxPerDay) || o.maxPerDay < 1 || o.maxPerDay > HARD_DAILY_MAX) throw Error(`--max-per-day must be 1 to ${HARD_DAILY_MAX}.`);
  return o;
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

export function makeClient(token, {fetcher = fetch, log = console.log} = {}) {
  async function call(method, url) {
    const r = await fetcher(url, {method, headers: {Authorization: 'Bearer ' + token}, redirect: 'manual', signal: AbortSignal.timeout(20000)});
    if (r.status === 429) {
      const reset = Number(r.headers.get('x-rate-limit-reset')) * 1000;
      throw Object.assign(Error('X rate limit reached' + (reset ? ', resets at ' + new Date(reset).toLocaleTimeString() : '')), {rateLimited: true});
    }
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
async function confirm(question, yes) {
  if (yes) return true;
  const rl = readline.createInterface({input: process.stdin, output: process.stdout});
  const a = (await rl.question(question + ' Type yes to continue: ')).trim().toLowerCase();rl.close();return a === 'yes';
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  // A token generated in the developer console for your own account skips the browser login. It is read from the
  // environment only and never written anywhere.
  const token = process.env.X_ACCESS_TOKEN ? process.env.X_ACCESS_TOKEN.trim() : await login(o);
  const x = makeClient(token);
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

  const used = s.perDay[today()] || 0, budget = Math.min(o.maxPerDay - used, s.todo.length);
  if (budget <= 0) return console.log(s.todo.length ? `Today's cap (${o.maxPerDay}) is used. Run again tomorrow.` : 'Plan complete. Nothing left to unfollow.');
  if (!await confirm(`Unfollow ${budget} account(s) now as @${me.username}, 20-60 s apart?`, o.yes)) return console.log('Stopped.');
  for (let i = 0; i < budget; i++) {
    const u = s.todo[0];
    try {await x.unfollow(me.id, u.id);}
    catch (e) {console.log(`Stopped: ${e.message}. Progress is saved; run again later.`);break;}
    s.todo.shift();s.done.push({...u, at: new Date().toISOString()});s.perDay[today()] = (s.perDay[today()] || 0) + 1;saveState(s);
    console.log(`  unfollowed @${u.username} (${s.done.length} done, ${s.todo.length} left)`);
    if (i < budget - 1) await sleep(20000 + Math.random() * 40000);
  }
  console.log('Done for now. Progress is in ' + STATE_FILE + '.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => {console.error('Error: ' + e.message);process.exitCode = 1;});
}
