import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedClock } from '../../common/time/clock.js';
import { LocalObjectStorage } from './local-object-storage.js';

const secret = Buffer.alloc(32, 9);
const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1);

describe('LocalObjectStorage', () => {
  let directory: string;
  let clock: FixedClock;
  let storage: LocalObjectStorage;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'erp-storage-'));
    clock = new FixedClock('2026-11-08T10:00:00.000Z');
    storage = new LocalObjectStorage(directory, 'http://api.test', secret, clock);
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  const later = (seconds: number) => new Date(clock.now().getTime() + seconds * 1000);

  describe('an upload ticket', () => {
    it('is an address for one object of one type and size, with no extra form fields', async () => {
      const ticket = await storage.createUpload({
        key: 'a/b/3/photo',
        contentType: 'image/png',
        maxBytes: 100,
        expiresAt: later(300),
      });
      expect(ticket.url).toMatch(/^http:\/\/api\.test\/v1\/local-storage\/[\w-]+\.[\w-]+$/);
      expect(ticket.fields).toEqual({});
      expect(ticket.expiresAt).toEqual(later(300));
      expect(storage.verify(tokenOf(ticket.url))).toMatchObject({
        op: 'put',
        key: 'a/b/3/photo',
        contentType: 'image/png',
        maxBytes: 100,
      });
    });

    it('stops working once it has expired', async () => {
      const ticket = await storage.createUpload({
        key: 'k',
        contentType: 'image/png',
        maxBytes: 1,
        expiresAt: later(300),
      });
      clock.set(later(301));
      expect(storage.verify(tokenOf(ticket.url))).toBeNull();
    });

    it('stops working after a restart, because the signing key is made at start', async () => {
      const ticket = await storage.createUpload({
        key: 'k',
        contentType: 'image/png',
        maxBytes: 1,
        expiresAt: later(300),
      });
      const restarted = new LocalObjectStorage(
        directory,
        'http://api.test',
        Buffer.alloc(32, 1),
        clock,
      );
      expect(restarted.verify(tokenOf(ticket.url))).toBeNull();
    });

    it.each(['', 'abc', 'a.b.c', '.', 'e30.AAAA'])('refuses the forged address %j', (token) => {
      expect(storage.verify(token)).toBeNull();
    });

    it('refuses an address whose grant was changed', async () => {
      const ticket = await storage.createUpload({
        key: 'k',
        contentType: 'image/png',
        maxBytes: 1,
        expiresAt: later(300),
      });
      const [payload, signature] = tokenOf(ticket.url).split('.');
      const grant = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as object;
      const forged = Buffer.from(JSON.stringify({ ...grant, key: 'other' })).toString('base64url');
      expect(storage.verify(`${forged}.${signature}`)).toBeNull();
    });
  });

  describe('an object', () => {
    it('is written, read and removed; reading one that is not there is null; removing it twice is fine', async () => {
      await storage.write('s/i/3/one', Buffer.from('bytes'));
      expect((await storage.read('s/i/3/one'))?.toString()).toBe('bytes');
      await storage.remove('s/i/3/one');
      expect(await storage.read('s/i/3/one')).toBeNull();
      await expect(storage.remove('s/i/3/one')).resolves.toBeUndefined();
    });

    it('is never kept outside the storage directory', async () => {
      await expect(storage.write('../escape', Buffer.from('x'))).rejects.toThrow(/outside/);
      await expect(storage.read('../../etc/passwd')).rejects.toThrow(/outside/);
    });
  });

  it('a download link carries the object, its fixed type and the name offered', async () => {
    const link = await storage.createDownload({
      key: 'k',
      contentType: 'application/pdf',
      fileName: 'form.pdf',
      expiresAt: later(300),
    });
    expect(link.expiresAt).toEqual(later(300));
    expect(storage.verify(tokenOf(link.url))).toMatchObject({
      op: 'get',
      key: 'k',
      contentType: 'application/pdf',
      fileName: 'form.pdf',
    });
  });
});
