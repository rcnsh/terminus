/**
 * OpenAPI 3.1 description of this API. Served at /openapi.json and rendered
 * at /docs by Stoplight Elements.
 *
 * Kept by hand, next to the code it describes. test/worker.smoke.js asserts
 * every documented path answers (no 404s) and every route is documented, so
 * the two cannot silently drift.
 */

import { horizonSvg, lightInkAt, skyVars } from './pagesky.ts';
import { ELEMENTS } from './http.ts';
import type { Phase } from './pagesky.ts';

const quality = {
  type: 'string',
  enum: ['live', 'scheduled', 'unknown', 'stale', 'ended'],
  description:
    'How reliable the answer is, best to worst. `live`: an ETA from the feed for a tracked bus. ' +
    '`scheduled`: the feed responded but listed no bus, so the time is an estimate from the usual gap between buses. ' +
    '`unknown`: the feed could not be reached, so no time is given. ' +
    '`stale`: the last cached live answer, returned because the feed is down; `asOf` is when it was originally fetched. ' +
    '`ended`: the service is outside its operating hours.',
};

/** `?stopped=1`: the services not running now too, for the Buses tab. */
const stoppedParam = {
  name: 'stopped',
  in: 'query',
  description:
    'Set to `1` to list the services that call at the stop but are outside their hours now, after the running ones, by name, with `running: false`, why (`stopped`) and when each starts again (`resumesAt`). ' +
    'A service the feed still gives a time for is running. Default: running services only.',
  schema: { type: 'string', enum: ['1'] },
};

/** `?public=1`: the public buses too, as an account's `publicBuses` does for `/me/*`. */
const publicParam = {
  name: 'public',
  in: 'query',
  description:
    'Set to `1` to count the public buses (95, 151, 96 and others) that call at the campus’s stops as well as the shuttles. ' +
    'They have a fare, so one is the answer only when it clearly saves time; a public bus leg carries `paid: true`. Default: shuttles only.',
  schema: { type: 'string', enum: ['1'] },
};

const coordParams = [
  {
    name: 'lat',
    in: 'query',
    description: 'Latitude of the caller, rounded to four decimal places (about 11 m) when read, and never stored. Ignored unless `lon` is also sent.',
    schema: { type: 'number', minimum: -90, maximum: 90 },
    example: 1.294962,
  },
  {
    name: 'lon',
    in: 'query',
    description: 'Longitude of the caller, rounded like `lat`. Ignored unless `lat` is also sent.',
    schema: { type: 'number', minimum: -180, maximum: 180 },
    example: 103.784556,
  },
  {
    name: 'acc',
    in: 'query',
    description:
      'How far out the location may be, in metres: its accuracy, plus how far the caller could have walked since the fix if it is not fresh. ' +
      'A location further out than 200 m is treated as none, and the answer follows the timetable instead.',
    schema: { type: 'number', minimum: 0 },
    example: 25,
  },
];

const errorResponse = (description: string, example?: Record<string, unknown>) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, ...(example ? { example } : {}) } },
});

const ok = (schema: Record<string, unknown>, example?: Record<string, unknown>) => ({
  description: 'OK',
  content: { 'application/json': { schema, ...(example ? { example } : {}) } },
});

const jsonBody = (schema: Record<string, unknown>, example?: Record<string, unknown>) => ({
  required: true,
  content: { 'application/json': { schema, ...(example ? { example } : {}) } },
});

const answerExample = {
  label: 'D2 · 4 min',
  detail: 'KR MRT · cross the road · UTown ~12 min · crowding: low · or A2 9 min',
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

/** The apps' version (Android versionName, the Mac's CFBundleShortVersionString):
 *  the API and the apps are released together. A test fails when a version
 *  bump leaves this behind. */
export const API_VERSION = '2.4.2';

export function openApiSpec(origin: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'terminus API',
      version: API_VERSION,
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
          'answer with its original `asOf` time, or says that live times are unavailable.',
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
      { name: 'Service', description: 'Health and configuration.' },
      { name: 'Account', description: 'Sign in on the account page, or pair a device with a code from it.' },
      { name: 'Map', description: 'The campus street map, for MapLibre. Open, like the website.' },
      { name: 'Downloads', description: 'The apps, and what their update checks read.' },
    ],
    paths: {
      '/next': {
        get: {
          tags: ['Answers'],
          summary: 'Next bus',
          description:
            'Returns the next bus. The destination depends on which parameters you send:\n\n' +
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
            publicParam,
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
                        detail: 'Send lat/lon for nearby buses, or ?to= a stop or venue',
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
            'Lists the next arrivals for every service at one stop. There is no destination, so walking time and route direction are not considered. Uses the same 15-second per-stop cache as `/next` and `/trip`. `stop.opposite` is the stop across the road (or one easily mistaken for it), whose board is a second `/arrivals` call away. Each row says where the service goes from here (`towards`), how full its next bus is (`crowd`) and when the service stops running today (`endsAt`).',
          operationId: 'getArrivals',
          parameters: [
            {
              name: 'stop',
              in: 'query',
              required: true,
              description: 'Stop code, case-insensitive. A public stop of its own (LTA’s five-digit code, such as `16009` for Kent Ridge Terminal on Clementi Road) lists its public buses.',
              schema: { type: 'string' },
              example: 'COM3',
            },
            publicParam,
            stoppedParam,
          ],
          responses: {
            '200': {
              description: 'The stop\'s board.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/StopBoard' },
                  example: {
                    stop: { code: 'YIH', name: 'YIH', longName: 'Yusof Ishak House', opposite: 'YIH-OPP', oppositeAcross: true, oppositeName: 'Opp Yusof Ishak House' },
                    board: [
                      {
                        svc: 'K',
                        etaS: 180,
                        quality: 'live',
                        ambiguousBerth: false,
                        later: [{ etaS: 900, quality: 'live', eta: '15 min' }, { etaS: 1500, quality: 'scheduled', eta: '~25 min' }],
                        color: '#2b9ad6',
                        towards: ['Central Library', 'Prince George’s Park Foyer'],
                        crowd: 'low',
                        endsAt: '2026-09-28T15:04:00.000Z',
                        running: true,
                        eta: '3 min',
                        laterText: 'then 15, ~25 min',
                        toText: 'to Central Library, Prince George’s Park Foyer',
                      },
                      { svc: 'D1', etaS: 420, quality: 'live', ambiguousBerth: false, later: [], color: '#ec4fa0', towards: ['Central Library', 'COM 3'], crowd: 'high', endsAt: '2026-09-28T15:00:00.000Z', running: true, eta: '7 min', laterText: null, toText: 'to Central Library, COM 3' },
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
      '/buses': {
        get: {
          tags: ['Stops'],
          summary: 'Live buses on one service',
          description:
            'Which stop each bus on a service is at, or which two stops it is between, how full it is and the stop it reaches next. Positions come from the live feed through a 5-second cache per service. The feed gives a new position only every 15 to 20 seconds, too far apart to draw a bus where it is, so each bus is shown at a stop or between two. Within 40 metres of one of its stops, measured along its route, it is at that stop (`at`), with `lat` and `lon` the stop’s own; a map draws it just beside the stop, and several there side by side by `slot`. Otherwise it is halfway between the stop it passed and its next one, on the route line, or spread evenly between them when there are several (a third and two thirds of the way for two); `stretch` gives that part of the route, so a map can show the bus is somewhere along it. On a road the route uses both ways, its side follows from where it has been: a bus only moves forward along its route, so it keeps its side and its next stop only moves on. A bus away from its route (such as one parked at the depot) is left out. `plate` is the bus’s number plate, as painted on it; `id` stays the same for a bus while it runs, so a map can move it from one place to the next.',
          operationId: 'getBuses',
          parameters: [
            { name: 'svc', in: 'query', required: true, description: 'Service code, case-insensitive.', schema: { type: 'string' }, example: 'D2' },
          ],
          responses: {
            '200': {
              description: 'The service\'s buses. `available` is false when the live feed could not be reached, which is not the same as no buses running.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Buses' },
                  example: {
                    svc: 'D2',
                    color: '#8e44c9',
                    buses: [{ id: '3f9a1c0b7e21', plate: 'PD726D', lat: 1.29497, lon: 103.77349, along: 1834.2, heading: 92, moving: true, crowd: 'low', at: null, slot: 0, stretch: { from: 1410.5, to: 2257.9, last: { code: 'LT13', name: 'LT13' } }, nextStop: { code: 'COM3', name: 'COM 3' } }],
                    asOf: '2026-10-02T01:14:02.000Z',
                    available: true,
                    stale: false,
                  },
                },
              },
            },
            '400': errorResponse('Unknown service.', { error: 'unknown service', svc: 'Z9' }),
          },
        },
      },
      '/line': {
        get: {
          tags: ['Stops'],
          summary: 'One service’s line',
          description:
            'A service’s whole line, for a page about it: its stops in route order (a loop’s first stop is not listed again at its end), each with the other shuttle services that call there, and its buses placed on that list, each at a stop (`at`, an index into `stops`) or between two (`after`: between `stops[after]` and the next, which on a loop’s last stop is the first again). The buses are the same ones as `/buses`, placed the same way, from the same 5-second cache. With `stop`, `stop.row` is the service’s board row at that stop, as on `/arrivals?stopped=1`, through the same 15-second cache. `running`, `stopped` and `resumesAt` say whether the service is inside its hours now, and if not, why and when it starts again. No times are worked out for the other stops: only the live feed’s own are given.',
          operationId: 'getLine',
          parameters: [
            { name: 'svc', in: 'query', required: true, description: 'Service code, case-insensitive. Shuttle services only.', schema: { type: 'string' }, example: 'D1' },
            { name: 'stop', in: 'query', description: 'A stop on the service, case-insensitive: adds `stop`, with its index in `stops` and the service’s row there.', schema: { type: 'string' }, example: 'YIH' },
          ],
          responses: {
            '200': {
              description: 'The line. `available` is false when the live feed could not be reached; `buses` is then empty, which is not the same as no buses running.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Line' },
                  example: {
                    svc: 'D1',
                    color: '#ec4fa0',
                    endsAt: '2026-10-07T15:00:00.000Z',
                    running: true,
                    stopped: null,
                    resumesAt: null,
                    stops: [
                      { code: 'COM3', name: 'COM 3', longName: 'COM 3', services: ['D2'] },
                      { code: 'HSSML-OPP', name: 'Opp HSSML', longName: 'Opp HSSML', services: ['A2', 'R2'] },
                    ],
                    buses: [
                      { id: '3f9a1c0b7e21', plate: 'PD418C', crowd: 'low', at: 6, after: null },
                      { id: '9be0d4a1c377', plate: 'PD562E', crowd: null, at: null, after: 1 },
                    ],
                    stop: {
                      code: 'YIH',
                      index: 8,
                      row: { svc: 'D1', etaS: 240, quality: 'live', ambiguousBerth: false, later: [], color: '#ec4fa0', towards: ['Central Library', 'COM 3'], crowd: 'low', endsAt: '2026-10-07T15:00:00.000Z', running: true },
                    },
                    available: true,
                    asOf: '2026-10-07T05:14:02.000Z',
                  },
                },
              },
            },
            '400': errorResponse('Unknown service, or a stop the service does not call at.', { error: 'stop not on this service', svc: 'D1', stop: 'PGP' }),
          },
        },
      },
      '/campus': {
        get: {
          tags: ['Stops'],
          summary: 'Campus map and destinations',
          description:
            'Returns stop positions (as SVG coordinates and lat/lon) and each route\'s path along the roads, plus a destination search list: every stop, named buildings and NUSMods rooms, each mapped to the stop an import would use. The data only changes when the API is redeployed, and responses are cached for an hour. Send the `ETag` back as `If-None-Match` to get a 304 when nothing has changed.',
          operationId: 'getCampus',
          responses: {
            '200': {
              description: 'Map geometry and destinations.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Campus' },
                  example: {
                    viewBox: '0 0 1000 871',
                    stops: [{ code: 'AS5', name: 'AS 5', longName: 'AS 5', opposite: null, x: 177.7, y: 657.9, lat: 1.293619, lon: 103.771475, services: ['A1', 'D1', 'R1'], core: true }],
                    routes: {
                      A1: { seq: ['KRB', 'LT13', 'AS5', 'BIZ2', 'TCOMS-OPP', 'PGP', 'KR-MRT'], loop: true, color: '#e53935', line: [[103.77438, 1.29464], [103.77421, 1.29475]], shaped: true },
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
      '/status.json': {
        get: {
          tags: ['Service'],
          summary: 'Feed status',
          security: [],
          description:
            "Whether NUS's live feed is answering, as the 15-minute check last saw it, and the last 20 confirmed outages. What the status page at /status shows.",
          operationId: 'getStatus',
          responses: {
            '200': ok(
              {
                type: 'object',
                properties: {
                  feed: { type: 'string', enum: ['up', 'down', 'unknown'] },
                  since: { type: ['string', 'null'], format: 'date-time' },
                  checkedAt: { type: ['string', 'null'], format: 'date-time' },
                  checking: { type: 'boolean', description: 'False when the checks have stopped running.' },
                  publicFeed: { type: 'string', enum: ['up', 'down', 'unknown'], description: 'LTA DataMall, for the public buses. Extra to the shuttle feed: it has no incidents and raises no alerts.' },
                  publicSince: { type: ['string', 'null'], format: 'date-time' },
                  incidents: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        start: { type: 'string', format: 'date-time' },
                        end: { type: ['string', 'null'], format: 'date-time' },
                        cause: { type: 'string', enum: ['version', 'feed'], description: "'version': NUS wanted a newer uNivUS version string." },
                      },
                    },
                  },
                },
              },
            ),
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
            '429': errorResponse('Too many attempts from this IP, or too many sign-in emails for everyone this minute.'),
          },
        },
      },
      '/auth/anon': {
        post: {
          tags: ['Account'],
          summary: 'Start without an account',
          description:
            "An app's first launch: creates an account with no email and returns a device token for it, so every `/me` route works " +
            'straight away. Add an email later with `/auth/app/start`. Deleted after 60 days unused.',
          operationId: 'anon',
          requestBody: jsonBody(
            { type: 'object', properties: { name: { type: 'string', maxLength: 40 }, platform: { type: 'string', enum: ['android', 'mac', 'ios'] } } },
            { name: 'Pixel 8', platform: 'android' },
          ),
          responses: {
            '201': ok({ type: 'object', required: ['token'], properties: { token: { type: 'string' } } }),
            '429': errorResponse('Too many new accounts, from this IP or overall.'),
          },
        },
      },
      '/auth/anon/web': {
        post: {
          tags: ['Account'],
          summary: 'Start without an account, in a browser',
          description:
            'The website\'s "Use terminus without an email": the same account as `/auth/anon`, as a web session cookie. Needs the Turnstile token when ' +
            'Turnstile is on. Signing in with an email from that browser (`/auth/code` or the link) adds the email to it, or switches to the email\'s account if it has one.',
          operationId: 'anonWeb',
          requestBody: jsonBody({ type: 'object', properties: { turnstile: { type: 'string' } } }, {}),
          responses: {
            '201': ok({ type: 'object', properties: { ok: { type: 'boolean' } } }),
            '400': errorResponse('The human check failed.'),
            '429': errorResponse('Too many new accounts, from this IP or overall.'),
          },
        },
      },
      '/auth/app/start': {
        post: {
          tags: ['Account'],
          summary: 'Sign in an app, approved from the email',
          description:
            'Emails a code to type into the app, and a link to approve it from another device by picking the number the app shows (returned here). ' +
            'Send the anonymous token (if the app has one) as `Authorization: Bearer` to keep its setup. Then poll `/auth/app/poll`. ' +
            'One email per address per minute; a request lasts 15 minutes.',
          operationId: 'appStart',
          requestBody: jsonBody(
            { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' }, name: { type: 'string', maxLength: 40 } } },
            { email: 'you@u.nus.edu', name: 'MacBook Air' },
          ),
          responses: {
            '201': ok({
              type: 'object',
              properties: { request: { type: 'string' }, poll: { type: 'string' }, match: { type: 'integer', example: 47 }, expires: { type: 'string', format: 'date-time' } },
            }),
            '400': errorResponse('Not an email address.'),
            '409': errorResponse('This device is already signed in.'),
            '429': errorResponse('An email went to this address in the last minute, too many attempts, or too many sign-in emails for everyone this minute.'),
          },
        },
      },
      '/auth/app/poll': {
        post: {
          tags: ['Account'],
          summary: 'Wait for the approval',
          description:
            'Every 3 seconds while the app shows the number. `approved` comes once, with the token; after that the request is spent. ' +
            '`outcome` says what happened to the accounts; `choose` means both this device and the account have a setup, and the app should ask which to keep and call `/auth/app/merge`.',
          operationId: 'appPoll',
          requestBody: jsonBody({ type: 'object', required: ['request', 'poll'], properties: { request: { type: 'string' }, poll: { type: 'string' } } }),
          responses: {
            '200': ok({
              type: 'object',
              required: ['status'],
              properties: {
                status: { type: 'string', enum: ['pending', 'approved', 'denied', 'expired'] },
                token: { type: 'string' },
                email: { type: 'string' },
                outcome: { type: 'string', enum: ['created', 'added-email', 'signed-in', 'moved-setup', 'choose'] },
              },
            }),
          },
        },
      },
      '/auth/app/code': {
        post: {
          tags: ['Account'],
          summary: 'Confirm with the code from the email',
          description:
            'The 6-character code from the `/auth/app/start` email, typed into the app. Right, it answers like an approved poll, with the token. ' +
            'Five wrong codes end the request. The link in the same email (choosing the number) is the alternative.',
          operationId: 'appCode',
          requestBody: jsonBody(
            { type: 'object', required: ['request', 'poll', 'code'], properties: { request: { type: 'string' }, poll: { type: 'string' }, code: { type: 'string' } } },
          ),
          responses: {
            '200': ok({ type: 'object', properties: { status: { type: 'string', enum: ['approved'] }, token: { type: 'string' }, email: { type: 'string' }, outcome: { type: 'string' } } }),
            '400': errorResponse('Wrong code (`status: pending`), too many wrong codes (`denied`), or an old request (`expired`).'),
          },
        },
      },
      '/auth/app/merge': {
        post: {
          tags: ['Account'],
          summary: 'Keep one setup after signing in',
          description:
            "After a `choose` outcome, with the new token as the session: `keep: 'device'` replaces the account's setup with the one " +
            "from the old anonymous account (`anon`, its token); `keep: 'account'` keeps the account's. The anonymous account is deleted either way.",
          operationId: 'appMerge',
          security: [{ bearer: [] }],
          requestBody: jsonBody(
            { type: 'object', required: ['anon', 'keep'], properties: { anon: { type: 'string' }, keep: { type: 'string', enum: ['account', 'device'] } } },
          ),
          responses: {
            '200': ok({ type: 'object', properties: { ok: { type: 'boolean' }, profile: { type: 'object' } } }),
            '400': errorResponse('`anon` is not an anonymous account.'),
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
            '`Authorization: Bearer <token>` on `/me` routes. It lasts until it is revoked on the account page. Codes work once, for 10 minutes. The account’s owner is emailed to say a device was added.',
          operationId: 'pair',
          requestBody: jsonBody(
            { type: 'object', required: ['code'], properties: { code: { type: 'string' }, name: { type: 'string', maxLength: 40, description: 'Shown in the device list.' } } },
            { code: 'K7QX4M', name: 'Pixel 8' },
          ),
          responses: {
            '200': ok({ type: 'object', required: ['token'], properties: { token: { type: 'string' } } }),
            '400': errorResponse('Wrong or expired code.'),
            '429': errorResponse('Too many attempts from this IP, or too many pairing attempts for everyone this minute.'),
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
            '429': errorResponse('Too many attempts from this IP, or too many pairing attempts for everyone this minute.'),
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
            '- no classes today, or none left to plan: `mode: free`, nothing to catch (departures near you are on `/me/nearby`)\n' +
            '- outside your day hours (default 06:00-18:00, stretched for early or late classes): `mode: rest`, no bus\n\n' +
            'The response also carries your favourites (`places`), so a widget can show them as buttons. ' +
            '`card` has every line worded for display (the headline `title`, the `heading` above it, the trip as steps in `journey`), and `remindAt`, when to post the leave reminder: show the strings as they are, and count down only to the times given.',
          operationId: 'meNext',
          security: [{ bearer: [] }, { cookie: [] }],
          parameters: [
            ...coordParams,
            { name: 'place', in: 'query', description: 'Key of a favourite (one of `places`).', schema: { type: 'string' }, example: 'mrt' },
            { name: 'to', in: 'query', description: 'Any stop code or NUSMods venue code.', schema: { type: 'string' }, example: 'COM3' },
          ],
          responses: { '200': ok({ $ref: '#/components/schemas/MeAnswer' }), '401': errorResponse('No valid session.') },
        },
      },
      '/me/nearby': {
        get: {
          tags: ['Account'],
          summary: 'Departures near you',
          description:
            'Upcoming buses at up to three stops within walking range, nearest first, plus the nearest stop\'s twin ' +
            '(across the road, or a stop easily mistaken for it) when it isn\'t one of them. `opposite` is each stop\'s twin, if it has one. Each departure has its service\'s `color`. Without coordinates, uses your home.',
          operationId: 'meNearby',
          security: [{ bearer: [] }, { cookie: [] }],
          parameters: [...coordParams, stoppedParam],
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                stops: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      stop: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' }, longName: { type: 'string' } } },
                      opposite: { type: ['string', 'null'] },
                      oppositeAcross: { type: 'boolean' },
                      oppositeName: { type: ['string', 'null'] },
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
      '/me/day': {
        get: {
          tags: ['Account'],
          summary: "Today's timeline",
          description:
            'Each of today\'s classes with where you set off from and its leave-by (an estimate hours ahead), the trips home in long gaps and after the ' +
            'last class, and where each stands: `done`, `now`, `next`, `later` or `skipped`. A class you are on the bus to has `onBus` (`svc`, `off`, `arrive`) ' +
            'in place of a leave-by. Anything not done yet is `removable`: POST /me/signal `{kind: "skipped", trip: key}` takes it off today (a class, ' +
            'a usual time, a one-off, or a trip home, which then means staying), `reset` puts it back; entries taken off are not listed. ' +
            'With `lat` and `lon`, the next class is planned from there, as GET /me/next plans it, so the two give the same leave-by; later ' +
            'classes are planned from the class or home before them. Clients cache it for the day. `note` says why a day has no classes.',
          operationId: 'meDay',
          security: [{ bearer: [] }, { cookie: [] }],
          parameters: [...coordParams],
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                date: { type: 'string' },
                dayStart: { type: 'string' },
                dayEnd: { type: 'string' },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['kind', 'key', 'label', 'title', 'line', 'status', 'from', 'fromName', 'to', 'toName', 'startsAt', 'endsAt', 'removable'],
                    properties: {
                      kind: { type: 'string', enum: ['class', 'home'] },
                      key: { type: 'string', example: '4:600:UTOWN', description: 'The trip’s key, for POST /me/signal.' },
                      label: { type: 'string' },
                      title: { type: 'string', example: 'Home, from UTown', description: 'The row’s first line: the class, or "Home, from X" (Chinese "回家，从 X 出发").' },
                      line: {
                        type: ['string', 'null'],
                        example: 'Leave by ~09:38 · D2 from PGP',
                        description:
                          'The row’s second line: the leave-by and how ("Leave by ~09:38 · D2 from PGP", "Leave by 13:39 · walk", with "~5 min late" when it will be), the bus you are on ("On the D2 · off at UTown · arrive 09:52"), or "Not going". Null once done, and with nothing to say yet. Show it as it is.',
                      },
                      status: { type: 'string', enum: ['done', 'now', 'next', 'later', 'skipped'] },
                      from: { type: ['string', 'null'] },
                      fromName: { type: ['string', 'null'] },
                      to: { type: 'string' },
                      toName: { type: 'string' },
                      startsAt: { type: 'string', format: 'date-time' },
                      endsAt: { type: ['string', 'null'], format: 'date-time' },
                      venue: { type: 'string' },
                      leave: { type: ['object', 'null'], description: 'As `leave` on GET /me/next.' },
                      onBus: { type: ['object', 'null'], properties: { svc: { type: 'string' }, off: { type: ['string', 'null'] }, arrive: { type: ['string', 'null'], format: 'date-time' } } },
                      timing: { type: ['object', 'null'], description: 'As `timing` on GET /me/next.' },
                      removable: { type: 'boolean' },
                    },
                  },
                },
                note: { type: ['string', 'null'] },
              },
            }),
          },
        },
      },
      '/me/signal': {
        post: {
          tags: ['Account'],
          summary: 'Say what happened on the trip',
          description:
            'What happened on a trip, or a plan for today. Cards offer only plans: `skipped` (not going today), `away` ("Not on campus today", ' +
            'on an idle trip: every trip left today, not counted as outcomes) and `back` (undoes it), and `reset` (undo). Nothing asks what ' +
            'happened: no answer is taken as on the planned bus a few minutes after it leaves, and the phone\'s location ' +
            'corrects it. `boarded`, `missed`, `left` and `arrived` still work, for older apps. `trip` is the key from a card action ' +
            'or /me/day; without it, the trip in progress. Recorded for the day on every device, and answered with the new `/me/next`. Deleted at the ' +
            'end of the day. During a trip an app may send a `location` every 20 seconds or so, with `speed` (m/s) and `acc` (metres) when it has ' +
            'them; only what it means is kept: waiting at the stop and then moving at bus speed along its road is taken as `boarded` (with the plate ' +
            'of the bus, whose arrival at your stop then comes from the feed), still at the stop or at home a few minutes after the bus left, or ' +
            'standing still off the road of the bus you were taken to be on, as `missed`, and reaching the stop you get off at as `arrived` ' +
            '(`card.detected`). What was detected, and "Not going", is kept 35 days as the trip\'s outcome (in the export, deleted with the account); ' +
            'repeated misses or skips produce a `card.suggestion`. A ride seen from start to end is kept, without who or where, as a measured ride time.',
          operationId: 'meSignal',
          security: [{ bearer: [] }, { cookie: [] }],
          requestBody: jsonBody(
            {
              type: 'object',
              required: ['kind'],
              properties: {
                kind: { type: 'string', enum: ['boarded', 'missed', 'skipped', 'left', 'arrived', 'location', 'reset', 'away', 'back'] },
                trip: { type: 'string' },
                lat: { type: 'number' },
                lon: { type: 'number' },
                speed: { type: 'number', description: 'Metres per second, with a location.' },
                acc: { type: 'number', description: 'Accuracy in metres, with a location.' },
              },
            },
            { kind: 'boarded', trip: '4:600:UTOWN' },
          ),
          responses: {
            '200': ok({ type: 'object', description: 'The same as GET /me/next.' }),
            '400': errorResponse('Unknown kind.'),
            '409': errorResponse('No trip in progress to say that about.'),
            '503': errorResponse('Trip tracking is not available.'),
          },
        },
      },
      '/me/push': {
        post: {
          tags: ['Account'],
          summary: 'Register this device for push',
          description:
            "An app sends its Firebase Cloud Messaging token; the web app its Web Push subscription (`PushSubscription.toJSON()`, subscribed with the key from GET /me/push/key). " +
            "When the trip's phase changes, an app gets a data message `{kind: 'card', phase}` and should fetch `/me/next`. " +
            'The web app gets the same as an encrypted payload `{kind, phase, urgent}`, only when there is something to show. ' +
            "The week before a semester starts, a device whose account imported an older semester's timetable gets `{kind: 'term', title, body, zhTitle, zhBody}`, a notification to show as it is. " +
            'A push address lives on one session; one the push service no longer knows is dropped.',
          operationId: 'mePushRegister',
          security: [{ bearer: [] }, { cookie: [] }],
          requestBody: jsonBody(
            {
              type: 'object',
              properties: {
                token: { type: 'string', maxLength: 4096 },
                subscription: { type: 'object', required: ['endpoint', 'keys'], properties: { endpoint: { type: 'string', format: 'uri' }, keys: { type: 'object', properties: { p256dh: { type: 'string' }, auth: { type: 'string' } } } } },
              },
            },
            { token: 'fcm-registration-token' },
          ),
          responses: {
            '200': ok({ type: 'object', properties: { ok: { type: 'boolean' } } }),
            '400': errorResponse('No token, or a subscription that is not an https endpoint with keys.'),
            '503': errorResponse('A subscription, but web push is not set up on this server.'),
          },
        },
        delete: {
          tags: ['Account'],
          summary: 'Stop push to this device',
          operationId: 'mePushForget',
          security: [{ bearer: [] }],
          responses: { '200': ok({ type: 'object', properties: { ok: { type: 'boolean' } } }) },
        },
      },
      '/me/push/key': {
        get: {
          tags: ['Account'],
          summary: 'Web Push public key',
          description: "The server's VAPID public key (uncompressed P-256, base64url): the web app's `applicationServerKey`.",
          operationId: 'mePushKey',
          security: [{ bearer: [] }, { cookie: [] }],
          responses: { '200': ok({ type: 'object', properties: { key: { type: 'string' } } }), '503': errorResponse('Web push is not set up on this server.') },
        },
      },
      '/me/choice': {
        post: {
          tags: ['Account'],
          summary: 'Accept or turn down a suggestion',
          description:
            "`id` from `card.suggestion` with `choice: accept` or `dismiss`; or `trip` and `pref` (`earlier`: leave one bus earlier for that class; " +
            '`quiet`: no reminders for it) with `choice: undo`. A suggestion turned down is not offered again for 30 days.',
          operationId: 'meChoice',
          security: [{ bearer: [] }, { cookie: [] }],
          requestBody: jsonBody(
            {
              type: 'object',
              required: ['choice'],
              properties: {
                id: { type: 'string' },
                trip: { type: 'string' },
                pref: { type: 'string', enum: ['earlier', 'quiet'] },
                choice: { type: 'string', enum: ['accept', 'dismiss', 'undo'] },
              },
            },
            { id: 'earlier:4:600:UTOWN', choice: 'accept' },
          ),
          responses: { '200': ok({ type: 'object', description: 'ok, and `choices` as in GET /me/choices.' }), '400': errorResponse('No such suggestion or choice.') },
        },
      },
      '/me/notice': {
        get: {
          tags: ['Account'],
          summary: 'The new semester’s reminder',
          description:
            'The week before a semester starts, the reminder to import its timetable, for an account whose timetable is from an earlier semester; otherwise null. The Android app fetches it when a push says only `kind: term`, so the words do not travel through Firebase. Both languages, unless the account chose one in Settings.',
          operationId: 'meNotice',
          security: [{ bearer: [] }, { cookie: [] }],
          responses: {
            '200': ok(
              {
                type: 'object',
                properties: {
                  notice: {
                    type: ['object', 'null'],
                    properties: { title: { type: 'string' }, body: { type: 'string' }, zhTitle: { type: 'string' }, zhBody: { type: 'string' } },
                  },
                },
              },
              { notice: { title: 'Sem 1 2026/27 starts Mon 10 Aug', body: 'Import your new timetable from NUSMods, so your plans are right from the first day.', zhTitle: '2026/27 第 1 学期将于 8月10日（周一）开始', zhBody: '从 NUSMods 导入新课表，让第一天起的行程安排都准确无误。' } },
            ),
            '401': errorResponse('No valid session.'),
          },
        },
      },
      '/me/choices': {
        get: {
          tags: ['Account'],
          summary: 'Trip choices',
          description: 'Classes you leave one bus earlier for, or get no reminders for, and whether the question is muted.',
          operationId: 'meChoices',
          security: [{ bearer: [] }, { cookie: [] }],
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                choices: { type: 'array', items: { type: 'object', properties: { trip: { type: 'string' }, pref: { type: 'string', enum: ['earlier', 'quiet'] }, label: { type: ['string', 'null'] }, since: { type: 'string', format: 'date-time' } } } },
                history: { type: 'integer', description: 'Trips in the history (the last 35 days), which DELETE /me/history clears.' },
              },
            }),
          },
        },
      },
      '/me/history': {
        delete: {
          tags: ['Account'],
          summary: 'Clear trip history',
          description:
            'Forgets what happened on each trip (caught, missed, skipped or no answer; kept 35 days otherwise). Nothing is suggested from the old trips, and a muted question is asked again. Choices already made stay; undo those with POST /me/choice.',
          operationId: 'meClearHistory',
          security: [{ bearer: [] }, { cookie: [] }],
          responses: { '200': ok({ type: 'object', properties: { ok: { type: 'boolean' }, cleared: { type: 'integer', description: 'Trips forgotten.' } } }) },
        },
      },
      '/me/feedback': {
        post: {
          tags: ['Account'],
          summary: 'Report a wrong answer',
          description:
            'Sends the answer you were looking at, with a note saying what was wrong, for checking against what the buses did. Only for an account with an email (signed in), so the operator can reply. Kept with your account for a year (in the export, deleted with it); the note alone is emailed to the operator, without your address or the answer. Up to ten a day.',
          operationId: 'sendFeedback',
          security: [{ bearer: [] }, { cookie: [] }],
          requestBody: jsonBody(
            {
              type: 'object',
              required: ['platform', 'note'],
              properties: {
                kind: { type: 'string', enum: ['wrong', 'other'], default: 'wrong' },
                note: { type: 'string', minLength: 1, maxLength: 1000, description: 'What was wrong, or what you would like. Required.' },
                platform: { type: 'string', enum: ['android', 'mac', 'web'] },
                appVersion: { type: 'string', maxLength: 20 },
                context: { type: 'object', description: 'The answer as shown (a /me/next response), up to 16 KB.' },
              },
            },
            { kind: 'wrong', note: 'The D2 never came', platform: 'web', context: { label: 'D2 · 4 min' } },
          ),
          responses: {
            '201': ok({ type: 'object', properties: { ok: { type: 'boolean' }, id: { type: 'string' } } }),
            '400': errorResponse('Missing or invalid field (an empty note, too); the message names it.'),
            '401': errorResponse('No valid session.'),
            '403': errorResponse('An anonymous account: sign in with an email first.'),
            '429': errorResponse('Ten reports already today.'),
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
      '/me/once': {
        post: {
          tags: ['Account'],
          summary: 'Add a one-off trip',
          description:
            '"Science library at 14:00 today": `place` (a favourite\'s key) or `to` (a stop, place or room code), `atMin` (minutes past midnight, Singapore time), and optionally `label` ' +
            'and `date` (today by default, up to a week ahead). Kept in the profile\'s `once` and planned like a class that day, with its leave-by, ' +
            'question and "Not going". Answers with the new /me/next.',
          operationId: 'meOnce',
          security: [{ bearer: [] }, { cookie: [] }],
          requestBody: jsonBody(
            { type: 'object', required: ['atMin'], properties: { place: { type: 'string' }, to: { type: 'string' }, atMin: { type: 'integer' }, label: { type: 'string' }, date: { type: 'string', format: 'date' } } },
            { to: 'CLB', atMin: 840, label: 'Science library' },
          ),
          responses: { '200': ok({ type: 'object', description: 'The same as GET /me/next.' }), '400': errorResponse('Unknown place, a time already past, or too many.') },
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
      '/me': {
        get: {
          tags: ['Account'],
          summary: 'Who you are signed in as',
          description:
            'The first thing every page and app asks. `kind` is how this request signed in: a browser (`web`) or an app (`device`). `needsReimport` (with `reimportReason`) says the timetable is from an old term or semester. ' +
            '`onboarding` is the first-time setup step to show, or null. In a browser it also keeps the session going.',
          operationId: 'me',
          security: [{ bearer: [] }, { cookie: [] }],
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                email: { type: ['string', 'null'] },
                anonymous: { type: 'boolean', description: 'No email yet: an app’s first launch, or "Use terminus without an email".' },
                kind: { type: 'string', enum: ['web', 'device'] },
                needsReimport: { type: 'boolean' },
                reimportReason: { type: ['string', 'null'] },
                term: { type: ['string', 'null'], example: 'Sem 1 2026/27' },
                onboarding: { type: ['string', 'null'] },
              },
            }),
            '401': errorResponse('No valid session.'),
          },
        },
        delete: {
          tags: ['Account'],
          summary: 'Delete the account',
          description:
            'Deletes the account and everything kept for it, today’s trip included, and signs out every device. From the account page; an account without an email (which has no account page) can delete itself from its app.',
          operationId: 'deleteMe',
          security: [{ bearer: [] }, { cookie: [] }],
          responses: {
            '200': ok({ type: 'object', properties: { ok: { type: 'boolean' } } }),
            '401': errorResponse('No valid session.'),
            '403': errorResponse('An account with an email: delete it from the account page.'),
          },
        },
      },
      '/me/export': {
        get: {
          tags: ['Account'],
          summary: 'Download your data',
          description: 'Everything kept for the account, as a JSON file: the account and its dates, the profile, devices (with their app, version and push address), API keys (names only), feedback, trip outcomes and choices, sign-in requests still waiting, and today’s trip.',
          operationId: 'meExport',
          security: [{ bearer: [] }, { cookie: [] }],
          responses: { '200': ok({ type: 'object' }), '401': errorResponse('No valid session.') },
        },
      },
      '/me/sessions': {
        delete: {
          tags: ['Account'],
          summary: 'Sign out everywhere',
          description: 'Ends every browser session and removes every device, this browser included. From the account page only.',
          operationId: 'endSessions',
          security: [{ cookie: [] }],
          responses: {
            '200': ok({ type: 'object', properties: { ok: { type: 'boolean' }, ended: { type: 'integer', description: 'How many sessions and devices were signed out.' } } }),
            '401': errorResponse('No valid session.'),
            '403': errorResponse('Not from the account page.'),
          },
        },
      },
      '/me/pair-code': {
        post: {
          tags: ['Account'],
          summary: 'Make a pairing code',
          description: 'A 6-character code for `/pair`, shown on the account page with its QR code. It works once, for 10 minutes. Needs an account with an email.',
          operationId: 'pairCode',
          security: [{ bearer: [] }, { cookie: [] }],
          responses: {
            '200': ok({ type: 'object', properties: { code: { type: 'string', example: 'K7QX4M' }, expires: { type: 'integer', description: 'Epoch milliseconds.' } } }),
            '401': errorResponse('No valid session.'),
            '403': errorResponse('The account has no email.'),
          },
        },
      },
      '/me/keys/{id}': {
        delete: {
          tags: ['Account'],
          summary: 'Revoke an API key',
          description: 'From the account page only. The key stops working at once.',
          operationId: 'revokeKey',
          security: [{ cookie: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, description: 'The `id` from `GET /me/keys`.', schema: { type: 'string' } }],
          responses: {
            '200': ok({ type: 'object', properties: { ok: { type: 'boolean' } } }),
            '403': errorResponse('Not from the account page.'),
            '404': errorResponse('No such key.'),
          },
        },
      },
      '/me/devices': {
        get: {
          tags: ['Account'],
          summary: 'Your devices',
          description: 'The apps signed in to the account. `current` is the device asking.',
          operationId: 'listDevices',
          security: [{ bearer: [] }, { cookie: [] }],
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                devices: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      name: { type: ['string', 'null'] },
                      platform: { type: ['string', 'null'], example: 'android' },
                      created: { type: 'integer' },
                      lastSeen: { type: 'integer' },
                      current: { type: 'boolean' },
                    },
                  },
                },
              },
            }),
            '401': errorResponse('No valid session.'),
          },
        },
      },
      '/me/devices/{id}': {
        delete: {
          tags: ['Account'],
          summary: 'Remove a device',
          description: 'Signs the device out. Needs an account with an email.',
          operationId: 'removeDevice',
          security: [{ bearer: [] }, { cookie: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, description: 'The `id` from `GET /me/devices`.', schema: { type: 'string' } }],
          responses: {
            '200': ok({ type: 'object', properties: { ok: { type: 'boolean' } } }),
            '403': errorResponse('The account has no email.'),
            '404': errorResponse('No such device.'),
          },
        },
      },
      '/auth/config': {
        get: {
          tags: ['Account'],
          summary: 'What the sign-in form needs',
          description: 'The Turnstile site key when the human check is on, or null.',
          operationId: 'authConfig',
          security: [],
          responses: { '200': ok({ type: 'object', properties: { turnstileSiteKey: { type: ['string', 'null'] } } }) },
        },
      },
      '/auth/verify': {
        get: {
          tags: ['Account'],
          summary: 'The sign-in link',
          description:
            'Where the link in the `/auth/login` email goes. An HTML page naming the account, with a button that posts the form below; opening the link spends nothing, because mail scanners open every link.',
          operationId: 'verifyPage',
          security: [],
          parameters: [{ name: 't', in: 'query', required: true, description: 'The token from the email.', schema: { type: 'string' } }],
          responses: { '200': { description: 'The sign-in page.', content: { 'text/html': {} } }, '400': { description: 'The link has expired or was used.', content: { 'text/html': {} } } },
        },
        post: {
          tags: ['Account'],
          summary: 'Sign in with the link',
          description: 'The page’s form. Spends the token, sets the web session cookie and goes to the account page. Only from the site’s own pages.',
          operationId: 'verify',
          security: [],
          requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', required: ['t'], properties: { t: { type: 'string' }, next: { type: 'string', enum: ['app'] } } } } } },
          responses: {
            '303': { description: 'Signed in: on to the account page.' },
            '400': { description: 'The link has expired or was used.', content: { 'text/html': {} } },
            '403': errorResponse('The form was posted from another site.'),
          },
        },
      },
      '/auth/approve': {
        get: {
          tags: ['Account'],
          summary: 'Approve an app’s sign-in',
          description: 'Where the link in the `/auth/app/start` email goes. An HTML page asking for the number the app shows, and a "This wasn’t me" button.',
          operationId: 'approvePage',
          security: [],
          parameters: [{ name: 'r', in: 'query', required: true, description: 'The request from the email.', schema: { type: 'string' } }],
          responses: { '200': { description: 'The approval page.', content: { 'text/html': {} } }, '400': { description: 'The request has expired.', content: { 'text/html': {} } } },
        },
        post: {
          tags: ['Account'],
          summary: 'Pick the number',
          description: 'The page’s form: the right number approves the app’s sign-in (its next `/auth/app/poll` gets the token); a wrong one, or `none`, cancels it. Only from the site’s own pages.',
          operationId: 'approve',
          security: [],
          requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', required: ['r', 'n'], properties: { r: { type: 'string' }, n: { type: 'string', description: 'The number picked, or `none`.' } } } } } },
          responses: {
            '200': { description: 'Approved, or cancelled with `none`.', content: { 'text/html': {} } },
            '400': { description: 'The wrong number (the sign-in is cancelled), or the request has expired.', content: { 'text/html': {} } },
            '403': errorResponse('The form was posted from another site.'),
          },
        },
      },
      '/auth/logout': {
        post: {
          tags: ['Account'],
          summary: 'Sign out',
          description: 'Ends this session (a browser’s, or a device token) and clears the cookie.',
          operationId: 'logout',
          security: [{ bearer: [] }, { cookie: [] }],
          responses: { '200': ok({ type: 'object', properties: { ok: { type: 'boolean' } } }), '403': errorResponse('The form was posted from another site.') },
        },
      },
      '/docs': {
        get: {
          tags: ['Service'],
          summary: 'This documentation',
          description: 'The HTML page that renders `/openapi.json`.',
          operationId: 'docs',
          security: [],
          responses: { '200': { description: 'The documentation page.', content: { 'text/html': {} } } },
        },
      },
      '/openapi.json': {
        get: {
          tags: ['Service'],
          summary: 'This description',
          description: 'The OpenAPI 3.1 description of the API, with `servers` set to the site that served it.',
          operationId: 'openapi',
          security: [],
          responses: { '200': ok({ type: 'object' }) },
        },
      },
      '/admin/stats': {
        get: {
          tags: ['Service'],
          summary: 'The operator dashboard’s data',
          description: 'Counts of accounts, devices and feedback, the feed’s state and recent incidents, and (when configured) answers and errors per day. Answers 404 without the operator token.',
          operationId: 'adminStats',
          security: [{ operator: [] }],
          responses: { '200': ok({ type: 'object' }), '404': errorResponse('No operator token, or the wrong one.') },
        },
      },
      '/timelapse/days': {
        get: {
          tags: ['Service'],
          summary: 'Recorded days of shuttles, for the timelapse',
          description:
            'The days the timelapse recorder has kept, newest first: closed days from storage, and today’s while it records. `recording` says whether the recorder is switched on and what it is doing today. Needs the operator token, or the timelapse token (which opens these two routes and nothing else), in `x-health-token`: answers 404 without one.',
          operationId: 'timelapseDays',
          security: [{ operator: [] }],
          responses: {
            '200': ok(
              {
                type: 'object',
                required: ['days', 'recording'],
                properties: {
                  days: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['date', 'closed'],
                      properties: {
                        date: { type: 'string', format: 'date', description: 'The Singapore date the day’s window opened on.' },
                        closed: { type: 'boolean', description: 'true once the window closed and the day was written to storage; false for today, still recording.' },
                        bytes: { type: ['integer', 'null'], description: 'The stored file’s size; null while recording.' },
                        samples: { type: ['integer', 'null'], description: 'Readings so far, while recording; null once closed.' },
                      },
                    },
                  },
                  recording: {
                    type: 'object',
                    required: ['date', 'enabled', 'state', 'samples'],
                    properties: {
                      date: { type: 'string', format: 'date' },
                      enabled: { type: 'boolean', description: 'The kill switch: KV config:timelapse, else the TIMELAPSE_ENABLED var.' },
                      state: { type: 'string', enum: ['idle', 'polling', 'resting', 'off', 'done'] },
                      samples: { type: 'integer' },
                    },
                  },
                },
              },
              { days: [{ date: '2026-10-07', closed: false, bytes: null, samples: 1520 }, { date: '2026-10-06', closed: true, bytes: 412_903, samples: null }], recording: { date: '2026-10-07', enabled: true, state: 'polling', samples: 1520 } },
            ),
            '404': errorResponse('No operator token, or the wrong one.'),
          },
        },
      },
      '/timelapse/days/{date}': {
        get: {
          tags: ['Service'],
          summary: 'One recorded day of shuttles',
          description:
            'The day’s readings as one gzipped JSON file: every service’s buses about every 30 s, as service, number plate, position (whole steps of 1/q degree from `origin`) and metres along the route line, with the route lines and stops they were measured on. Times are deltas from `t0`. A closed day never changes and is cached for a year; today’s is built from what the recorder holds so far and is not cached. The timelapse page (/admin/timelapse/) reads it. Needs the operator token or the timelapse token.',
          operationId: 'timelapseDay',
          security: [{ operator: [] }],
          parameters: [{ name: 'date', in: 'path', required: true, description: 'A Singapore date, YYYY-MM-DD.', example: '2026-10-06', schema: { type: 'string', format: 'date' } }],
          responses: {
            '200': { description: 'The day file, gzipped JSON.', content: { 'application/gzip': {} } },
            '404': errorResponse('No operator token, or no recording for that day.'),
          },
        },
      },
      '/map/style.json': {
        get: {
          tags: ['Map'],
          summary: 'The street map’s style',
          description: 'A MapLibre style: the Protomaps light or dark map without its points of interest, with every URL on this site. Open, like the website.',
          operationId: 'mapStyle',
          security: [],
          parameters: [
            { name: 'theme', in: 'query', schema: { type: 'string', enum: ['light', 'dark'], default: 'light' } },
            { name: 'lang', in: 'query', description: 'Street and place names in English or Chinese.', schema: { type: 'string', enum: ['en', 'zh'], default: 'en' } },
          ],
          responses: { '200': ok({ type: 'object' }) },
        },
      },
      '/map/campus.pmtiles': {
        get: {
          tags: ['Map'],
          summary: 'The street map',
          description: 'A PMTiles extract around NUS. Read in parts with `Range` requests, as the PMTiles library does.',
          operationId: 'mapTiles',
          security: [],
          responses: {
            '200': { description: 'The whole file.', content: { 'application/vnd.pmtiles': {} } },
            '206': { description: 'The range asked for.', content: { 'application/vnd.pmtiles': {} } },
            '304': { description: 'Your copy is current (`If-None-Match`).' },
            '404': errorResponse('No street map uploaded yet.'),
            '429': errorResponse('Too many reads of parts not yet cached, from one IP. Wait for `Retry-After`.'),
          },
        },
      },
      '/map/fonts/{fontstack}/{range}.pbf': {
        get: {
          tags: ['Map'],
          summary: 'Map fonts',
          description: 'Glyphs for the map’s labels, as the style’s `glyphs` URL asks for them.',
          operationId: 'mapFont',
          security: [],
          parameters: [
            { name: 'fontstack', in: 'path', required: true, schema: { type: 'string', enum: ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'] } },
            { name: 'range', in: 'path', required: true, schema: { type: 'string' }, example: '0-255' },
          ],
          responses: { '200': { description: 'The glyphs.', content: { 'application/x-protobuf': {} } }, '404': errorResponse('No such font or range.') },
        },
      },
      '/map/sprites/v4/{sprite}': {
        get: {
          tags: ['Map'],
          summary: 'Map icons',
          description: 'The style’s sprite sheet and its index.',
          operationId: 'mapSprite',
          security: [],
          parameters: [{ name: 'sprite', in: 'path', required: true, schema: { type: 'string', enum: ['light.json', 'light.png', 'light@2x.json', 'light@2x.png', 'dark.json', 'dark.png', 'dark@2x.json', 'dark@2x.png'] } }],
          responses: { '200': { description: 'The sheet or its index.', content: { 'image/png': {}, 'application/json': {} } }, '404': errorResponse('Not uploaded.') },
        },
      },
      '/download/latest.json': {
        get: {
          tags: ['Downloads'],
          summary: 'The latest release',
          description: 'The version, and the file and SHA-256 of each app, as the apps’ update checks read it.',
          operationId: 'latest',
          security: [],
          responses: { '200': ok({ type: 'object' }), '404': errorResponse('No release yet.'), '503': errorResponse('Downloads are not set up.') },
        },
      },
      '/download/android': {
        get: {
          tags: ['Downloads'],
          summary: 'The Android app',
          description: 'The latest APK. The SHA-256 is in the `x-sha256` header.',
          operationId: 'downloadAndroid',
          security: [],
          parameters: [{ name: 'abi', in: 'query', description: 'A CPU type other than arm64.', schema: { type: 'string', enum: ['armeabi-v7a', 'x86_64'] } }],
          responses: { '200': { description: 'The APK.', content: { 'application/vnd.android.package-archive': {} } }, '404': errorResponse('No release yet.') },
        },
      },
      '/download/mac': {
        get: {
          tags: ['Downloads'],
          summary: 'The Mac app',
          description: 'The latest disk image. The SHA-256 is in the `x-sha256` header.',
          operationId: 'downloadMac',
          security: [],
          responses: { '200': { description: 'The disk image.', content: { 'application/x-apple-diskimage': {} } }, '404': errorResponse('No release yet.') },
        },
      },
      '/download/appcast.xml': {
        get: {
          tags: ['Downloads'],
          summary: 'The Mac app’s update feed',
          description: 'The Sparkle appcast the Mac app checks for updates.',
          operationId: 'appcast',
          security: [],
          responses: { '200': { description: 'The feed.', content: { 'application/xml': {} } }, '404': errorResponse('No release yet.') },
        },
      },
      '/download/releases/{version}/{file}': {
        get: {
          tags: ['Downloads'],
          summary: 'A release’s file',
          description: 'Any release’s APKs, disk image or zip, by version: `terminus-<version>.apk` (also `-armv7`, `-x86_64`), `.dmg` or `.zip`.',
          operationId: 'releaseFile',
          security: [],
          parameters: [
            { name: 'version', in: 'path', required: true, schema: { type: 'string' }, example: '2.0.4' },
            { name: 'file', in: 'path', required: true, schema: { type: 'string' }, example: 'terminus-2.0.4.apk' },
          ],
          responses: { '200': { description: 'The file.' }, '404': errorResponse('No such file.') },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key', description: 'A key from the account page (API keys). Starts with `tk_`.' },
        bearer: { type: 'http', scheme: 'bearer', description: 'An API key, or a device token from `/pair`.' },
        cookie: { type: 'apiKey', in: 'cookie', name: '__Host-tm_s', description: 'Set by signing in on the account page.' },
        operator: { type: 'apiKey', in: 'header', name: 'x-health-token', description: 'The operator token (HEALTH_TOKEN), for the dashboard.' },
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
            arrived: { type: 'boolean', description: 'Already at the destination (either side of the road), so there is no bus or countdown.' },
            leave: {
              type: ['object', 'null'],
              description:
                'The latest time to set off. On `/me/next` for a class, the latest that still gets you there on time; otherwise, for the bus in `departsAt`. ' +
                'When you will be late whatever you do, `at` is now, or, when the first bus waits for the service to start, when to leave for that one. Null or absent when you should go now. Once `at` has passed, show "Leave now".',
              required: ['at', 'estimated', 'svc', 'stop', 'board', 'arrive'],
              properties: {
                at: { type: 'string', format: 'date-time' },
                svc: { type: ['string', 'null'], description: 'The bus this time is for. For a class it can differ from the headline bus. Null when walking.' },
                stop: { type: ['string', 'null'], description: 'Where to board it, short name.' },
                board: { type: ['string', 'null'], format: 'date-time', description: 'When that bus leaves the stop. With `estimated`, when you reach the stop. Null when walking.' },
                arrive: { type: ['string', 'null'], format: 'date-time', description: 'When you get there by leaving at `at`: the venue for a class, otherwise the stop.' },
                note: { type: ['string', 'null'], description: 'Why the time is earlier than it could be, e.g. the bus is often busy then. Display verbatim.' },
                off: { type: 'string', description: 'Where to get off, when the bus only stops across the road from the destination (e.g. `Opp NUSS` for AS 5). `arrive` includes the walk back across. Absent otherwise.' },
                stopCode: { type: 'string', description: 'Stop code of `stop`. Absent when walking.' },
                offCode: { type: 'string', description: 'Stop code of `off`. Absent without a crossing.' },
                toStop: { type: 'string', example: 'UTown', description: 'Where you get off, short name: the destination stop this bus calls at (for a place with several stops, the one it calls at), or `off`. Absent when walking.' },
                paid: { type: 'boolean', enum: [true], description: 'The bus is a public one, with a fare. Absent for a shuttle.' },
                route: { type: 'string', description: 'For a public two-way service, its route in the graph (`151/1`), which `svc` (`151`) cannot name. Absent otherwise.' },
                estimated: { type: 'boolean', description: 'Based on the usual gap between buses, or on a timetable, rather than a live time. Show it with a `~`.' },
                stale: {
                  type: 'boolean',
                  enum: [true],
                  description: 'The bus time is from an older reading: live times a few minutes old, or the plan an earlier answer kept for this trip. Exact, but not live now: do not mark it live. Absent otherwise.',
                },
                walkS: { type: 'integer', description: 'Seconds on foot to `stop`. Absent when walking.' },
                rideS: { type: 'integer', description: 'Seconds on the bus. Absent when walking.' },
                endWalkS: {
                  type: 'integer',
                  description: 'Without a class to aim at: seconds on foot from where you get off to the place itself (a room, a building, a food court), which `arrive` does not count. A class’s `arrive` is already at its room. Absent for a stop.',
                },
              },
            },
            bus: {
              oneOf: [{ $ref: '#/components/schemas/BusLeg' }, { type: 'null' }],
              description: 'The headline bus as a leg: where, when, and how long the walk and the ride take. Absent when the answer is to walk or nothing runs.',
            },
            altBus: {
              oneOf: [{ $ref: '#/components/schemas/BusLeg' }, { type: 'null' }],
              description: 'The bus in `alt`, the same way.',
            },
            foot: {
              type: 'object',
              required: ['s', 'why'],
              description: 'The answer is to walk the whole way. Absent otherwise.',
              properties: {
                s: { type: 'integer', description: 'Seconds on foot to the place itself (a room, a building, a food court).' },
                why: { type: ['string', 'null'], description: 'Why not a bus ("D1 would be 16 min", "Services ended for the night"). Null for a short walk with nothing to board.' },
              },
            },
          },
        },
        JourneyBus: {
          type: 'object',
          required: ['svc', 'color', 'stop', 'board'],
          properties: {
            svc: { type: 'string' },
            color: { type: 'string', description: 'The service’s colour as painted on the bus, `#rrggbb`.' },
            stop: { type: 'string', description: 'Where to board, short name.' },
            board: { type: 'string', description: 'When it leaves ("4:05 PM", "~4:05 PM").' },
            paid: { type: 'boolean', enum: [true], description: 'A public bus, with a fare. Absent for a shuttle. Clients mark it, so the user knows there is a fare.' },
          },
        },
        BusLeg: {
          type: 'object',
          required: ['svc', 'stop', 'stopCode', 'walkS', 'rideS', 'board', 'arrive', 'estimated'],
          properties: {
            svc: { type: 'string' },
            stop: { type: 'string', description: 'Where to board, short name.' },
            stopCode: { type: 'string' },
            walkS: { type: 'integer', description: 'Seconds on foot to the stop.' },
            rideS: { type: 'integer', description: 'Seconds on the bus.' },
            board: { type: ['string', 'null'], format: 'date-time', description: 'When the bus leaves the stop. Null with no time.' },
            arrive: { type: ['string', 'null'], format: 'date-time', description: 'When you reach the destination stop. Null with no time.' },
            estimated: { type: 'boolean', description: 'Based on the usual gap between buses rather than a live time.' },
            off: { type: 'string', description: 'Where to get off, when the bus only stops across the road from the destination. Absent otherwise.' },
            toStop: { type: 'string', description: 'Where you get off, short name: the destination stop this bus calls at, or `off`.' },
            endWalkS: { type: 'integer', description: 'Seconds on foot from where you get off to the place itself (a room, a building, a food court), which `arrive` does not count. Absent for a stop.' },
            paid: { type: 'boolean', enum: [true], description: 'A public bus (95, 151, …), with a fare, unlike the free shuttle. Absent for a shuttle.' },
          },
        },
        Arrival: {
          type: 'object',
          required: ['svc', 'etaS', 'crowd', 'plate', 'berth'],
          properties: {
            svc: { type: 'string', example: 'D2' },
            etaS: { type: ['integer', 'null'], description: 'Seconds until arrival. `null` means no bus, never 0.' },
            crowd: { type: ['string', 'null'], enum: ['low', 'medium', 'high', null] },
            plate: { type: ['string', 'null'], example: 'PD726D', description: 'Null for a public bus: LTA does not publish plates.' },
            berth: { type: ['string', 'null'], description: 'The feed’s own code for the stop. At a terminus it tells the departing run from the terminating one; compare it, but don’t read meaning into its format. Null for a public bus.' },
            ends: { type: 'boolean', enum: [true], description: 'The bus ends its run at this stop and can’t be boarded here. Absent otherwise.' },
            scheduled: { type: 'boolean', enum: [true], description: 'The time is from the operator’s timetable, not a bus on the road (a public bus LTA reports as unmonitored). Absent for a live time.' },
          },
        },
        BoardRow: {
          type: 'object',
          required: ['svc', 'etaS', 'quality', 'ambiguousBerth', 'later', 'color', 'towards', 'crowd', 'endsAt', 'running', 'eta', 'laterText', 'toText'],
          properties: {
            svc: { type: 'string' },
            etaS: { type: ['integer', 'null'] },
            eta: {
              type: ['string', 'null'],
              example: '~6 min',
              description: '`etaS` in words, in the request’s language: "4 min", "now" under 45 seconds, and a `~` on a `scheduled` time ("~6 min", Chinese "约 6 分钟"). Null when `etaS` is. Show it as it is.',
            },
            laterText: {
              type: ['string', 'null'],
              example: 'then 12, ~20 min',
              description: 'The next few buses after this one, up to three, in whole minutes, each `scheduled` one marked `~`: "then 12, ~20 min" (Chinese "之后 12、约 20 分钟"). Null when `later` is empty.',
            },
            toText: {
              type: 'string',
              example: 'to Central Library, Prince George’s Park Foyer',
              description: '`towards` in words: "to A, B" (Chinese "经 A，开往 B"), "to A" with one name (Chinese "开往 A"), or "Ends here" (Chinese "本站为终点站") at the end of the line. A client that sets the next stop in bold finds it as `towards[0]`.',
            },
            quality: { $ref: '#/components/schemas/Quality' },
            ambiguousBerth: { type: 'boolean', description: 'True when the direction of this service at this stop could not be confirmed.' },
            paid: { type: 'boolean', enum: [true], description: 'A public bus, with a fare. Absent for a shuttle.' },
            later: {
              type: 'array',
              description: 'The buses after the one in `etaS`, soonest first, as far as the feed knows them (usually one more for a shuttle, up to two for a public bus). Each has its own quality: a timetabled one is `scheduled`.',
              items: {
                type: 'object',
                required: ['etaS', 'quality', 'eta'],
                properties: { etaS: { type: 'integer' }, quality: { $ref: '#/components/schemas/Quality' }, eta: { type: 'string', example: '~15 min', description: '`etaS` in words, as the row’s `eta`.' } },
              },
            },
            color: { type: ['string', 'null'], description: 'The colour of the service, as on the buses (#rrggbb). Null for a public bus.' },
            towards: {
              type: 'array',
              items: { type: 'string' },
              description: 'Where the service goes from this stop, by full name: the next stop, then the stop the route ends at (for a loop, the stop it started from). One name when they are the same, none at the end of the line. Place names stay English in every language.',
              example: ['Central Library', 'Prince George’s Park Foyer'],
            },
            crowd: { type: ['string', 'null'], enum: ['low', 'medium', 'high', null], description: 'How full the bus in `etaS` is, from the live feed. Null when it gives none, or there is no bus.' },
            endsAt: { type: ['string', 'null'], format: 'date-time', description: 'When the service stops running today. Null when its hours are not known.' },
            running: { type: 'boolean', description: 'False only on a row for a service outside its hours, listed with `?stopped=1`: no time (`etaS` null, `quality` `ended`), no crowding, after every running row.' },
            stopped: { type: 'string', enum: ['ended', 'notYet', 'noService'], description: 'Only when `running` is false: `ended` (it ran today and has finished), `notYet` (it starts later today) or `noService` (it does not run today; Sunday hours on a public holiday).' },
            resumesAt: { type: ['string', 'null'], format: 'date-time', description: 'Only when `running` is false: when it next starts, looking up to 8 days ahead. Null when no start is found.' },
          },
        },
        StopBoard: {
          type: 'object',
          required: ['stop', 'board', 'asOf', 'available'],
          properties: {
            stop: {
              type: 'object',
              required: ['code', 'name', 'longName', 'opposite', 'oppositeAcross', 'oppositeName'],
              properties: {
                code: { type: 'string' },
                name: { type: 'string' },
                longName: { type: 'string', description: 'The name in full (Yusof Ishak House for YIH), for where there is room for it.' },
                opposite: { type: ['string', 'null'], description: 'The code of the stop across the road, or one easily mistaken for it. Null when it has none.' },
                oppositeAcross: { type: 'boolean', description: 'True when `opposite` is across the road; false for a stop that is only near (Prince George’s Park and its Foyer), or none.' },
                oppositeName: { type: ['string', 'null'], description: 'The full name of `opposite`, null when there is none.' },
              },
            },
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
        Line: {
          type: 'object',
          required: ['svc', 'color', 'endsAt', 'running', 'stopped', 'resumesAt', 'stops', 'buses', 'available', 'asOf'],
          properties: {
            svc: { type: 'string' },
            color: { type: ['string', 'null'] },
            endsAt: { type: ['string', 'null'], format: 'date-time', description: 'When the service stops running today. Null when its hours are not known.' },
            running: { type: 'boolean', description: 'Whether the service is inside its hours now, as a board row’s `running` (unknown hours count as running).' },
            stopped: { type: ['string', 'null'], enum: ['ended', 'notYet', 'noService', null], description: 'Why it is not running, as on a board row. Null while it runs.' },
            resumesAt: { type: ['string', 'null'], format: 'date-time', description: 'When it next starts, as on a board row. Null while it runs, or when no start is found in 8 days.' },
            stops: {
              type: 'array',
              description: 'The stops in route order. A loop’s first stop is not listed again at its end.',
              items: {
                type: 'object',
                required: ['code', 'name', 'longName', 'services'],
                properties: {
                  code: { type: 'string' },
                  name: { type: 'string' },
                  longName: { type: 'string', description: 'The name in full (Yusof Ishak House for YIH), for where there is room for it.' },
                  services: { type: 'array', items: { type: 'string' }, description: 'The other shuttle services that call at this stop.' },
                },
              },
            },
            buses: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'plate', 'crowd', 'at', 'after'],
                properties: {
                  id: { type: 'string', description: 'The same as on `/buses`.' },
                  plate: { type: 'string' },
                  crowd: { type: ['string', 'null'], enum: ['low', 'medium', 'high', null] },
                  at: { type: ['integer', 'null'], description: 'The index in `stops` of the stop the bus is at; null between stops.' },
                  after: { type: ['integer', 'null'], description: 'Between stops: the index in `stops` of the stop it passed. It is on its way to the next one (the first, after a loop’s last). Null at a stop.' },
                },
              },
            },
            stop: {
              type: 'object',
              description: 'Only with `?stop=`.',
              required: ['code', 'index', 'row'],
              properties: {
                code: { type: 'string' },
                index: { type: 'integer', description: 'Its place in `stops`.' },
                row: { oneOf: [{ $ref: '#/components/schemas/BoardRow' }, { type: 'null' }], description: 'The service’s row on the stop’s board, as `/arrivals?stopped=1` gives it: a service outside its hours has a row with `running: false`.' },
              },
            },
            available: { type: 'boolean', description: 'False when the live feed could not be reached.' },
            asOf: { type: 'string', format: 'date-time' },
          },
        },
        Buses: {
          type: 'object',
          required: ['svc', 'color', 'buses', 'asOf', 'available', 'stale'],
          properties: {
            svc: { type: 'string' },
            color: { type: ['string', 'null'] },
            buses: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'plate', 'lat', 'lon', 'along', 'heading', 'moving', 'crowd', 'at', 'slot', 'stretch', 'nextStop'],
                properties: {
                  id: { type: 'string', description: 'Stable for a bus while it runs.' },
                  plate: { type: 'string', example: 'PD726D', description: 'The bus’s number plate, as painted on it.' },
                  lat: { type: 'number', description: 'Where to draw the bus: the stop’s own position when it is at a stop, else a point on its route line.' },
                  lon: { type: 'number' },
                  along: { type: 'number', description: 'Metres along the service’s route line in `/campus` (`routes[svc].line`) of that place (at a stop, the stop’s place on the line), so a map can move the bus along the road from one place to the next. It does not go back between answers, except past the start of a loop, or when a bus first placed on the wrong side of the road is put right.' },
                  heading: { type: ['integer', 'null'], description: 'The way the road runs there, the way the bus is going: degrees clockwise from north.' },
                  moving: { type: 'boolean' },
                  crowd: { type: ['string', 'null'], enum: ['low', 'medium', 'high', null] },
                  at: {
                    type: ['object', 'null'],
                    description: 'The stop the bus is at (within 40 metres of it along its route), or null between stops.',
                    properties: { code: { type: 'string' }, name: { type: 'string' } },
                  },
                  slot: { type: 'integer', minimum: 0, description: 'At a stop, its place among the buses there: 0 for the one in front, then 1, 2 behind it. 0 between stops.' },
                  stretch: {
                    type: ['object', 'null'],
                    description: 'Between stops, the part of its route line the bus is somewhere on: from the stop it passed (`last`) to its next stop, in metres along the line (`from`, `to`). Null at a stop.',
                    required: ['from', 'to', 'last'],
                    properties: {
                      from: { type: 'number' },
                      to: { type: 'number' },
                      last: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' } } },
                    },
                  },
                  nextStop: {
                    type: ['object', 'null'],
                    properties: { code: { type: 'string' }, name: { type: 'string' } },
                  },
                },
              },
            },
            asOf: { type: 'string', format: 'date-time' },
            available: { type: 'boolean' },
            stale: { type: 'boolean', description: 'True when the feed failed and these are the last positions known.' },
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
                  services: { type: 'array', items: { type: 'string' }, description: 'The services that stop here.' },
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
                  color: { type: 'string', description: "The service's colour, as on the buses." },
                  line: {
                    type: 'array',
                    items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
                    description: 'The path to draw, as [lon, lat] pairs (GeoJSON LineString coordinates).',
                  },
                  shaped: { type: 'boolean', description: 'True when `line` follows the roads (OpenStreetMap); false when it is straight lines between stops, because the stops changed since the road shapes were last made.' },
                },
              },
            },
            residences: {
              type: 'array',
              description: 'On-campus residences and the stops that serve each, for picking home stops: the common ones first, then by name. Outlines are not included.',
              items: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  name: { type: 'string' },
                  stops: { type: 'array', items: { type: 'string' } },
                  walkM: { type: 'integer', description: 'Metres on foot from the residence to its nearest stop (the first in `stops`).' },
                  walkMin: { type: 'integer', minimum: 1, example: 3, description: 'That walk in whole minutes at the normal pace (1.3 m/s), never under 1: what a picker shows beside the residence.' },
                  common: { type: 'boolean', description: 'Where most students live (PGP, UTown Residence). Pickers show these in their own group at the top.' },
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
            fullBusMargin: { type: 'boolean', default: true, description: 'Aim one bus earlier when the bus to wait for is often busy at that stop and time.' },
            publicBuses: { type: 'boolean', default: false, description: 'Count the public buses (95, 151, 96 and others) at the campus’s stops too, on `/me/next` and `/me/nearby`. They have a fare, so one is the answer only when it clearly saves time over the free shuttle, and its leg carries `paid: true`. Off until the user turns it on.' },
            seen: { type: 'array', items: { type: 'string' }, description: 'One-time screens already shown, e.g. `onboarding`.' },
            pinnedStops: { type: 'array', maxItems: 8, uniqueItems: true, default: [], items: { type: 'string' }, description: 'Stops pinned to the Buses tab, in the order to show them: shuttle stop codes, or LTA’s five-digit code for a public stop of its own. Repeats are dropped.' },
            homeWalkMin: { type: 'integer', minimum: 0, maximum: 30, default: 5, description: 'Minutes from home to your nearest home stop. Counts when a trip starts from home without a location, and as the least walk to your home stops when the location is inside the residence they serve (the lift and the stairs count, the outline cannot tell which floor you are on).' },
            lang: { type: 'string', enum: ['auto', 'en', 'zh'], default: 'auto', description: "The language terminus writes in: answers, cards, emails and errors. `auto` follows each request's `Accept-Language` (any `zh*` is Simplified Chinese); `?lang=en|zh` on a request overrides it, and a set `lang` here overrides both." },
            clock: { type: 'string', enum: ['auto', '12', '24'], default: 'auto', description: 'Clock times in answers and cards, 12-hour ("6:36 PM") or 24-hour ("18:36"). `auto` follows each request (`?h12=1` for 12-hour); `12` or `24` here overrides it, so every device shows the same.' },
            trips: { type: 'array', items: { $ref: '#/components/schemas/Trip' }, description: 'From the NUSMods import.' },
            manual: { type: 'array', items: { $ref: '#/components/schemas/Trip' }, description: 'Entered by hand. Kept on re-import.' },
            places: {
              type: 'array',
              maxItems: 12,
              description: 'Favourites: one-tap destinations. The apps set `label` to the name of what was picked (a stop, a food court, or a building\'s code).',
              items: {
                type: 'object',
                required: ['key', 'label', 'to'],
                properties: { key: { type: 'string', pattern: '^[a-z0-9-]{1,24}$' }, label: { type: 'string', maxLength: 24 }, to: { type: 'string' } },
              },
            },
            usual: {
              type: 'array',
              maxItems: 30,
              description: 'Favourites with a usual time ("Gym, Tuesdays 18:00"): each is a trip on that day like a class, arriving by `atMin`, then an hour there. One whose place is gone is ignored.',
              items: {
                type: 'object',
                required: ['place', 'day', 'atMin'],
                properties: { place: { type: 'string', description: 'A favourite\'s key.' }, day: { type: 'integer', minimum: 0, maximum: 6 }, atMin: { type: 'integer', minimum: 0, maximum: 1439 } },
              },
            },
            once: {
              type: 'array',
              maxItems: 10,
              description: 'One-off trips, planned like a class on their date only. Past dates are dropped on save. POST /me/once adds one.',
              items: {
                type: 'object',
                required: ['date', 'arriveByMin', 'to', 'label'],
                properties: { date: { type: 'string', format: 'date' }, arriveByMin: { type: 'integer', minimum: 0, maximum: 1439 }, to: { type: 'string' }, label: { type: 'string', maxLength: 60 } },
              },
            },
            share: { type: ['string', 'null'], description: 'The NUSMods share link last imported.' },
            limits: {
              type: 'object',
              readOnly: true,
              description: 'Sent with the profile (GET and PUT /me/profile, the import, the merge): the limits the server enforces, so an app’s fields and pickers stop where it does. Ignored when sent back.',
              required: ['pinnedStops', 'label', 'places', 'placeLabel', 'homeStops', 'homeWalkMin', 'trips', 'usual', 'once'],
              properties: {
                pinnedStops: { type: 'integer', example: 8, description: 'Most stops in `pinnedStops`.' },
                label: { type: 'integer', example: 60, description: 'Longest name of a class or a one-off trip, in characters.' },
                places: { type: 'integer', example: 12, description: 'Most favourites.' },
                placeLabel: { type: 'integer', example: 24, description: 'Longest name of a favourite, in characters.' },
                homeStops: { type: 'integer', example: 3, description: 'Most home stops.' },
                homeWalkMin: { type: 'object', properties: { min: { type: 'integer', example: 0 }, max: { type: 'integer', example: 30 } }, description: 'The range of `homeWalkMin`, inclusive.' },
                trips: { type: 'integer', example: 100, description: 'Most classes in `trips`, and in `manual`.' },
                usual: { type: 'integer', example: 30, description: 'Most usual times.' },
                once: { type: 'integer', example: 10, description: 'Most one-off trips.' },
              },
            },
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
                  enum: ['trip', 'nearby', 'rest', 'free'],
                  description:
                    '`rest` outside your day hours: no bus, and `detail` names your next class. Show a rest state, not a bus. ' +
                    '`free` on a day with no classes, or none left to plan (and for a new account with no timetable yet): nothing to catch, so no bus in the headline; `card.upcoming` has the next class.',
                },
                warning: {
                  type: ['string', 'null'],
                  example: 'Last D2 from UTown in 18 min',
                  description: 'On the way home near the end of service: the last bus is soon. Absent or null otherwise. Also in `card.warning`.',
                },
                card: {
                  type: 'object',
                  description:
                    'The answer worded for display, the same on every app: headline parts, the phase of the trip, `actions` (buttons), `warning`, and `notice`, ' +
                    'a line to show above the answer while NUS’s live bus times are down ("NUS’s live bus times have been down since 9:14 AM"), or null. Show its strings as they are.',
                  properties: {
                    kind: {
                      type: 'string',
                      enum: ['class', 'trip', 'nearby', 'rest', 'arrived', 'setup', 'free'],
                      description: 'What the card is: a class with a leave-by, any other trip, what is near you, resting outside your day, there already, nothing to start from (`setup`), or a day with nothing to catch (`free`).',
                    },
                    title: {
                      type: 'string',
                      example: 'D2 · 09:42',
                      description: 'The headline. With a bus to count down to, its service and departure as a clock time ("D2 · 09:42", "~09:42" for a timetable estimate, Chinese "约 09:42"), which stays true until the bus leaves; otherwise `label` as it is ("Walk · 8 min", "No classes today").',
                    },
                    heading: {
                      type: ['string', 'null'],
                      example: 'Next class · CS2030 @ COM1',
                      description: 'The small line above the card, from `dest.why`: "Next class · X", "Long gap · Home", "Heading home" or "Going to X" (Chinese "下一节课 · X", "空档较长 · 回家", "回家", "去 X"). Null with no destination (`nearby`, `rest`, `free`).',
                    },
                    remindAt: {
                      type: ['string', 'null'],
                      format: 'date-time',
                      example: '2026-08-27T01:31:40Z',
                      description:
                        'When to post the leave reminder: `leave.at` less five minutes (when the trip turns `due`). Null when there is none to post: reminders off for the trip (`remind` false), not a class, no leave-by, the trip under way or over (any phase but `idle` and `due`), or the class has started. ' +
                        'Schedule it on the device; at `leave.at` the reminder becomes "Leave now".',
                    },
                    staleAt: { type: ['string', 'null'], format: 'date-time', description: 'Dim the answer from this instant: the bus has gone, the plan has moved on, or it is 15 minutes old. Null: never on its own.' },
                    crowd: { type: ['string', 'null'], example: 'Crowding: medium', description: 'How full the headline bus is, in words.' },
                    quality: { type: ['string', 'null'], example: 'Timetable estimate', description: 'What is less than live about the times: "Timetable estimate", "Live times are a few minutes old", "No live data". Null when they are live.' },
                    leaveBy: { type: ['string', 'null'], example: 'Leave by ~09:36', description: 'The leave-by. Say "Leave now" once `leave.at` passes, except at the stop (phase `waiting`), where it is the bus to wait for ("D2 at 09:41"), shown as it is.' },
                    leaveVia: { type: ['string', 'null'], example: 'catch the 09:38 D2 at PGP', description: 'After the leave-by on trips that are not classes. A public bus is "95 ($)".' },
                    catch: { type: ['string', 'null'], example: 'Catch the ~09:42 R2 at PGP', description: 'Class only: the bus to catch, or "Walk there".' },
                    arrive: { type: ['string', 'null'], example: 'Arrive ~09:51 · 9 min early', description: 'Class only: when you get there and how early or late.' },
                    catchLine: { type: ['string', 'null'], description: 'Class only: `catch` and `arrive` on one line, for a widget or notification.' },
                    late: { type: 'boolean', description: 'Class only: the arrival misses the start.' },
                    goNow: { type: ['string', 'null'], example: 'Or go now: R2 at 09:06 · arrive 09:15', description: 'Class only: the headline bus, when it is not the one to wait for.' },
                    note: { type: ['string', 'null'], description: 'Class only: why the leave-by is earlier than it could be.' },
                    estimate: { type: ['string', 'null'], description: 'Class only: said under a leave-by that rests on the usual gap between buses.' },
                    phase: { type: 'string', enum: ['idle', 'due', 'heading', 'waiting', 'riding', 'missed', 'arrived'], description: 'Where the trip is. `idle` with no trip in progress.' },
                    phaseText: { type: ['string', 'null'], example: 'On your way', description: 'A few words on the phase, above the answer. Null when idle or there.' },
                    glance: {
                      type: 'string',
                      maxLength: 12,
                      example: 'D2 09:41',
                      description: 'For a watch face, the menu bar or a tile. Never a minute count, which would freeze while nothing refreshes: outside a trip, the headline bus and its clock time ("D2 09:41", "D2 ~9:41a" 12-hour); in a trip, its phase ("Leave 9:36a", "Off 09:51"); otherwise a word or two ("Set up", "No classes").',
                    },
                    line: { type: 'string', example: 'Leave by ~09:36 · R2 from PGP', description: 'One line, for a collapsed notification or a compact widget.' },
                    actions: {
                      type: 'array',
                      description: 'Buttons to show, in order. Send `id` and `trip` to POST /me/signal.',
                      items: {
                        type: 'object',
                        required: ['id', 'label', 'trip'],
                        properties: { id: { type: 'string', enum: ['boarded', 'missed', 'skipped', 'arrived', 'reset', 'away', 'back'] }, label: { type: 'string', example: 'Not going' }, trip: { type: 'string', example: '4:600:UTOWN' } },
                      },
                    },
                    warning: { type: ['string', 'null'], example: 'Last D2 from UTown in 18 min' },
                    nextChangeAt: { type: ['string', 'null'], format: 'date-time', description: 'When this card is next expected to change by itself (the next phase, or going stale): fetch again then.' },
                    remind: { type: 'boolean', description: 'False when the user turned reminders off for this trip. See `remindAt`.' },
                    suggestion: {
                      type: ['object', 'null'],
                      description: 'Something terminus has learned and offers to change, with its two buttons: send `id` and the choice to POST /me/choice. Never during a trip.',
                      properties: { id: { type: 'string', example: 'earlier:4:600:UTOWN' }, text: { type: 'string' }, accept: { type: 'string', example: 'Leave earlier' }, dismiss: { type: 'string', example: 'No thanks' } },
                    },
                    ride: {
                      type: ['object', 'null'],
                      description: 'On the bus: the stops from boarding to getting off, and the board and arrival times, for a progress bar. Null otherwise.',
                      required: ['svc', 'stops', 'board', 'arrive'],
                      properties: {
                        svc: { type: 'string', example: 'R2' },
                        stops: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' } } } },
                        board: { type: 'string', format: 'date-time' },
                        arrive: { type: 'string', format: 'date-time' },
                      },
                    },
                    detected: { type: 'boolean', description: 'The phase was worked out from the phone’s location, not tapped ("Looks like you’re on the bus").' },
                    walkTo: {
                      type: ['object', 'null'],
                      description: 'Where to walk to now, for a maps app: the stop to catch the bus at, or the destination’s stop on foot. Null on the bus, at the stop, once there, and with nothing to catch.',
                      properties: { name: { type: 'string' }, lat: { type: 'number' }, lon: { type: 'number' } },
                    },
                    notice: { type: ['string', 'null'] },
                    h12: { type: 'boolean', description: 'The card’s times are 12-hour. Write any time you show yourself the same way.' },
                    journey: {
                      type: ['object', 'null'],
                      description:
                        'The trip as steps, for apps that draw it (a line from you to the destination, a ticket, a list of steps): walk to the stop, take the bus, get there, and walk on when the destination is a room or building away from the stop. ' +
                        'On foot the whole way it is the walk alone: `bus`, `boardAt` and `ride` are null, `walk` is the whole walk and `why` says why not a bus. ' +
                        'Null on the bus, once there, and with no time to give. Count down to `leave.at` and `boardAt` yourself; show the strings as they are.',
                      required: [
                        'leave', 'walk', 'bus', 'boardAt', 'ride', 'off', 'to', 'toStop', 'arrive', 'walkEnd', 'arriveStop', 'slack', 'live', 'backup', 'why',
                        'title', 'place', 'byText', 'walkText', 'rideText', 'walkEndText', 'arriveText', 'arriveWhere', 'backupText', 'summary',
                      ],
                      properties: {
                        leave: { type: ['string', 'null'], description: 'When to set off ("4:01 PM", "~4:01 PM"). Null when it is now.' },
                        walk: { type: ['string', 'null'], description: 'The walk to the stop ("3 min"). Null at the stop. On foot, the whole walk there.' },
                        bus: { oneOf: [{ $ref: '#/components/schemas/JourneyBus' }, { type: 'null' }], description: 'The bus to catch. Null on foot.' },
                        boardAt: { type: ['string', 'null'], format: 'date-time', description: 'When the bus leaves, to count down to. Null on foot.' },
                        ride: { type: ['string', 'null'], description: 'Time on the bus ("3 min"). Null on foot.' },
                        off: { type: ['string', 'null'], description: 'Where to get off, when that is across the road from the destination.' },
                        to: { type: 'string', description: 'Where you are going ("GEA1000 @ UTown").' },
                        toStop: { type: 'string', description: 'The stop you get off at ("UTown"), short enough for the end of a line.' },
                        arrive: { type: ['string', 'null'], description: 'When you get there ("4:08 PM"): to the room or building itself when `walkEnd` is set.' },
                        walkEnd: {
                          type: ['string', 'null'],
                          description: 'The walk from `toStop` to where you are going ("2 min"): a class’s room, a building or room searched for, a food court. Null when the destination is the stop.',
                        },
                        arriveStop: { type: ['string', 'null'], description: 'When the bus gets to `toStop` ("4:06 PM"). The same as `arrive` when `walkEnd` is null.' },
                        slack: { type: ['string', 'null'], description: 'A class only: "3 min early", "2 min late".' },
                        live: { type: 'boolean', description: 'The bus’s time is live, not a timetable estimate.' },
                        backup: {
                          oneOf: [{ $ref: '#/components/schemas/JourneyBus' }, { type: 'null' }],
                          description: 'Another bus: the next one for a trip, or for a class the sooner bus to go now on.',
                        },
                        why: { type: ['string', 'null'], description: 'On foot: why not a bus ("D1 would be 16 min"). Null with a bus.' },
                        title: { type: 'string', example: 'To GEA1000 @ UTown · starts 10:00', description: 'Where to, with a class’s start ("To X · starts 10:00"; Chinese "去 X · 10:00 开始", "回家" for home).' },
                        place: { type: 'string', example: 'GEA1000', description: 'Where you are going, short enough for the end of a line: `to` without its " @ " part.' },
                        byText: { type: ['string', 'null'], example: 'by ~09:36', description: 'Under the leave countdown, until it is time to go. Null when `leave` is, and at the stop.' },
                        walkText: { type: ['string', 'null'], example: '5 min walk', description: '`walk` as a step: the walk to the stop, or the whole walk on foot. Null when `walk` is.' },
                        rideText: { type: ['string', 'null'], example: '10 min ride · off at Opp NUSS', description: '`ride` as a step, with where to get off when that is across the road. Null on foot.' },
                        walkEndText: { type: ['string', 'null'], example: '2 min walk', description: '`walkEnd` as a step, from `toStop` to the place. Null when `walkEnd` is.' },
                        arriveText: { type: ['string', 'null'], example: 'Arrive ~09:51 · 9 min early', description: 'When you get there, with a class’s slack. Null when `arrive` is.' },
                        arriveWhere: { type: 'string', example: '2 min walk from UTown', description: 'Under the arrival: the walk on from `toStop`, or "at UTown".' },
                        backupText: {
                          type: ['string', 'null'],
                          example: 'Or go now: R2 at 09:06 from PGP',
                          description: 'The other way: for a class the sooner bus to go now on ("Or go now: R2 at 09:06 from PGP"), for a trip the other bus ("Or A1 at 09:09 from PGP"), on foot `why`. A public bus is "95 ($)". Null with none.',
                        },
                        summary: {
                          type: 'string',
                          example: 'arrive ~09:51 · R2 ~09:42 at PGP',
                          description: 'The trip on one line, most needed first, for a compact widget: a class’s arrival then its bus ("arrive ~09:51 · R2 ~09:42 at PGP"), the walk to the stop then the bus ("Walk to PGP · A1 09:09"), the bus at the stop ("A1 09:09 at PGP"), or on foot the walk and why ("8 min walk · D1 would be 16 min").',
                        },
                      },
                    },
                    upcoming: {
                      type: ['object', 'null'],
                      description:
                        'Outside your day, on a day with no classes, and at home: the next class, for a card of its own. From the timetable alone, with no bus, since later buses are not known yet. ' +
                        'Null with no class coming, and on every other kind of card. Show the strings as they are.',
                      required: ['when', 'title', 'where', 'off'],
                      properties: {
                        when: { type: 'string', example: 'Tomorrow · Tue', description: '"Today", "Tomorrow · Tue", a weekday, or a date ("Mon 28 Sep").' },
                        title: { type: 'string', example: 'CS2030 at 10:00' },
                        where: { type: 'string', example: 'At COM1 · get off at COM 3', description: 'The room and the stop to get off at, or the stop alone when the room is at it.' },
                        off: { type: ['string', 'null'], description: 'Why today has no classes, when it is a break ("Recess week", a holiday).' },
                      },
                    },
                  },
                },
                walkSpeedMs: { type: 'number', description: 'The user’s walking speed in metres a second, from their walking pace (1.1, 1.3 or 1.5). For walk times an app works out itself from metres, such as `walkM` in search results.' },
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

/** How wide the docs bar's hills are, in pixels: wider than any screen. */
const HZ_W = 4000;

/**
 * The docs page at the sky's hour in Singapore (pagesky.ts): its bar is a
 * slim band of that sky with the campus's hills along its foot, as at the
 * top of Settings' pages. Always the light page's sky: Elements is light.
 */
export function docsPage(phase: Phase): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>API · terminus</title>
  <meta name="description" content="The terminus API: NUS shuttle bus arrivals, live buses and the campus map, as ready-to-show answers. Free with an API key.">
  <link rel="canonical" href="https://terminus.rcn.sh/docs">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <script src="${ELEMENTS}/web-components.min.js" integrity="sha384-X5kH2B8aH81JEl8IfSBwwnr8FYcCqMzdxpqjmmlRbhIl7SsQ9Zn0xk+csQmU37zN" crossorigin="anonymous"></script>
  <link rel="stylesheet" href="${ELEMENTS}/styles.min.css" integrity="sha384-NzdOiocfnINlXfuCXi4OpL/xvdbgLiKaLHQ07Z+IwhVaxHqLShn5rVD5OHt/LYgz" crossorigin="anonymous">
  <script src="/assets/docs.js"></script>
  <style>
    /* On a wide screen the page never scrolls; only the docs inside it do,
       beside their menu. */
    html, body { margin: 0; height: 100%; overflow: hidden; background: #fff; }
    body { position: fixed; top: 0; left: 0; right: 0; height: 100%; height: 100dvh; display: flex; flex-direction: column; }
    .bar { flex: none; position: relative; overflow: hidden; box-sizing: border-box; height: 76px; font: 500 14px/1 system-ui, -apple-system, sans-serif; ${skyVars(phase)}; background: linear-gradient(var(--s0), var(--s1) 50%, var(--s2) 86%, var(--s3)); }
    .bar .row { position: relative; z-index: 1; display: flex; align-items: center; justify-content: space-between; height: 48px; padding: 0 16px; }
    .bar a { color: var(--band-ink); text-decoration: none; display: inline-flex; align-items: center; gap: 8px; }
    .bar b { color: ${lightInkAt(phase) ? '#fb923c' : '#9a3412'}; font-weight: inherit; }
    .bar .back { padding: 12px 0; opacity: 0.85; }
    /* The hills at their own size along the bar's foot, behind its links,
       as wide as any screen: a wider bar shows more of them, not bigger. */
    .bar .hz { position: absolute; left: 0; bottom: 0; width: ${HZ_W}px; height: 52px; }
    .hz .far { fill: var(--h-far); } .hz .tree { fill: var(--h-tree); } .hz .city { fill: var(--h-city); } .hz .lit { fill: #fde9c9; } .hz .near { fill: #fff; }
    elements-api { display: block; flex: 1; min-height: 0; }
    /* Below Elements' breakpoint the sidebar becomes a drawer (layout="responsive"). */
    @media (max-width: 767px) {
      /* On a phone the page itself scrolls, as any page does. Only then does
         the browser move its bars out of the way and let the end of the page
         scroll clear of its toolbar: a page that never scrolls, with the
         docs scrolling inside it, left their last lines under Chrome's
         toolbar however it was sized, because the toolbar lies over the
         page rather than shrinking it. */
      html, body { height: auto; overflow: visible; }
      /* Our bar and Elements' (76 + 60 px) stay over the top of the page:
         what Elements scrolls into view, on picking a menu entry, stops
         below them. */
      html { scroll-padding-top: 136px; }
      body { position: static; display: block; height: auto; padding-top: 76px; }
      .bar { position: fixed; top: 0; left: 0; right: 0; z-index: 21; }
      elements-api .sl-overflow-y-auto.sl-flex-1 { overflow: visible; padding-top: 6px; padding-bottom: 0; }
      /* Elements leaves 64 px under the docs, and 40 more under the
         overview, for a box that scrolls inside a tall screen. Here the
         page ends under the reader's thumb: a short gap is enough. */
      elements-api .sl-overflow-y-auto.sl-flex-1 > .sl-py-16 { padding-bottom: 16px; }
      elements-api .sl-overflow-y-auto.sl-flex-1 > .sl-py-16 > .HttpService { margin-bottom: 0; }
      /* Inputs under 16px make iOS Safari zoom in on focus and stay zoomed. */
      elements-api input, elements-api select, elements-api textarea { font-size: 16px !important; }
      /* Elements' fixed mobile bar has no z-index, so sticky schema headings
         (z-index 10) slide over it while scrolling; and no top, so it sat
         wherever the page flow put it. It goes right under our 76px bar. */
      elements-api .TopNav--mosaic { z-index: 20; top: 76px; }
      elements-api .sl-drawer-container > .sl-fixed { z-index: 30; }
      /* The menu is a drawer of its own, fixed and 100vh tall (sl-h-screen),
         which Chrome counts as if its toolbar were hidden. It scrolls inside
         itself, so the toolbar never moves out of its way: room after the
         last entry as tall as the browser's bars (large minus small
         viewport) and the phone's own bar, plus a little, brings every entry
         clear of them. */
      elements-api .sl-drawer { box-sizing: border-box; padding-bottom: 16px; padding-bottom: calc(100lvh - 100svh + env(safe-area-inset-bottom, 0px) + 16px); }
    }
  </style>
</head>
<body>
  <div class="bar">
    <div class="row">
      <a href="/"><img src="/assets/mark.svg" alt="" width="22" height="22"><span>termi<b>nus</b> API</span></a>
      <a class="back" href="/">Back to terminus</a>
    </div>
    ${horizonSvg(phase === 'dusk' || phase === 'night', HZ_W)}
  </div>
  <noscript><p style="padding:16px">The docs need JavaScript. Without it: the spec, every endpoint with examples, is at <a href="/openapi.json">/openapi.json</a>, and a short guide to the API, in Markdown, is at <a href="/llms.txt">/llms.txt</a>.</p></noscript>
  <elements-api apiDescriptionUrl="/openapi.json" router="hash" layout="responsive"></elements-api>
</body>
</html>`;
}
