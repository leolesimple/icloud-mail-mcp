import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingHttpHeaders } from 'node:http';
import {
  fetchHttpsGuarded,
  forbiddenAddressReason,
  UrlFetchError,
  UrlTooLargeError,
} from '../src/ssrf.js';
import type { PinnedRequest, PinnedResponse, ResolvedAddress } from '../src/ssrf.js';

/**
 * Garde SSRF de la source `url`. Aucun accès réseau : la résolution DNS et la
 * requête HTTPS sont remplacées par des doublures.
 */

const PUBLIC_V4: ResolvedAddress = { address: '93.184.216.34', family: 4 };

async function* chunks(...parts: Buffer[]): AsyncIterable<Buffer> {
  for (const part of parts) yield part;
}

function response(
  status: number,
  headers: IncomingHttpHeaders = {},
  body: AsyncIterable<Buffer> = chunks(),
): PinnedResponse & { closed: boolean } {
  const res = {
    status,
    headers,
    body,
    closed: false,
    close() {
      res.closed = true;
    },
  };
  return res;
}

/** Doublures DNS + HTTPS ; `routes` associe une URL à sa réponse. */
function fakeNetwork(
  dns: Record<string, ResolvedAddress[]>,
  routes: Record<string, () => PinnedResponse>,
) {
  const requests: PinnedRequest[] = [];
  const lookups: string[] = [];
  return {
    requests,
    lookups,
    deps: {
      resolveHost: async (hostname: string) => {
        lookups.push(hostname);
        const entry = dns[hostname];
        if (!entry) throw new Error('ENOTFOUND');
        return entry;
      },
      request: async (req: PinnedRequest) => {
        requests.push(req);
        const route = routes[req.url.href];
        if (!route) throw new Error(`route inattendue ${req.url.href}`);
        return route();
      },
    },
  };
}

function rejectsWith(promise: Promise<unknown>, pattern: RegExp, type = UrlFetchError) {
  return assert.rejects(promise, (err: Error) => {
    assert.ok(err instanceof type, `${err.name} : ${err.message}`);
    assert.match(err.message, pattern);
    return true;
  });
}

describe('forbiddenAddressReason : IPv4', () => {
  const blocked = [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.10',
    '198.18.0.1',
    '224.0.0.251',
    '239.255.255.250',
    '255.255.255.255',
  ];
  for (const address of blocked) {
    it(`refuse ${address}`, () => {
      assert.ok(forbiddenAddressReason(address));
    });
  }

  it('accepte les adresses publiques, y compris en bordure des plages', () => {
    for (const address of ['93.184.216.34', '1.1.1.1', '100.128.0.1', '172.32.0.1', '11.0.0.1']) {
      assert.equal(forbiddenAddressReason(address), undefined, address);
    }
  });

  it('nomme le motif', () => {
    assert.equal(forbiddenAddressReason('100.64.0.1'), 'CGNAT');
    assert.equal(forbiddenAddressReason('169.254.169.254'), 'link-local');
    assert.equal(forbiddenAddressReason('127.0.0.1'), 'loopback');
  });
});

describe('forbiddenAddressReason : IPv6', () => {
  const blocked = [
    '::',
    '::1',
    '0:0:0:0:0:0:0:1',
    'fe80::1',
    'fe80::1%eth0',
    'fd00::1',
    'fc12:3456::1',
    'ff02::1',
    'fec0::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '::127.0.0.1',
    '64:ff9b::10.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::1',
    '2002:7f00:0001::1',
    '2002:c0a8:0101::1',
    '2001:db8::1',
    '2001:0:4136:e378::1',
  ];
  for (const address of blocked) {
    it(`refuse ${address}`, () => {
      assert.ok(forbiddenAddressReason(address));
    });
  }

  it('accepte les adresses publiques, IPv4 mappées publiques comprises', () => {
    for (const address of [
      '2606:4700:4700::1111',
      '2a01:e0a:1::1',
      '::ffff:1.1.1.1',
      '64:ff9b::808:808',
      '2002:0101:0101::1',
    ]) {
      assert.equal(forbiddenAddressReason(address), undefined, address);
    }
  });

  it('refuse ce qui n’est pas une IP', () => {
    assert.ok(forbiddenAddressReason('localhost'));
    assert.ok(forbiddenAddressReason(''));
  });
});

describe('fetchHttpsGuarded : cibles refusées', () => {
  it('refuse http:// et les autres schémas, sans résolution', async () => {
    const net = fakeNetwork({}, {});
    await rejectsWith(fetchHttpsGuarded('http://example.com/a.pdf', 100, net.deps), /https/);
    await rejectsWith(fetchHttpsGuarded('file:///etc/passwd', 100, net.deps), /https/);
    await rejectsWith(fetchHttpsGuarded('pas une url', 100, net.deps), /illisible/);
    assert.equal(net.lookups.length, 0);
    assert.equal(net.requests.length, 0);
  });

  it('refuse les identifiants dans l’URL', async () => {
    const net = fakeNetwork({ 'example.com': [PUBLIC_V4] }, {});
    await rejectsWith(
      fetchHttpsGuarded('https://user:pass@example.com/a', 100, net.deps),
      /identifiants/,
    );
  });

  it('refuse une IP littérale interne, v4 ou v6, sans requête', async () => {
    const net = fakeNetwork({}, {});
    for (const url of [
      'https://127.0.0.1/x',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/x',
      'https://[::ffff:127.0.0.1]/x',
      'https://[fd00::1]/x',
      'https://0x7f000001/x',
      'https://2130706433/x',
    ]) {
      await rejectsWith(fetchHttpsGuarded(url, 100, net.deps), /adresse refusée/);
    }
    assert.equal(net.requests.length, 0);
  });

  it('refuse un nom qui résout vers une adresse interne', async () => {
    const net = fakeNetwork(
      {
        'interne.example': [{ address: '10.0.0.5', family: 4 }],
        'v6.example': [{ address: '::ffff:192.168.0.1', family: 6 }],
      },
      {},
    );
    await rejectsWith(
      fetchHttpsGuarded('https://interne.example/a', 100, net.deps),
      /10\.0\.0\.5 \(réseau privé\)/,
    );
    await rejectsWith(fetchHttpsGuarded('https://v6.example/a', 100, net.deps), /IPv4 mappée/);
    assert.equal(net.requests.length, 0);
  });

  it('refuse si UNE seule des adresses résolues est interne', async () => {
    const net = fakeNetwork(
      { 'mixte.example': [PUBLIC_V4, { address: '127.0.0.1', family: 4 }] },
      {},
    );
    await rejectsWith(fetchHttpsGuarded('https://mixte.example/a', 100, net.deps), /loopback/);
    assert.equal(net.requests.length, 0);
  });

  it('refuse un nom introuvable', async () => {
    const net = fakeNetwork({}, {});
    await rejectsWith(fetchHttpsGuarded('https://absent.example/a', 100, net.deps), /introuvable/);
  });
});

describe('fetchHttpsGuarded : DNS rebinding', () => {
  it('résout une seule fois et se connecte à l’adresse vérifiée', async () => {
    // Un DNS hostile répond d'abord une IP publique, puis 127.0.0.1.
    let calls = 0;
    const requests: PinnedRequest[] = [];
    const result = await fetchHttpsGuarded('https://rebind.example/f.pdf', 100, {
      resolveHost: async () => {
        calls++;
        return calls === 1 ? [PUBLIC_V4] : [{ address: '127.0.0.1', family: 4 }];
      },
      request: async (req) => {
        requests.push(req);
        return response(200, {}, chunks(Buffer.from('pdf')));
      },
    });
    assert.equal(calls, 1);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]?.address, PUBLIC_V4);
    assert.equal(requests[0]?.url.hostname, 'rebind.example');
    assert.equal(result.content.toString(), 'pdf');
  });
});

describe('fetchHttpsGuarded : redirections', () => {
  it('suit jusqu’à 3 redirections, chacune re-vérifiée', async () => {
    const net = fakeNetwork(
      {
        'a.example': [PUBLIC_V4],
        'b.example': [{ address: '2606:4700:4700::1111', family: 6 }],
      },
      {
        'https://a.example/1': () => response(302, { location: '/2' }),
        'https://a.example/2': () => response(301, { location: 'https://b.example/3' }),
        'https://b.example/3': () => response(307, { location: '/facture.pdf' }),
        'https://b.example/facture.pdf': () => response(200, {}, chunks(Buffer.from('ok'))),
      },
    );
    const result = await fetchHttpsGuarded('https://a.example/1', 100, net.deps);
    assert.equal(result.content.toString(), 'ok');
    assert.equal(result.url.href, 'https://b.example/facture.pdf');
    assert.deepEqual(net.lookups, ['a.example', 'a.example', 'b.example', 'b.example']);
  });

  it('refuse une 4ᵉ redirection', async () => {
    const net = fakeNetwork(
      { 'a.example': [PUBLIC_V4] },
      {
        'https://a.example/1': () => response(302, { location: '/2' }),
        'https://a.example/2': () => response(302, { location: '/3' }),
        'https://a.example/3': () => response(302, { location: '/4' }),
        'https://a.example/4': () => response(302, { location: '/5' }),
      },
    );
    await rejectsWith(fetchHttpsGuarded('https://a.example/1', 100, net.deps), /redirections/);
    assert.equal(net.requests.length, 4);
  });

  it('refuse une redirection vers une adresse interne', async () => {
    const net = fakeNetwork(
      { 'a.example': [PUBLIC_V4], 'interne.example': [{ address: '192.168.1.1', family: 4 }] },
      {
        'https://a.example/1': () => response(302, { location: 'https://interne.example/admin' }),
      },
    );
    await rejectsWith(fetchHttpsGuarded('https://a.example/1', 100, net.deps), /192\.168\.1\.1/);
    assert.equal(net.requests.length, 1);
  });

  it('refuse une redirection vers une IP littérale interne ou vers http', async () => {
    const net = fakeNetwork(
      { 'a.example': [PUBLIC_V4] },
      {
        'https://a.example/meta': () =>
          response(302, { location: 'https://169.254.169.254/latest/' }),
        'https://a.example/clair': () => response(302, { location: 'http://a.example/x' }),
      },
    );
    await rejectsWith(fetchHttpsGuarded('https://a.example/meta', 100, net.deps), /link-local/);
    await rejectsWith(fetchHttpsGuarded('https://a.example/clair', 100, net.deps), /https/);
  });
});

describe('fetchHttpsGuarded : taille, statut et délai', () => {
  it('refuse sur Content-Length avant de lire le corps', async () => {
    const res = response(200, { 'content-length': '1000' }, chunks(Buffer.alloc(1000)));
    const net = fakeNetwork({ 'a.example': [PUBLIC_V4] }, { 'https://a.example/x': () => res });
    await rejectsWith(
      fetchHttpsGuarded('https://a.example/x', 999, net.deps),
      /1000 octets annoncés/,
      UrlTooLargeError,
    );
    assert.equal(res.closed, true);
  });

  it('coupe le flux dès le dépassement, sans lire la suite', async () => {
    let pulled = 0;
    async function* endless(): AsyncIterable<Buffer> {
      for (;;) {
        pulled++;
        yield Buffer.alloc(64);
      }
    }
    const res = response(200, {}, endless());
    const net = fakeNetwork({ 'a.example': [PUBLIC_V4] }, { 'https://a.example/x': () => res });
    await rejectsWith(
      fetchHttpsGuarded('https://a.example/x', 200, net.deps),
      /interrompu/,
      UrlTooLargeError,
    );
    assert.equal(pulled, 4);
    assert.equal(res.closed, true);
  });

  it('accepte un contenu exactement à la limite', async () => {
    const net = fakeNetwork(
      { 'a.example': [PUBLIC_V4] },
      {
        'https://a.example/x': () => response(200, {}, chunks(Buffer.alloc(60), Buffer.alloc(40))),
      },
    );
    const result = await fetchHttpsGuarded('https://a.example/x', 100, net.deps);
    assert.equal(result.content.length, 100);
  });

  it('refuse un statut d’erreur', async () => {
    const net = fakeNetwork(
      { 'a.example': [PUBLIC_V4] },
      { 'https://a.example/x': () => response(404) },
    );
    await rejectsWith(fetchHttpsGuarded('https://a.example/x', 100, net.deps), /404/);
  });

  it('abandonne au-delà du délai', async () => {
    let aborted = false;
    await rejectsWith(
      fetchHttpsGuarded('https://a.example/lent', 100, {
        timeoutMs: 20,
        resolveHost: async () => [PUBLIC_V4],
        request: ({ signal }) =>
          new Promise<PinnedResponse>(() => {
            signal.addEventListener('abort', () => {
              aborted = true;
            });
          }),
      }),
      /délai/,
    );
    assert.equal(aborted, true);
  });
});
