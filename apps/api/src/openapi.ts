/**
 * OpenAPI 3.1 description of this API. Served at /openapi.json and rendered
 * at / by Stoplight Elements.
 *
 * Kept by hand, next to the code it describes. test/worker.smoke.js asserts
 * every documented path answers (no 404s) and every route is documented, so
 * the two cannot silently drift.
 */

const quality = {
  type: 'string',
  enum: ['live', 'scheduled', 'unknown', 'stale', 'ended'],
  description:
    'How reliable the answer is, best to worst. `live`: a real ETA for a tracked bus. ' +
    '`scheduled`: the feed responded but listed no bus, so the time is an estimate from the usual gap between buses. ' +
    '`unknown`: the feed could not be reached, so no time is given. ' +
    '`stale`: the last cached live answer, returned because the feed is down; `asOf` is when it was originally fetched. ' +
    '`ended`: the service is outside its operating hours.',
};

const coordParams = [
  {
    name: 'lat',
    in: 'query',
    description: 'Latitude of the caller. Ignored unless `lon` is also sent.',
    schema: { type: 'number', minimum: -90, maximum: 90 },
    example: 1.294962,
  },
  {
    name: 'lon',
    in: 'query',
    description: 'Longitude of the caller. Ignored unless `lat` is also sent.',
    schema: { type: 'number', minimum: -180, maximum: 180 },
    example: 103.784556,
  },
];

const errorResponse = (description: string, example?: Record<string, unknown>) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, ...(example ? { example } : {}) } },
});

const ok = (schema: Record<string, unknown>) => ({
  description: 'OK',
  content: { 'application/json': { schema } },
});

const jsonBody = (schema: Record<string, unknown>, example?: Record<string, unknown>) => ({
  required: true,
  content: { 'application/json': { schema, ...(example ? { example } : {}) } },
});

const answerExample = {
  label: 'D2 · 4 min',
  detail: 'KR MRT · cross the road · UTown ~12 min · quiet · or A2 9 min',
  alt: 'A2 · 9 min · KR MRT',
  stop: { code: 'KR-MRT', name: 'KR MRT', confidence: 0.97 },
  quality: 'live',
  asOf: '2026-09-28T01:14:02.000Z',
  arrivals: [
    { svc: 'D2', etaS: 240, crowd: 'low', plate: 'PD726D', berth: 'KR-MRT' },
    { svc: 'D2', etaS: 660, crowd: 'medium', plate: 'PD964H', berth: 'KR-MRT' },
    { svc: 'A2', etaS: 540, crowd: null, plate: 'PD629B', berth: 'KR-MRT' },
  ],
};

export function openApiSpec(origin: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'terminus API',
      version: '1.0.0',
      description: [
        'Arrival times for the NUS internal shuttle buses, returned as short text ready to display.',
        '',
        '`/next` and `/trip` return a `label` (for example `D2 · 4 min`) and a one-line `detail`. Clients ' +
          'show these as they are instead of formatting times themselves, so every client shows the same text.',
        '',
        'NUS stops come in pairs on opposite sides of the road, often a few metres apart (`KR-MRT` and ' +
          '`KR-MRT-OPP`), which is within GPS error. The API picks the side using the route order rather ' +
          'than distance: it checks which stop has a bus that goes on to your destination, and tells you ' +
          'when you need to cross the road.',
        '',
        'Every answer has a `quality` field. When the upstream feed is down, the API returns the last cached ' +
          'answer with its original `asOf` time, or says that live times are unavailable. It does not make up a time.',
        '',
        'The answers need an API key: sign in at /account, create one under API keys, and send it in the ' +
          '`x-api-key` header (or as a bearer token). A signed-in session or a paired device works too. Each key ' +
          'is limited to 60 requests a minute. Arrivals are cached for 15 seconds per stop, so repeated requests ' +
          'for the same stop do not reach the NUS feed. Please do not poll many stops in bulk.',
      ].join('\n'),
    },
    servers: [{ url: origin }],
    // An API key, or a signed-in session or device. /health and /openapi.json opt out.
    security: [{ apiKey: [] }, { bearer: [] }, { cookie: [] }],
    tags: [
      { name: 'Answers', description: 'Next-bus answers as ready-to-display text.' },
      { name: 'Stops', description: 'Per-stop arrivals and static campus data.' },
      { name: 'Timetable', description: 'Turn a NUSMods timetable into a personal link.' },
      { name: 'Service', description: 'Health and configuration.' },
      { name: 'Account', description: 'Invite-only. Sign in on the account page, or pair a device with a code from it.' },
    ],
    paths: {
      '/next': {
        get: {
          tags: ['Answers'],
          summary: 'Next bus',
          description:
            'Returns the next bus. The destination depends on which parameters you send:\n\n' +
            '- `tt`: your next class from an imported timetable (see `/import`). Coordinates pick the boarding stop; without them, the timetable\'s home stop is used.\n' +
            '- `to`: a stop code or NUSMods venue code.\n' +
            '- `lat` and `lon` only: the next buses at your nearest stop, without a destination.\n' +
            '- none of these: a "Set up" answer that tells the client what to send, instead of guessing a destination.',
          operationId: 'getNext',
          parameters: [
            ...coordParams,
            {
              name: 'to',
              in: 'query',
              description: 'A stop code such as `UTOWN`, or a NUSMods venue code such as `COM1-0212`.',
              schema: { type: 'string' },
              example: 'UTOWN',
            },
            {
              name: 'tt',
              in: 'query',
              description: 'Deprecated: an encoded timetable from `/import`, from before accounts. Use `/me/next` with a signed-in device instead.',
              deprecated: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'The answer. Always 200, even when the upstream feed is down; check `quality` to see how reliable it is.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Answer' },
                  examples: {
                    live: { summary: 'A live bus', value: answerExample },
                    walk: {
                      summary: 'Walking wins',
                      value: {
                        ...answerExample,
                        label: 'Walk · 9 min',
                        detail: 'On foot to UTown · D2 would be 15 min · from KR MRT',
                        alt: 'D2 · 4 min · KR MRT',
                      },
                    },
                    setup: {
                      summary: 'Nothing to go on',
                      value: {
                        label: 'Set up',
                        detail: 'Send lat/lon for nearby buses, or a timetable (?tt=) from /import',
                        alt: null,
                        stop: { code: '', name: '', confidence: 0 },
                        quality: 'unknown',
                        asOf: '2026-09-28T01:14:02.000Z',
                        arrivals: [],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/trip': {
        get: {
          tags: ['Answers'],
          summary: 'Answer for a destination',
          description:
            'The same answer as `/next`, for an explicit destination. Send your location, or `from` to start at a stop.',
          operationId: 'getTrip',
          parameters: [
            {
              name: 'to',
              in: 'query',
              required: true,
              description: 'A stop code such as `UTOWN`, or a NUSMods venue code such as `COM1-0212`.',
              schema: { type: 'string' },
              example: 'UTOWN',
            },
            {
              name: 'from',
              in: 'query',
              description: 'Stop code to start from. Required when no `lat`/`lon` is sent.',
              schema: { type: 'string' },
              example: 'PGP',
            },
            ...coordParams,
          ],
          responses: {
            '200': {
              description: 'The answer.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Answer' }, example: answerExample } },
            },
            '400': errorResponse('Unknown destination, or neither a location nor `from` was sent.', {
              error: 'unknown destination: pass ?to= a stop or venue code',
            }),
          },
        },
      },
      '/arrivals': {
        get: {
          tags: ['Stops'],
          summary: 'Arrivals at one stop',
          description:
            'Lists the next arrivals for every service at one stop. There is no destination, so walking time and route direction are not considered. Uses the same 15-second per-stop cache as `/next` and `/trip`.',
          operationId: 'getArrivals',
          parameters: [
            {
              name: 'stop',
              in: 'query',
              required: true,
              description: 'Stop code, case-insensitive.',
              schema: { type: 'string' },
              example: 'COM3',
            },
          ],
          responses: {
            '200': {
              description: 'The stop\'s board.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/StopBoard' },
                  example: {
                    stop: { code: 'COM3', name: 'COM 3' },
                    board: [
                      { svc: 'D1', etaS: 180, quality: 'live', ambiguousBerth: false },
                      { svc: 'D2', etaS: 420, quality: 'live', ambiguousBerth: false },
                    ],
                    asOf: '2026-09-28T01:14:02.000Z',
                    available: true,
                  },
                },
              },
            },
            '400': errorResponse('Unknown stop code.', { error: 'unknown stop', stop: 'NARNIA' }),
          },
        },
      },
      '/campus': {
        get: {
          tags: ['Stops'],
          summary: 'Campus map and destinations',
          description:
            'Returns stop positions and route shapes as SVG coordinates, plus a destination search list: every stop, named buildings and NUSMods rooms, each mapped to the stop an import would use. The data only changes when the API is redeployed, and responses are cached for an hour.',
          operationId: 'getCampus',
          responses: {
            '200': {
              description: 'Map geometry and destinations.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Campus' },
                  example: {
                    viewBox: '0 0 1000 871',
                    stops: [{ code: 'AS5', name: 'AS 5', longName: 'AS 5', opposite: null, x: 177.7, y: 657.9, core: true }],
                    routes: {
                      A1: { seq: ['KRB', 'LT13', 'AS5', 'BIZ2', 'TCOMS-OPP', 'PGP', 'KR-MRT'], loop: true, color: '#4f8fe8' },
                    },
                    destinations: [
                      { code: 'AS5', label: 'AS 5', stopCode: 'AS5', kind: 'stop' },
                      { code: 'COM1', label: 'School of Computing (COM1)', stopCode: 'COM3', kind: 'building' },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      '/stops/pairs': {
        get: {
          tags: ['Stops'],
          summary: 'Stops by side of the road',
          description:
            'Every stop grouped with its twin across the road, with the buses that call at each side and the stop each one goes to next. ' +
            'NUS stops come in pairs a few metres apart, one for each direction of travel, so this is how to tell which side goes where. ' +
            'A stop with no twin is a place with one side.\n\n' +
            '`crossingM` is the straight-line distance between the two stops, not a walking distance. ' +
            '`next` is null where the bus terminates. For whole routes in order, see `/campus`.\n\n' +
            'The data only changes when the stop graph is re-scraped; `version` says when that was, and stop codes can change between versions. ' +
            'Responses are cached for an hour. Credit the source as given in `attribution`.',
          operationId: 'getStopPairs',
          responses: {
            '200': {
              description: 'Places, each with one or two sides.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/StopPairs' },
                  example: {
                    version: '2026-09-28T13:26:23.237956+00:00',
                    attribution: "Stop names, positions and routes from NUS's internal shuttle feed, via terminus (https://terminus.rcn.sh). Unofficial, not affiliated with NUS.",
                    places: [
                      {
                        id: 'KR-MRT',
                        name: 'Kent Ridge MRT',
                        crossingM: 22,
                        sides: [
                          {
                            code: 'KR-MRT', name: 'KR MRT', longName: 'Kent Ridge MRT', lat: 1.29482, lon: 103.784413,
                            services: [{ svc: 'A1', next: 'LT27' }, { svc: 'D2', next: 'LT27' }, { svc: 'K', next: 'LT27' }, { svc: 'P', next: 'UHC-OPP' }],
                          },
                          {
                            code: 'KR-MRT-OPP', name: 'Opp KR MRT', longName: 'Opp Kent Ridge MRT', lat: 1.294962, lon: 103.784556,
                            services: [{ svc: 'A2', next: 'PGPR' }, { svc: 'D2', next: 'PGPR' }, { svc: 'K', next: 'PGPR' }],
                          },
                        ],
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      '/import': {
        get: {
          deprecated: true,
          tags: ['Timetable'],
          summary: 'Import a NUSMods timetable',
          description:
            'Turns a NUSMods share URL into a personal `/next?tt=` link. Each class\'s destination is the stop nearest its venue. ' +
            'The whole timetable is encoded in the link itself; the server stores nothing.',
          operationId: 'importTimetable',
          parameters: [
            {
              name: 'share',
              in: 'query',
              required: true,
              description: 'A NUSMods share URL (Timetable → Share/Sync → copy link).',
              schema: { type: 'string', format: 'uri' },
              example: 'https://nusmods.com/timetable/sem-1/share?MA1100=LEC:1',
            },
            {
              name: 'home',
              in: 'query',
              description: 'Your home stop code, used as the origin when no coordinates are sent.',
              schema: { type: 'string' },
              example: 'PGP',
            },
          ],
          responses: {
            '200': {
              description: 'Your personal link and the schedule it encodes.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ImportResult' },
                  example: {
                    url: `${origin}/next?tt=WyJQR1AiLFtbMSw0ODAsIlVIQUxMIiwiTUExMTAwIEAgTFQyMSJdXV0`,
                    path: '/next?tt=WyJQR1AiLFtbMSw0ODAsIlVIQUxMIiwiTUExMTAwIEAgTFQyMSJdXV0',
                    home: 'PGP',
                    classes: 2,
                    schedule: [
                      { day: 1, at: 480, to: 'UHALL', label: 'MA1100 @ LT21' },
                      { day: 4, at: 480, to: 'UHALL', label: 'MA1100 @ LT21' },
                    ],
                    unresolved: [],
                  },
                },
              },
            },
            '400': errorResponse('Missing or invalid share URL, or unknown home stop.', {
              error: 'not a valid NUSMods share URL',
            }),
            '422': errorResponse('No class in the timetable could be matched to a stop.', {
              error: 'could not resolve any classes to a stop',
            }),
          },
        },
      },
      '/health': {
        get: {
          tags: ['Service'],
          summary: 'Health',
          security: [],
          description:
            'Returns stop graph details and which settings are configured (whether each is set, never its value). With `probe=1` and the operator token in the `x-health-token` header it also checks that the upstream auth token works. Answers 503 when the NUS feed is confirmed down, the monitor has stopped running, or the calendar data has run out.',
          operationId: 'getHealth',
          parameters: [
            {
              name: 'probe',
              in: 'query',
              description: 'Send `1` to check the upstream auth token (uses the cached token when there is one).',
              schema: { type: 'string', enum: ['1'] },
            },
          ],
          responses: {
            '200': {
              description: 'Service status.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Health' },
                  example: {
                    ok: true,
                    now: '2026-09-28T01:14:02.000Z',
                    sgt: '09:14 day1',
                    graph: { generated: '2026-09-28T13:27:41Z', source: 'uNivUS bus proxy via scripts/scrape_stops.py', stops: 33, services: ['A1', 'A2', 'D1', 'D2', 'K', 'P', 'R1', 'R2'] },
                    config: { auth: true, proxy: true, analytics: true },
                  },
                },
              },
            },
          },
        },
      },
      '/auth/login': {
        post: {
          tags: ['Account'],
          summary: 'Email a sign-in code and link',
          description:
            'Emails a 6-character sign-in code and a sign-in link to the address. The reply is the same whether or not the address is blocked or has an account. ' +
            'One email per address per minute. Either the code (`/auth/code`) or the link signs in, once, within 15 minutes.',
          operationId: 'login',
          requestBody: jsonBody({ type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } }, { email: 'you@u.nus.edu' }),
          responses: {
            '200': ok({ type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } } }),
            '400': errorResponse('Not an email address.'),
            '429': errorResponse('Too many attempts from this IP.'),
          },
        },
      },
      '/auth/code': {
        post: {
          tags: ['Account'],
          summary: 'Sign in with an emailed code',
          description:
            'Spends the code from the `/auth/login` email and sets the web session cookie. A code dies after 5 wrong guesses; the link in the same email still works.',
          operationId: 'signInCode',
          requestBody: jsonBody(
            { type: 'object', required: ['email', 'code'], properties: { email: { type: 'string', format: 'email' }, code: { type: 'string' } } },
            { email: 'you@u.nus.edu', code: 'K7QX4M' },
          ),
          responses: {
            '200': ok({ type: 'object', properties: { ok: { type: 'boolean' } } }),
            '400': errorResponse('Wrong or expired code.'),
            '429': errorResponse('Too many attempts from this IP.'),
          },
        },
      },
      '/pair': {
        post: {
          tags: ['Account'],
          summary: 'Pair a device',
          description:
            'Exchanges the 6-character code shown on the account page for a device token. Send the token as ' +
            '`Authorization: Bearer <token>` on `/me` routes. It lasts until it is revoked on the account page. Codes work once, for 10 minutes.',
          operationId: 'pair',
          requestBody: jsonBody(
            { type: 'object', required: ['code'], properties: { code: { type: 'string' }, name: { type: 'string', maxLength: 40, description: 'Shown in the device list.' } } },
            { code: 'K7QX4M', name: 'Pixel 8' },
          ),
          responses: {
            '200': ok({ type: 'object', required: ['token'], properties: { token: { type: 'string' } } }),
            '400': errorResponse('Wrong or expired code.'),
            '429': errorResponse('Too many attempts from this IP.'),
          },
        },
      },
      '/pair/check': {
        post: {
          tags: ['Account'],
          summary: 'Whose code is this',
          description: 'Shows which account a pairing code belongs to, masked, without spending it. Apps ask before pairing from a link.',
          operationId: 'pairCheck',
          requestBody: jsonBody({ type: 'object', required: ['code'], properties: { code: { type: 'string' } } }, { code: 'K7QX4M' }),
          responses: {
            '200': ok({ type: 'object', required: ['account'], properties: { account: { type: 'string', example: 'j•••@u.nus.edu' } } }),
            '400': errorResponse('Wrong or expired code.'),
            '429': errorResponse('Too many attempts from this IP.'),
          },
        },
      },
      '/me/next': {
        get: {
          tags: ['Account'],
          summary: 'Next bus to where you are going',
          description:
            'The personal version of `/next`. With no `place` or `to`, the destination comes from your timetable:\n\n' +
            '- before your first class: that class, from home\n' +
            '- between classes: the next one, unless the gap is longer than `gapHours`, in which case home until an hour before it\n' +
            '- after your last class: home\n' +
            '- no classes today: `mode: nearby`, the next buses at the nearest stop\n' +
            '- outside your day hours (default 06:00-18:00, stretched for early or late classes): `mode: rest`, no bus\n\n' +
            'The response also carries your saved places, so a widget can show them as buttons.',
          operationId: 'meNext',
          security: [{ bearer: [] }, { cookie: [] }],
          parameters: [
            ...coordParams,
            { name: 'place', in: 'query', description: 'Key of a saved place.', schema: { type: 'string' }, example: 'mrt' },
            { name: 'to', in: 'query', description: 'Any stop code or NUSMods venue code.', schema: { type: 'string' }, example: 'COM3' },
          ],
          responses: { '200': ok({ $ref: '#/components/schemas/MeAnswer' }), '401': errorResponse('No valid session.') },
        },
      },
      '/me/nearby': {
        get: {
          tags: ['Account'],
          summary: 'Departures near you',
          description: 'Upcoming buses at up to three stops within walking range. Without coordinates, uses your home.',
          operationId: 'meNearby',
          security: [{ bearer: [] }, { cookie: [] }],
          parameters: coordParams,
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                stops: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      stop: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' } } },
                      distM: { type: 'integer' },
                      walkS: { type: 'integer' },
                      available: { type: 'boolean' },
                      board: { type: 'array', items: { $ref: '#/components/schemas/BoardRow' } },
                    },
                  },
                },
                asOf: { type: 'string', format: 'date-time' },
              },
            }),
            '400': errorResponse('No coordinates and no home set.'),
            '401': errorResponse('No valid session.'),
          },
        },
      },
      '/me/keys': {
        get: {
          tags: ['Account'],
          summary: 'Your API keys',
          description: 'Names, last four characters and dates. A key itself is only ever shown when it is made.',
          operationId: 'listKeys',
          security: [{ bearer: [] }, { cookie: [] }],
          responses: { '200': ok({ type: 'object', properties: { keys: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, hint: { type: 'string' }, created: { type: 'integer' }, lastUsed: { type: ['integer', 'null'] } } } } } }), '401': errorResponse('No valid session.') },
        },
        post: {
          tags: ['Account'],
          summary: 'Make an API key',
          description: 'From the account page only (a signed-in browser). Up to five per account. The response is the only time the key is shown.',
          operationId: 'createKey',
          security: [{ cookie: [] }],
          requestBody: jsonBody({ type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 40 } } }, { name: 'My script' }),
          responses: {
            '201': ok({ type: 'object', properties: { key: { type: 'string', example: 'tk_…' }, id: { type: 'string' }, name: { type: 'string' }, hint: { type: 'string' } } }),
            '400': errorResponse('No name.'),
            '403': errorResponse('Not from the account page.'),
            '409': errorResponse('Five keys already.'),
          },
        },
      },
      '/me/profile': {
        get: {
          tags: ['Account'],
          summary: 'Your setup',
          operationId: 'getProfile',
          security: [{ bearer: [] }, { cookie: [] }],
          responses: { '200': ok({ $ref: '#/components/schemas/Profile' }), '401': errorResponse('No valid session.') },
        },
        put: {
          tags: ['Account'],
          summary: 'Replace your setup',
          description: 'Replaces the whole profile. Missing fields are reset to their defaults.',
          operationId: 'putProfile',
          security: [{ bearer: [] }, { cookie: [] }],
          requestBody: jsonBody({ $ref: '#/components/schemas/Profile' }),
          responses: { '200': ok({ $ref: '#/components/schemas/Profile' }), '400': errorResponse('Invalid field; the message names it.'), '401': errorResponse('No valid session.') },
        },
      },
      '/me/import': {
        post: {
          tags: ['Account'],
          summary: 'Import a NUSMods timetable',
          description: 'Replaces `trips` with the classes in a NUSMods share link. Hand-entered classes in `manual` are kept.',
          operationId: 'meImport',
          security: [{ bearer: [] }, { cookie: [] }],
          requestBody: jsonBody({ type: 'object', required: ['share'], properties: { share: { type: 'string', format: 'uri' } } }),
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                profile: { $ref: '#/components/schemas/Profile' },
                unresolved: { type: 'array', items: { $ref: '#/components/schemas/Unresolved' } },
              },
            }),
            '400': errorResponse('Not a NUSMods share link.'),
            '401': errorResponse('No valid session.'),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key', description: 'A key from the account page (API keys). Starts with `tk_`.' },
        bearer: { type: 'http', scheme: 'bearer', description: 'An API key, or a device token from `/pair`.' },
        cookie: { type: 'apiKey', in: 'cookie', name: 'nb_s', description: 'Set by signing in on the account page.' },
      },
      schemas: {
        Quality: quality,
        Answer: {
          type: 'object',
          required: ['label', 'detail', 'alt', 'stop', 'quality', 'asOf', 'arrivals'],
          properties: {
            label: { type: 'string', maxLength: 40, description: 'The headline, e.g. `D2 · 4 min`. Display verbatim.', example: 'D2 · 4 min' },
            detail: { type: 'string', description: 'One line of supporting detail. Display verbatim.' },
            alt: { type: ['string', 'null'], description: 'A second option using a different bus or stop, or null if there is none.' },
            stop: {
              type: 'object',
              description: 'Where to board.',
              required: ['code', 'name', 'confidence'],
              properties: {
                code: { type: 'string' },
                name: { type: 'string' },
                confidence: { type: 'number', minimum: 0, maximum: 1, description: 'How sure the API is that this is the right stop. Below ~0.6, treat it as a guess.' },
              },
            },
            quality: { $ref: '#/components/schemas/Quality' },
            asOf: { type: 'string', format: 'date-time', description: 'When the data was fetched. On a `stale` answer this is the original fetch time.' },
            arrivals: { type: 'array', items: { $ref: '#/components/schemas/Arrival' }, description: 'Raw arrivals at the boarding stop.' },
            departsAt: {
              type: ['string', 'null'],
              format: 'date-time',
              description: 'When the bus leaves the boarding stop. Count down from this rather than re-showing `label` later. Null with no live time.',
            },
            arriveAt: {
              type: ['string', 'null'],
              format: 'date-time',
              description: 'When you reach the destination stop, by bus or on foot.',
            },
            arrived: { type: 'boolean', description: 'Already at the destination (either side of the road). No bus, no countdown.' },
            leave: {
              type: ['object', 'null'],
              description:
                'The latest time to set off. On `/me/next` for a class, the latest that still gets you there on time; otherwise, for the bus in `departsAt`. ' +
                'When you will be late whatever you do, `at` is now. Null or absent when you should simply go now. Once `at` has passed, show "Leave now".',
              required: ['at', 'estimated', 'svc', 'stop', 'board', 'arrive'],
              properties: {
                at: { type: 'string', format: 'date-time' },
                svc: { type: ['string', 'null'], description: 'The bus this time is for. For a class it can differ from the headline bus. Null when walking.' },
                stop: { type: ['string', 'null'], description: 'Where to board it, short name.' },
                board: { type: ['string', 'null'], format: 'date-time', description: 'When that bus leaves the stop. With `estimated`, when you reach the stop. Null when walking.' },
                arrive: { type: ['string', 'null'], format: 'date-time', description: 'When you get there by leaving at `at`: the venue for a class, otherwise the stop.' },
                note: { type: ['string', 'null'], description: 'Why the time is earlier than it could be, e.g. the bus is often packed then. Display verbatim.' },
                off: { type: 'string', description: 'Where to get off, when the bus only stops across the road from the destination (e.g. `Opp NUSS` for AS 5). `arrive` includes the walk back across. Absent otherwise.' },
                estimated: { type: 'boolean', description: 'Based on the usual gap between buses rather than a live time. Show it with a `~`.' },
              },
            },
          },
        },
        Arrival: {
          type: 'object',
          required: ['svc', 'etaS', 'crowd', 'plate', 'berth'],
          properties: {
            svc: { type: 'string', example: 'D2' },
            etaS: { type: ['integer', 'null'], description: 'Seconds until arrival. `null` means no bus, never 0.' },
            crowd: { type: ['string', 'null'], enum: ['low', 'medium', 'high', null] },
            plate: { type: ['string', 'null'], example: 'PD726D' },
            berth: { type: ['string', 'null'], description: 'Raw feed stop code. At a terminus, `-S` marks the departing run and `-E` the terminating one.' },
          },
        },
        BoardRow: {
          type: 'object',
          required: ['svc', 'etaS', 'quality', 'ambiguousBerth'],
          properties: {
            svc: { type: 'string' },
            etaS: { type: ['integer', 'null'] },
            quality: { $ref: '#/components/schemas/Quality' },
            ambiguousBerth: { type: 'boolean', description: 'True when the direction of this service at this stop could not be confirmed.' },
          },
        },
        StopBoard: {
          type: 'object',
          required: ['stop', 'board', 'asOf', 'available'],
          properties: {
            stop: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' } } },
            board: { type: 'array', items: { $ref: '#/components/schemas/BoardRow' } },
            asOf: { type: 'string', format: 'date-time' },
            available: { type: 'boolean', description: 'False when the upstream feed could not be reached.' },
          },
        },
        StopPairs: {
          type: 'object',
          required: ['version', 'attribution', 'places'],
          properties: {
            version: { type: 'string', description: 'When the stop graph was scraped.' },
            attribution: { type: 'string', description: 'Credit line for the data.' },
            places: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'name', 'crossingM', 'sides'],
                properties: {
                  id: { type: 'string', description: 'The code of the side that is not "Opp", or of the only side.' },
                  name: { type: 'string' },
                  crossingM: { type: ['integer', 'null'], description: 'Straight-line metres between the two sides. Null with one side.' },
                  sides: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 2,
                    items: {
                      type: 'object',
                      required: ['code', 'name', 'longName', 'lat', 'lon', 'services'],
                      properties: {
                        code: { type: 'string', description: 'Stop code, as used by every other route.' },
                        name: { type: 'string' },
                        longName: { type: 'string' },
                        lat: { type: 'number' },
                        lon: { type: 'number' },
                        services: {
                          type: 'array',
                          description: 'Buses that call here, in service order.',
                          items: {
                            type: 'object',
                            required: ['svc', 'next'],
                            properties: {
                              svc: { type: 'string' },
                              next: { type: ['string', 'null'], description: 'The next stop on this service; null where it terminates.' },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        Campus: {
          type: 'object',
          required: ['viewBox', 'stops', 'routes', 'destinations', 'residences'],
          properties: {
            viewBox: { type: 'string', description: 'SVG viewBox the x/y coordinates are projected into.' },
            stops: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  name: { type: 'string' },
                  longName: { type: 'string' },
                  opposite: { type: ['string', 'null'], description: 'The stop across the road, if any.' },
                  x: { type: 'number' },
                  y: { type: 'number' },
                  lat: { type: 'number' },
                  lon: { type: 'number' },
                  core: { type: 'boolean', description: 'False for the few stops far off the main campus cluster.' },
                },
              },
            },
            routes: {
              type: 'object',
              description: 'Keyed by service code.',
              additionalProperties: {
                type: 'object',
                properties: {
                  seq: { type: 'array', items: { type: 'string' }, description: 'Stop codes in route order.' },
                  loop: { type: 'boolean' },
                  color: { type: 'string' },
                },
              },
            },
            residences: {
              type: 'array',
              description: 'On-campus residences and the stops that serve each, for picking home stops. Outlines are not included.',
              items: {
                type: 'object',
                properties: { code: { type: 'string' }, name: { type: 'string' }, stops: { type: 'array', items: { type: 'string' } }, walkM: { type: 'integer' } },
              },
            },
            destinations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  label: { type: 'string' },
                  stopCode: { type: 'string', description: 'The stop to route to for this destination.' },
                  kind: { type: 'string', enum: ['stop', 'landmark', 'building', 'room'], description: '`landmark`: a named place such as a food court, served by every stop in `stops`.' },
                  stops: { type: 'array', items: { type: 'string' }, description: 'Landmarks only: every stop that serves it. Send its `code` as `to` and the quicker one is used.' },
                  detail: { type: 'string', description: 'Landmarks only: what it is, e.g. "Food court".' },
                  walkM: { type: 'integer', description: 'Metres on foot from `stopCode`, along campus paths. Absent for a stop.' },
                  aliases: { type: 'array', items: { type: 'string' }, description: 'Other names people search for, lower case.' },
                },
              },
            },
          },
        },
        ImportResult: {
          type: 'object',
          required: ['url', 'path', 'home', 'classes', 'schedule', 'unresolved'],
          properties: {
            url: { type: 'string', format: 'uri', description: 'Your personal link.' },
            path: { type: 'string', description: 'The same link, relative.' },
            home: { type: ['string', 'null'] },
            classes: { type: 'integer' },
            schedule: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  day: { type: 'integer', minimum: 0, maximum: 6, description: '0 = Sunday.' },
                  at: { type: 'integer', description: 'Class start, minutes past midnight SGT.' },
                  to: { type: 'string', description: 'Destination stop code.' },
                  label: { type: 'string' },
                },
              },
            },
            unresolved: {
              type: 'array',
              description: 'Classes whose venue could not be matched to a stop.',
              items: { $ref: '#/components/schemas/Unresolved' },
            },
          },
        },
        Unresolved: {
          type: 'object',
          description: 'A class whose venue matched no stop, with its time so it can be placed by hand.',
          properties: {
            module: { type: 'string' },
            venue: { type: 'string' },
            day: { type: 'integer', minimum: 0, maximum: 6 },
            arriveByMin: { type: 'integer' },
            endMin: { type: 'integer' },
          },
        },
        Trip: {
          type: 'object',
          required: ['day', 'arriveByMin', 'to', 'label'],
          properties: {
            day: { type: 'integer', minimum: 0, maximum: 6, description: '0 = Sunday.' },
            arriveByMin: { type: 'integer', description: 'Class start, minutes past midnight SGT.' },
            endMin: { type: 'integer', description: 'Class end, minutes past midnight SGT.' },
            to: { type: 'string', description: 'Destination stop code.' },
            label: { type: 'string', maxLength: 60 },
            venue: { type: 'string' },
          },
        },
        Profile: {
          type: 'object',
          properties: {
            home: {
              type: ['object', 'null'],
              properties: {
                lat: { type: 'number' },
                lon: { type: 'number' },
                stops: { type: 'array', maxItems: 3, items: { type: 'string' }, description: 'Usual boarding stops near home, best first.' },
              },
            },
            gapHours: { type: 'number', minimum: 0.5, maximum: 12, default: 2, description: 'A gap between classes longer than this means going home in between.' },
            dayStartMin: { type: 'integer', default: 360, description: 'Start of your day, minutes past midnight SGT. Earlier, `/me/next` rests.' },
            dayEndMin: { type: 'integer', default: 1080, description: 'End of your day. Later, `/me/next` rests, unless a class runs late.' },
            walkPace: { type: 'string', enum: ['slow', 'normal', 'fast'], default: 'normal', description: 'How fast you walk: 1.1, 1.3 or 1.5 m/s. Scales every walk except `homeWalkMin`.' },
            fullBusMargin: { type: 'boolean', default: true, description: 'Aim one bus earlier when the bus to wait for is often packed at that stop and time.' },
            seen: { type: 'array', items: { type: 'string' }, description: 'One-time screens already shown, e.g. `onboarding`, `pace`.' },
            homeWalkMin: { type: 'integer', minimum: 0, maximum: 30, default: 5, description: 'Minutes from home to your home stop. Counts when a trip starts from home without a location.' },
            trips: { type: 'array', items: { $ref: '#/components/schemas/Trip' }, description: 'From the NUSMods import.' },
            manual: { type: 'array', items: { $ref: '#/components/schemas/Trip' }, description: 'Entered by hand. Kept on re-import.' },
            places: {
              type: 'array',
              maxItems: 12,
              items: {
                type: 'object',
                required: ['key', 'label', 'to'],
                properties: { key: { type: 'string', pattern: '^[a-z0-9-]{1,24}$' }, label: { type: 'string', maxLength: 24 }, to: { type: 'string' } },
              },
            },
            share: { type: ['string', 'null'], description: 'The NUSMods share link last imported.' },
          },
        },
        MeAnswer: {
          allOf: [
            { $ref: '#/components/schemas/Answer' },
            {
              type: 'object',
              required: ['mode', 'dest', 'places'],
              properties: {
                mode: {
                  type: 'string',
                  enum: ['trip', 'nearby', 'rest'],
                  description: '`rest` outside your day hours: no bus, and `detail` names your next class. Show a rest state, not a bus.',
                },
                dest: {
                  type: ['object', 'null'],
                  properties: {
                    to: { type: 'string' },
                    label: { type: 'string' },
                    why: { type: 'string', enum: ['class', 'home', 'gap-home', 'place'] },
                  },
                },
                places: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, label: { type: 'string' } } } },
                refreshAt: {
                  type: 'string',
                  format: 'date-time',
                  description: 'Planned answers only: the next moment the plan changes by itself (a class starts or ends, the day starts or ends). Refresh then, and when `departsAt` passes.',
                },
                timing: {
                  type: ['object', 'null'],
                  description: 'For a class: whether you will make it, counting the walk from the stop to the venue.',
                  properties: {
                    status: { type: 'string', enum: ['on-time', 'tight', 'late'] },
                    text: { type: 'string', example: 'Arrive 09:52 · 8 min early' },
                    classAt: { type: 'string', format: 'date-time' },
                    reachAt: { type: 'string', format: 'date-time', description: 'When you reach the class on the headline bus.' },
                  },
                },
              },
            },
          ],
        },
        Health: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            now: { type: 'string', format: 'date-time' },
            sgt: { type: 'string' },
            graph: { type: 'object' },
            config: { type: 'object', additionalProperties: { type: 'boolean' } },
            auth: { type: 'object', description: 'Present only with `probe=1`.' },
          },
        },
        Error: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' } },
          additionalProperties: true,
        },
      },
    },
  };
}

/** Pinned so a breaking Elements release cannot change the page underneath us. */
const ELEMENTS = 'https://unpkg.com/@stoplight/elements@9.0.25';

export const DOCS_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>API · terminus</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <script src="${ELEMENTS}/web-components.min.js" integrity="sha384-X5kH2B8aH81JEl8IfSBwwnr8FYcCqMzdxpqjmmlRbhIl7SsQ9Zn0xk+csQmU37zN" crossorigin="anonymous"></script>
  <link rel="stylesheet" href="${ELEMENTS}/styles.min.css" integrity="sha384-NzdOiocfnINlXfuCXi4OpL/xvdbgLiKaLHQ07Z+IwhVaxHqLShn5rVD5OHt/LYgz" crossorigin="anonymous">
  <style>
    /* The page never scrolls; only the docs inside it do, so a phone's
       rubber-band scroll can't move our bar out from above Elements' fixed
       mobile bar, or leave uncovered page below the docs. The height is the
       visible one (dvh): Chrome on Android sizes a fixed inset-0 box as if
       the address bar were hidden, which put the end of the docs off screen.
       With nothing scrolling the page, the address bar never hides, so dvh
       doesn't change under you. */
    html, body { margin: 0; height: 100%; overflow: hidden; background: #fff; }
    body { position: fixed; top: 0; left: 0; right: 0; height: 100%; height: 100dvh; display: flex; flex-direction: column; }
    .bar { flex: none; box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; height: 48px; padding: 0 16px; border-bottom: 1px solid #e7e5e2; font: 500 14px/1 system-ui, -apple-system, sans-serif; background: #fafaf9; }
    .bar a { color: #1c1917; text-decoration: none; display: inline-flex; align-items: center; gap: 8px; }
    .bar b { color: #c2410c; font-weight: inherit; }
    .bar .back { color: #6b6560; padding: 12px 0; }
    elements-api { display: block; flex: 1; min-height: 0; }
    /* Below Elements' breakpoint the sidebar becomes a drawer (layout="responsive").
       Inputs under 16px make iOS Safari zoom in on focus and stay zoomed. */
    @media (max-width: 767px) {
      elements-api input, elements-api select, elements-api textarea { font-size: 16px !important; }
      /* Elements' fixed mobile bar has no z-index, so sticky schema headings
         (z-index 10) slide over it while scrolling; and no top, so it sat
         wherever the page flow put it. It goes right under our 48px bar. */
      elements-api .TopNav--mosaic { z-index: 20; top: 48px; }
      elements-api .sl-drawer-container > .sl-fixed { z-index: 30; }
      /* Room past the last line. */
      elements-api .sl-overflow-y-auto.sl-flex-1 { padding-bottom: 24px; }
    }
  </style>
</head>
<body>
  <div class="bar">
    <a href="/"><img src="/assets/mark.svg" alt="" width="22" height="22"><span>termi<b>nus</b> API</span></a>
    <a class="back" href="/">Back to terminus</a>
  </div>
  <noscript><p style="padding:16px">The docs need JavaScript. The raw spec is at <a href="/openapi.json">/openapi.json</a>.</p></noscript>
  <elements-api apiDescriptionUrl="/openapi.json" router="hash" layout="responsive"></elements-api>
</body>
</html>`;
