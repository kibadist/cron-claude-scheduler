import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractImageUrls, prepareTicketAssets } from '../src/assets.js';
import { makeTicket } from './helpers/fake-linear.js';

const URL_1 = 'https://uploads.linear.app/abc/def/screenshot.png';
const URL_2 = 'https://uploads.linear.app/abc/def/mock.jpg';

let assetsDir: string;

beforeEach(() => {
  assetsDir = join(mkdtempSync(join(tmpdir(), 'sched-assets-')), 'assets');
});

describe('extractImageUrls', () => {
  it('finds Linear-hosted markdown images', () => {
    const md = `Look at ![shot](${URL_1}) and ![mock](${URL_2})`;
    expect(extractImageUrls(md)).toEqual([URL_1, URL_2]);
  });

  it('ignores images on other hosts and plain links', () => {
    const md = [
      '![evil](https://example.com/x.png)',
      `[file](${URL_1})`, // plain link, not an image
      'https://uploads.linear.app/bare-url.png',
    ].join('\n');
    expect(extractImageUrls(md)).toEqual([]);
  });
});

describe('prepareTicketAssets', () => {
  const download = async (url: string): Promise<Buffer | null> =>
    url === URL_1 ? Buffer.from('png-bytes') : null;

  it('downloads images and rewrites description and comments to local paths', async () => {
    const ticket = makeTicket({
      description: `Make it look like ![shot](${URL_1})`,
      comments: [{ author: 'Max', body: `Same as ![shot](${URL_1})` }],
    });

    const prepared = await prepareTicketAssets(ticket, assetsDir, download);

    expect(prepared.imagePaths).toHaveLength(1);
    const file = prepared.imagePaths[0];
    expect(file).toMatch(/image-1\.png$/);
    expect(readFileSync(file, 'utf8')).toBe('png-bytes');
    expect(prepared.ticket.description).toContain(file);
    expect(prepared.ticket.description).not.toContain('uploads.linear.app');
    expect(prepared.ticket.comments[0].body).toContain(file);
    // the original ticket is untouched
    expect(ticket.description).toContain('uploads.linear.app');
  });

  it('leaves the ticket unchanged when a download fails', async () => {
    const ticket = makeTicket({ description: `See ![mock](${URL_2})` });
    const prepared = await prepareTicketAssets(ticket, assetsDir, download);
    expect(prepared.imagePaths).toEqual([]);
    expect(prepared.ticket).toEqual(ticket);
  });

  it('is a no-op for tickets without images', async () => {
    const ticket = makeTicket({ description: 'no pictures here' });
    const prepared = await prepareTicketAssets(ticket, assetsDir, download);
    expect(prepared.ticket).toBe(ticket);
    expect(prepared.imagePaths).toEqual([]);
    expect(existsSync(assetsDir)).toBe(false); // nothing created
  });
});
