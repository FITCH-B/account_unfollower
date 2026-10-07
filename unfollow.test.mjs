import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseArgs, readKeepList, planUnfollows, makeClient, scopesFor} from './unfollow.mjs';

const u = (id, username, extra = {}) => ({id, username, name: username, ...extra});

test('plans only accounts that do not follow back, honouring the keep-list and skip-verified', () => {
  const following = [u('1', 'mutual'), u('2', 'friend'), u('3', 'Brand', {verified_type: 'business'}), u('4', 'stranger'), u('5', 'byid')];
  const followers = [u('1', 'mutual'), u('9', 'fan')];
  const keep = {ids: new Set(['5']), handles: new Set(['friend'])};
  const {unfollow, kept} = planUnfollows(following, followers, {keep, skipVerified: true});
  assert.deepEqual(unfollow.map(x => x.username), ['stranger']);
  assert.deepEqual(kept.map(x => [x.username, x.reason]), [['friend', 'keep-list'], ['Brand', 'verified'], ['byid', 'keep-list']]);
  assert.deepEqual(planUnfollows(following, followers).unfollow.map(x => x.id), ['2', '3', '4', '5'], 'no rules: every non-follower');
});

test('keep-list accepts @handles, bare handles and ids, case-insensitive, with comments', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-')), 'keep.txt');
  fs.writeFileSync(f, '# friends\n@Alice\nbob  # partner\n\n12345\n');
  const k = readKeepList(f);
  assert.deepEqual([...k.handles], ['alice', 'bob']);assert.deepEqual([...k.ids], ['12345']);
});

test('options require a client id and cap the daily maximum', () => {
  delete process.env.X_ACCESS_TOKEN;assert.throws(() => parseArgs([]), /client-id/);
  process.env.X_ACCESS_TOKEN = 'console-token';assert.equal(parseArgs([]).clientId, null, 'a console token needs no client id');delete process.env.X_ACCESS_TOKEN;
  assert.throws(() => parseArgs(['--client-id', 'x', '--max-per-day', '1000']), /max-per-day/);
  assert.throws(() => parseArgs(['--client-id', 'x', '--bogus']), /Unknown option/);
  const o = parseArgs(['--client-id', 'abc', '--apply', '--skip-verified', '--max-per-day', '30']);
  assert.equal(o.clientId, 'abc');assert.equal(o.apply, true);assert.equal(o.maxPerDay, 30);assert.equal(o.skipVerified, true);
});

test('lists page through next_token, send only the bearer token to api.x.com, and stop on rate limits', async () => {
  const seen = [];
  const pages = [{data: [u('1', 'a')], meta: {next_token: 'p2'}}, {data: [u('2', 'b')], meta: {}}];
  const x = makeClient('TOKEN', {log: () => {}, fetcher: async (url, init) => {
    seen.push(url);assert.equal(new URL(url).hostname, 'api.x.com');assert.equal(init.headers.Authorization, 'Bearer TOKEN');assert.equal(init.redirect, 'manual');
    return Response.json(pages.shift());
  }});
  assert.deepEqual((await x.list('99', 'following')).map(v => v.id), ['1', '2']);
  assert.equal(new URL(seen[1]).searchParams.get('pagination_token'), 'p2');
  const limited = makeClient('T', {log: () => {}, fetcher: async () => new Response('', {status: 429, headers: {'x-rate-limit-reset': '2000000000'}})});
  await assert.rejects(limited.unfollow('1', '2'), e => e.rateLimited === true);
  const denied = makeClient('T', {log: () => {}, fetcher: async () => new Response('', {status: 403})});
  await assert.rejects(denied.list('1', 'followers'), /HTTP 403/);
  const unpaid = makeClient('T', {log: () => {}, fetcher: async () => new Response('', {status: 402})});
  await assert.rejects(unpaid.list('1', 'following'), /no API credits/);
});

test('a dry run asks X for read access only; write access only with --apply', () => {
  assert.equal(scopesFor(false), 'tweet.read users.read follows.read');
  assert.equal(scopesFor(true), 'tweet.read users.read follows.read follows.write');
});
