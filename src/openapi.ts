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
    'How degraded the answer is, best to worst. `live`: a real vehicle ETA. ' +
    '`scheduled`: the feed answered with no vehicle, so this is a headway estimate. ' +
    '`unknown`: the feed could not be reached; no time is invented. ' +
    '`stale`: a cached live answer served because upstream is down; `asOf` keeps the original fetch time. ' +
    '`ended`: outside operating hours.',
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

const errorResponse = (description: string, example: Record<string, unknown>) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example } },
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
      title: 'NUS Bus API',
      version: '1.0.0',
      description: [
        'Answers one question about the NUS internal shuttle bus: **when is my bus, and should I run.**',
        '',
        'The answer endpoints return a pre-rendered `label` and `detail`. Clients display them as-is ' +
          'rather than formatting times themselves, so every client says the same thing.',
        '',
        '**Direction comes from route order, not distance.** NUS stops come in pairs a few metres apart ' +
          '(`KR-MRT` / `KR-MRT-OPP`), inside GPS error. The API checks which side is genuinely upstream of ' +
          'the destination and will tell you to cross the road.',
        '',
        '**Answers degrade in public.** Every answer carries a `quality`. A stale answer keeps its original ' +
          '`asOf`; an unreachable feed says so instead of inventing a time.',
        '',
        'No API key is needed. Live arrivals are cached for 15 seconds per stop, so repeated calls are cheap ' +
          'and never multiply load on the upstream NUS feed. Please keep it that way: no bulk polling.',
      ].join('\n'),
    },
    servers: [{ url: origin }],
    // Explicitly unauthenticated: no API key, no account.
    security: [],
    tags: [
      { name: 'Answers', description: 'The pre-rendered "when is my bus" answer.' },
      { name: 'Stops', description: 'Per-stop arrivals and static campus data.' },
      { name: 'Timetable', description: 'Turn a NUSMods timetable into a personal link.' },
      { name: 'Service', description: 'Health and configuration.' },
    ],
    paths: {
      '/next': {
        get: {
          tags: ['Answers'],
          summary: 'Next bus',
          description:
            'The zero-configuration answer. What it answers depends on what you send:\n\n' +
            '- `tt` — your next class from an imported timetable (see `/import`). Coordinates pick the boarding stop; without them the timetable\'s home stop is used.\n' +
            '- `to` — a named trip key or stop code.\n' +
            '- `lat` + `lon` alone — the next buses at your nearest stop, with no destination.\n' +
            '- nothing — a "Set up" answer. It never invents a destination.',
          operationId: 'getNext',
          parameters: [
            ...coordParams,
            {
              name: 'to',
              in: 'query',
              description: 'A trip key (`utown`, `mrt`, `home`) or a stop code such as `UTOWN`.',
              schema: { type: 'string' },
              example: 'UTOWN',
            },
            {
              name: 'tt',
              in: 'query',
              description: 'An encoded timetable, as returned in the `path` from `/import`.',
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'The answer. Always 200, including when upstream is down: check `quality`.',
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
          summary: 'Answer for a trip or stop',
          description:
            'The same answer as `/next`, for an explicit destination. Without coordinates the trip\'s configured origin is used.',
          operationId: 'getTrip',
          parameters: [
            {
              name: 'to',
              in: 'query',
              required: true,
              description: 'A trip key (`utown`, `mrt`, `home`) or a stop code such as `UTOWN`.',
              schema: { type: 'string' },
              example: 'UTOWN',
            },
            ...coordParams,
          ],
          responses: {
            '200': {
              description: 'The answer.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Answer' }, example: answerExample } },
            },
            '400': {
              description: 'Unknown trip key or stop code. Lists the valid trip keys.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error', 'trips'],
                    properties: { error: { type: 'string' }, trips: { type: 'array', items: { type: 'string' } } },
                  },
                  example: { error: 'unknown trip', trips: ['utown', 'mrt', 'home'] },
                },
              },
            },
          },
        },
      },
      '/arrivals': {
        get: {
          tags: ['Stops'],
          summary: 'Arrivals at one stop',
          description:
            'Every service at one stop, with no destination and no walking maths. Shares the 15-second per-stop cache with the answer endpoints.',
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
            'Static stop and route geometry, projected into an SVG coordinate space, plus a destination search list covering stops and NUSMods buildings/rooms. Changes only on deploy; cached for an hour.',
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
                      { code: 'COM1', label: 'COM1', stopCode: 'COM3', kind: 'building' },
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
          tags: ['Timetable'],
          summary: 'Import a NUSMods timetable',
          description:
            'Turns a NUSMods share URL into a personal `/next?tt=` link. Each class becomes a destination: the stop nearest its venue. ' +
            'Stateless: the whole timetable is encoded into the link and nothing is stored.',
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
          description:
            'Stop-graph info and which configuration is present. Reports presence only, never values. `probe=1` also checks the upstream auth token.',
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
                    graph: { generated: '2026-08-27T15:32:24Z', source: 'nusbus.app public proxy', stops: 33, services: ['A1', 'A2', 'D1', 'D2', 'K', 'P', 'R1', 'R2'] },
                    config: { auth: true, proxy: true, analytics: true },
                    trip: 'utown',
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Quality: quality,
        Answer: {
          type: 'object',
          required: ['label', 'detail', 'alt', 'stop', 'quality', 'asOf', 'arrivals'],
          properties: {
            label: { type: 'string', maxLength: 40, description: 'The headline, e.g. `D2 · 4 min`. Display verbatim.', example: 'D2 · 4 min' },
            detail: { type: 'string', description: 'One line of supporting detail. Display verbatim.' },
            alt: { type: ['string', 'null'], description: 'A second option with a different first leg, or null when there is none.' },
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
        Campus: {
          type: 'object',
          required: ['viewBox', 'stops', 'routes', 'destinations'],
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
            destinations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  label: { type: 'string' },
                  stopCode: { type: 'string', description: 'The stop to route to for this destination.' },
                  kind: { type: 'string', enum: ['stop', 'building', 'room'] },
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
              items: { type: 'object', properties: { module: { type: 'string' }, venue: { type: 'string' } } },
            },
          },
        },
        Health: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            now: { type: 'string', format: 'date-time' },
            sgt: { type: 'string' },
            graph: { type: 'object' },
            config: { type: 'object', additionalProperties: { type: 'boolean' } },
            trip: { type: ['string', 'null'] },
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
  <title>NUS Bus API</title>
  <script src="${ELEMENTS}/web-components.min.js"></script>
  <link rel="stylesheet" href="${ELEMENTS}/styles.min.css">
  <style>html, body { margin: 0; height: 100%; } elements-api { display: block; height: 100vh; }</style>
</head>
<body>
  <elements-api apiDescriptionUrl="/openapi.json" router="hash" layout="sidebar"></elements-api>
</body>
</html>`;
