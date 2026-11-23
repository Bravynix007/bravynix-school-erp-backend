import { Logger } from '@nestjs/common';
import { decodeJwt } from 'jose';
import { FixedClock } from '../../common/time/clock.js';
import { demoServiceAccount, placeholderPem } from '../../../test/support/firebase-key.js';
import { FirebasePushSender, type FirebaseTransport } from './firebase-push-sender.js';
import type { PushMessage } from './push-sender.js';

const credentials = demoServiceAccount({ token_uri: 'https://auth.example.test/token' });

const message = (token: string): PushMessage => ({
  token,
  platform: 1,
  language: 'en',
  title: 'Absent today',
  body: 'Asha was marked absent today.',
});

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const FCM = 'https://fcm.googleapis.com/v1/projects/demo-project/messages:send';

/** Google, answering for the sign-in and for each push in turn. */
const build = (pushes: (() => Response | Promise<Response>)[] = []) => {
  const clock = new FixedClock();
  const calls: { url: string; init: RequestInit }[] = [];
  const queue = [...pushes];
  const sleeps: number[] = [];
  let signIns = 0;
  const transport: FirebaseTransport = {
    fetch: vi.fn<typeof fetch>((input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url === credentials.token_uri) {
        signIns += 1;
        return Promise.resolve(json(200, { access_token: `access-${signIns}`, expires_in: 3600 }));
      }
      const next = queue.shift();
      return Promise.resolve(next ? next() : json(200, { name: 'ok' }));
    }),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
  const sender = new FirebasePushSender(credentials, clock, transport);
  const pushed = () => calls.filter((call) => call.url === FCM);
  return { sender, clock, calls, pushed, sleeps, signIns: () => signIns };
};

describe('FirebasePushSender', () => {
  it('signs in as the service account with the messaging scope', async () => {
    const { sender, calls } = build();
    await sender.send([message('t1')]);
    const exchange = calls[0]!;
    const form = exchange.init.body as URLSearchParams;
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const claims = decodeJwt(form.get('assertion')!);
    expect(claims).toMatchObject({
      iss: credentials.client_email,
      sub: credentials.client_email,
      aud: credentials.token_uri,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
    });
    expect(claims.exp! - claims.iat!).toBe(3600);
  });

  it('sends the inbox text and the screen to open, and nothing else of the notice', async () => {
    const { sender, pushed } = build();
    const outcomes = await sender.send([message('t1')]);
    expect(outcomes).toEqual(['sent']);
    const call = pushed()[0]!;
    expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer access-1');
    // A send that gets no answer is given up (SDD 18: outbound calls have timeouts).
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(call.init.body as string)).toEqual({
      message: {
        token: 't1',
        notification: { title: 'Absent today', body: 'Asha was marked absent today.' },
        data: { screen: 'inbox' },
        android: { priority: 'HIGH', notification: { channel_id: 'alerts' } },
        apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
      },
    });
  });

  it('answers one outcome per message, in order, for a batch larger than one slice', async () => {
    const { sender, pushed } = build();
    const messages = Array.from({ length: 45 }, (_x, i) => message(`t${i}`));
    const outcomes = await sender.send(messages);
    expect(outcomes).toHaveLength(45);
    expect(outcomes.every((outcome) => outcome === 'sent')).toBe(true);
    expect(pushed()).toHaveLength(45);
  });

  it('keeps the access token until a minute before it ends, then signs in again', async () => {
    const { sender, clock, signIns } = build();
    await sender.send([message('t1')]);
    clock.advance(3_500_000);
    await sender.send([message('t2')]);
    expect(signIns()).toBe(1);
    clock.advance(50_000);
    await sender.send([message('t3')]);
    expect(signIns()).toBe(2);
  });

  it('marks a token FCM says is unregistered, another project’s, or named in a field violation, as invalid', async () => {
    const { sender } = build([
      () => json(404, { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }),
      () =>
        json(400, {
          error: {
            status: 'INVALID_ARGUMENT',
            details: [{ fieldViolations: [{ field: 'message.token' }] }],
          },
        }),
      () =>
        json(403, {
          error: { status: 'PERMISSION_DENIED', details: [{ errorCode: 'SENDER_ID_MISMATCH' }] },
        }),
    ]);
    expect(await sender.send([message('a'), message('b'), message('c')])).toEqual([
      'invalid_token',
      'invalid_token',
      'invalid_token',
    ]);
  });

  it('keeps every token when a 404 names none of them, as a wrong project would answer', async () => {
    const { sender } = build([
      () => json(404),
      () => json(404, { error: { status: 'NOT_FOUND' } }),
    ]);
    expect(await sender.send([message('a'), message('b')])).toEqual(['failed', 'failed']);
  });

  it('leaves the token alone when the refusal is about something else', async () => {
    const { sender, sleeps } = build([
      () =>
        json(400, {
          error: {
            status: 'INVALID_ARGUMENT',
            details: [{ fieldViolations: [{ field: 'message.data' }] }],
          },
        }),
      () => json(403, { error: { status: 'PERMISSION_DENIED' } }),
      () => new Response('not json', { status: 400 }),
    ]);
    expect(await sender.send([message('a'), message('b'), message('c')])).toEqual([
      'failed',
      'failed',
      'failed',
    ]);
    expect(sleeps).toEqual([]);
  });

  it('tries again with a growing pause on 429, 5xx and a lost connection, then gives up', async () => {
    const { sender, pushed, sleeps } = build([() => json(429), () => json(503), () => json(200)]);
    expect(await sender.send([message('a')])).toEqual(['sent']);
    expect(pushed()).toHaveLength(3);
    expect(sleeps).toEqual([250, 500]);

    const lost = build(
      Array.from({ length: 5 }, () => () => Promise.reject(new Error('socket hang up'))),
    );
    expect(await lost.sender.send([message('a')])).toEqual(['failed']);
    expect(lost.pushed()).toHaveLength(5);
    expect(lost.sleeps).toEqual([250, 500, 1000, 2000]);
  });

  it('logs only counts, never a token or the text of a push', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { sender } = build([() => json(403)]);
    await sender.send([message('secret-device-token')]);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('failed');
    expect(logged).not.toContain('secret-device-token');
    expect(logged).not.toContain('Asha');
    warn.mockRestore();
  });

  it('reads the private key at the start, and refuses one that cannot be used', async () => {
    const { sender } = build();
    await expect(sender.checkKey()).resolves.toBeUndefined();
    const broken = new FirebasePushSender(
      {
        ...credentials,
        private_key: placeholderPem('not a key'),
      },
      new FixedClock(),
    );
    await expect(broken.checkKey()).rejects.toThrow(/PKCS8|key/i);
  });

  it('throws when Google refuses the sign-in, so the worker goes on without the push', async () => {
    const transport: FirebaseTransport = {
      fetch: () => Promise.resolve(json(401, { error: 'invalid_grant' })),
      sleep: () => Promise.resolve(),
    };
    const sender = new FirebasePushSender(credentials, new FixedClock(), transport);
    await expect(sender.send([message('a')])).rejects.toThrow('refused the Firebase sign-in (401)');
  });

  it('throws when Google answers the sign-in without an access token', async () => {
    const transport: FirebaseTransport = {
      fetch: () => Promise.resolve(json(200, {})),
      sleep: () => Promise.resolve(),
    };
    const sender = new FirebasePushSender(credentials, new FixedClock(), transport);
    await expect(sender.send([message('a')])).rejects.toThrow('no Firebase access token');
  });
});
