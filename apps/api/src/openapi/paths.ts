/**
 * Every path the API answers and its operations (openapi.ts puts them in the
 * spec). Built afresh on each call, since openapi.ts adds the common errors
 * to what it returns.
 */

import {
  stoppedParam,
  publicParam,
  coordParams,
  errorResponse,
  ok,
  created,
  jsonBody,
  RETRY_AFTER,
  slowDown,
  langParam,
  h12Param,
  KEYED_ERRORS,
  DOWNLOADS_OFF,
  answerExample,
} from './parts.ts';

export function paths(): Record<string, unknown> {
  return {
    '/api/next': {
      get: {
        tags: ['Answers'],
        summary: 'Next bus',
        description:
          'Returns the next bus. The destination depends on which parameters you send:\n\n' +
          '- `to`: a stop, place or NUSMods venue code, from your location or from the stop in `from`.\n' +
          '- `lat` and `lon` only: the next buses at your nearest stop, without a destination.\n' +
          '- none of these: a "Set up" answer that tells the client what to send, instead of guessing a destination.\n\n' +
          'A `to` that matches nothing is ignored rather than an error: with a location, the answer is the next buses at your nearest stop; without one, "Set up". ' +
          'Use `/api/trip` to be told about an unknown destination.',
        operationId: 'getNext',
        parameters: [
          ...coordParams,
          {
            name: 'to',
            in: 'query',
            description:
              'A stop code such as `UTOWN`, a place such as a food court (a `landmark` code from `/api/campus`, served by its quickest stop), or a NUSMods venue code such as `COM1-0212`. Case-insensitive.',
            schema: { type: 'string' },
            example: 'UTOWN',
          },
          {
            name: 'from',
            in: 'query',
            description:
              'With `to`: a stop code to start from, when no `lat`/`lon` is sent. Ignored without `to`, or when it is not a stop.',
            schema: { type: 'string' },
            example: 'PGP',
          },
          publicParam,
          langParam,
        ],
        responses: {
          '200': {
            description:
              'The answer. Always 200 once the caller is let in, even when the upstream feed is down; check `quality` to see how reliable it is.',
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
          ...KEYED_ERRORS,
        },
      },
    },
    '/api/trip': {
      get: {
        tags: ['Answers'],
        summary: 'Answer for a destination',
        description: 'The same answer as `/api/next`, for an explicit destination. Send your location, or `from` to start at a stop.',
        operationId: 'getTrip',
        parameters: [
          {
            name: 'to',
            in: 'query',
            required: true,
            description:
              'A stop code such as `UTOWN`, a place such as a food court (a `landmark` code from `/api/campus`, served by its quickest stop), or a NUSMods venue code such as `COM1-0212`. Case-insensitive.',
            schema: { type: 'string' },
            example: 'UTOWN',
          },
          {
            name: 'from',
            in: 'query',
            description: 'Stop code to start from. Required when no `lat`/`lon` is sent; ignored when they are.',
            schema: { type: 'string' },
            example: 'PGP',
          },
          ...coordParams,
          langParam,
        ],
        responses: {
          '200': {
            description: 'The answer.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Answer' }, example: answerExample } },
          },
          '400': errorResponse('Unknown destination, or neither a location nor a known `from` stop was sent.', {
            error: 'unknown destination: pass ?to= a stop or venue code',
          }),
          ...KEYED_ERRORS,
        },
      },
    },
    '/api/arrivals': {
      get: {
        tags: ['Stops'],
        summary: 'Arrivals at one stop',
        description:
          'Lists the next arrivals for every service at one stop. There is no destination, so walking time and route direction are not considered. Uses the same 15-second per-stop cache as `/api/next` and `/api/trip`. `stop.opposite` is the stop across the road (or one easily mistaken for it), whose board is a second `/api/arrivals` call away. Each row says where the service goes from here (`towards`), how full its next bus is (`crowd`) and when the service stops running today (`endsAt`). `etaS` already counts from the moment of the request, also when the times are cached or stale: do not add it to `asOf`, which says how old the times are.',
        operationId: 'getArrivals',
        parameters: [
          {
            name: 'stop',
            in: 'query',
            required: true,
            description:
              'Stop code, case-insensitive. A public stop of its own (LTA’s five-digit code, such as `16009` for Kent Ridge Terminal on Clementi Road) lists its public buses.',
            schema: { type: 'string' },
            example: 'COM3',
          },
          publicParam,
          stoppedParam,
          langParam,
        ],
        responses: {
          '200': {
            description: "The stop's board.",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/StopBoard' },
                example: {
                  stop: {
                    code: 'YIH',
                    name: 'YIH',
                    longName: 'Yusof Ishak House',
                    opposite: 'YIH-OPP',
                    oppositeAcross: true,
                    oppositeName: 'Opp Yusof Ishak House',
                  },
                  board: [
                    {
                      svc: 'K',
                      etaS: 180,
                      quality: 'live',
                      ambiguousBerth: false,
                      later: [
                        { etaS: 900, quality: 'live', eta: '15 min' },
                        { etaS: 1500, quality: 'scheduled', eta: '~25 min' },
                      ],
                      color: '#2b9ad6',
                      towards: ['Central Library', 'Prince George’s Park Foyer'],
                      via: ['Central Library', 'Engineering', 'Kent Vale'],
                      crowd: 'low',
                      endsAt: '2026-09-28T15:04:00.000Z',
                      running: true,
                      eta: '3 min',
                      laterText: 'then 15, ~25 min',
                      toText: 'to Central Library, Prince George’s Park Foyer',
                    },
                    {
                      svc: 'D1',
                      etaS: 420,
                      quality: 'live',
                      ambiguousBerth: false,
                      later: [],
                      color: '#ec4fa0',
                      towards: ['Central Library', 'COM 3'],
                      via: ['Central Library', 'Arts', 'BIZ'],
                      crowd: 'high',
                      endsAt: '2026-09-28T15:00:00.000Z',
                      running: true,
                      eta: '7 min',
                      laterText: null,
                      toText: 'to Central Library, COM 3',
                    },
                  ],
                  asOf: '2026-09-28T01:14:02.000Z',
                  available: true,
                },
              },
            },
          },
          '400': errorResponse('Unknown stop code.', { error: 'unknown stop', stop: 'NARNIA' }),
          ...KEYED_ERRORS,
        },
      },
    },
    '/api/buses': {
      get: {
        tags: ['Stops'],
        summary: 'Live buses on one service',
        description:
          'Which stop each bus on a service is at, or which two stops it is between, how full it is and the stop it reaches next. Positions come from the live feed through a 5-second cache per service. The feed gives a new position only every 15 to 20 seconds, too far apart to draw a bus where it is, so each bus is shown at a stop or between two. Within 40 metres of one of its stops, measured along its route, it is at that stop (`at`), with `lat` and `lon` the stop’s own; a map draws it just beside the stop, and several there side by side by `slot`. Otherwise it is halfway between the stop it passed and its next one, on the route line, or spread evenly between them when there are several (a third and two thirds of the way for two); `stretch` gives that part of the route, so a map can show the bus is somewhere along it. On a road the route uses both ways, its side follows from where it has been: a bus only moves forward along its route, so it keeps its side and its next stop only moves on. A bus away from its route (such as one parked at the depot) is left out. `plate` is the bus’s number plate, as painted on it; `id` stays the same for a bus while it runs, so a map can move it from one place to the next.',
        operationId: 'getBuses',
        parameters: [
          {
            name: 'svc',
            in: 'query',
            required: true,
            description: 'Service code, case-insensitive.',
            schema: { type: 'string' },
            example: 'D2',
          },
        ],
        responses: {
          '200': {
            description:
              "The service's buses. `available` is false when the live feed could not be reached, which is not the same as no buses running.",
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Buses' },
                example: {
                  svc: 'D2',
                  color: '#8e44c9',
                  buses: [
                    {
                      id: '3f9a1c0b7e21',
                      plate: 'PD726D',
                      lat: 1.29497,
                      lon: 103.77349,
                      along: 1834.2,
                      heading: 92,
                      moving: true,
                      crowd: 'low',
                      at: null,
                      slot: 0,
                      stretch: { from: 1410.5, to: 2257.9, last: { code: 'LT13', name: 'LT13' } },
                      nextStop: { code: 'COM3', name: 'COM 3' },
                      upcoming: [{ code: 'COM3', name: 'COM 3' }],
                      towards: { code: 'COM3', name: 'COM 3' },
                    },
                  ],
                  asOf: '2026-10-02T01:14:02.000Z',
                  available: true,
                  stale: false,
                },
              },
            },
          },
          '400': errorResponse('Unknown service.', { error: 'unknown service', svc: 'Z9' }),
          ...KEYED_ERRORS,
        },
      },
    },
    '/api/line': {
      get: {
        tags: ['Stops'],
        summary: 'One service’s line',
        description:
          'A service’s whole line, for a page about it: its stops in route order (a loop’s first stop is not listed again at its end), each with the other shuttle services that call there, and its buses placed on that list, each at a stop (`at`, an index into `stops`) or between two (`after`: between `stops[after]` and the next, which on a loop’s last stop is the first again). The buses are the same ones as `/api/buses`, placed the same way, from the same 5-second cache. With `stop`, `stop.row` is the service’s board row at that stop, as on `/api/arrivals?stopped=1`, through the same 15-second cache. `running`, `stopped` and `resumesAt` say whether the service is running now, and if not, why and when it starts again: it runs inside its hours, and whenever one of its buses is out on the line. No times are worked out for the other stops: only the live feed’s own are given.',
        operationId: 'getLine',
        parameters: [
          {
            name: 'svc',
            in: 'query',
            required: true,
            description: 'Service code, case-insensitive. Shuttle services only.',
            schema: { type: 'string' },
            example: 'D1',
          },
          {
            name: 'stop',
            in: 'query',
            description: 'A stop on the service, case-insensitive: adds `stop`, with its index in `stops` and the service’s row there.',
            schema: { type: 'string' },
            example: 'YIH',
          },
          langParam,
        ],
        responses: {
          '200': {
            description:
              'The line. `available` is false when the live feed could not be reached; `buses` is then empty, which is not the same as no buses running.',
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
                    row: {
                      svc: 'D1',
                      etaS: 240,
                      quality: 'live',
                      ambiguousBerth: false,
                      later: [],
                      color: '#ec4fa0',
                      towards: ['Central Library', 'COM 3'],
                      via: ['Central Library', 'Arts', 'BIZ'],
                      crowd: 'low',
                      endsAt: '2026-10-07T15:00:00.000Z',
                      running: true,
                      eta: '4 min',
                      laterText: null,
                      toText: 'to Central Library, COM 3',
                    },
                  },
                  available: true,
                  asOf: '2026-10-07T05:14:02.000Z',
                },
              },
            },
          },
          '400': errorResponse('Unknown service, or a stop the service does not call at.', {
            error: 'stop not on this service',
            svc: 'D1',
            stop: 'PGP',
          }),
          ...KEYED_ERRORS,
        },
      },
    },
    '/api/campus': {
      get: {
        tags: ['Stops'],
        summary: 'Campus map and destinations',
        description:
          "Returns stop positions (as SVG coordinates and lat/lon) and each route's path along the roads, plus a destination search list: every stop, named buildings and NUSMods rooms, each mapped to the stop an import would use. The data only changes when the API is redeployed, and responses are cached for an hour. Send the `ETag` back as `If-None-Match` to get a 304 when nothing has changed.",
        operationId: 'getCampus',
        parameters: [langParam],
        responses: {
          '200': {
            description: 'Map geometry and destinations.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Campus' },
                example: {
                  viewBox: '0 0 1000 871',
                  stops: [
                    {
                      code: 'AS5',
                      name: 'AS 5',
                      longName: 'AS 5',
                      opposite: null,
                      x: 177.7,
                      y: 657.9,
                      lat: 1.293619,
                      lon: 103.771475,
                      services: ['A1', 'D1', 'R1'],
                      core: true,
                    },
                  ],
                  routes: {
                    A1: {
                      seq: ['KRB', 'LT13', 'AS5', 'BIZ2', 'TCOMS-OPP', 'PGP', 'KR-MRT'],
                      loop: true,
                      color: '#d32f2f',
                      line: [
                        [103.77438, 1.29464],
                        [103.77421, 1.29475],
                      ],
                      shaped: true,
                    },
                  },
                  destinations: [
                    { code: 'AS5', label: 'AS 5', stopCode: 'AS5', kind: 'stop' },
                    { code: 'COM1', label: 'School of Computing (COM1)', stopCode: 'COM3', kind: 'building' },
                  ],
                  residences: [{ code: 'UTR', name: 'UTown Residence', stops: ['UTOWN'], walkM: 222, walkMin: 3, common: true }],
                },
              },
            },
          },
          '304': { description: 'Nothing has changed since the `ETag` sent as `If-None-Match`.' },
          ...KEYED_ERRORS,
        },
      },
    },
    '/api/stops/pairs': {
      get: {
        tags: ['Stops'],
        summary: 'Stops by side of the road',
        description:
          'Every stop grouped with its opposite stop, with the buses that call at each side and the stop each one goes to next. ' +
          'NUS stops come in pairs a few metres apart, one for each direction of travel, so this is how to tell which side goes where. ' +
          'A stop with no opposite stop is a place with one side.\n\n' +
          '`crossingM` is the straight-line distance between the two stops, not a walking distance. ' +
          '`next` is null where the bus terminates. For whole routes in order, see `/api/campus`.\n\n' +
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
                  attribution:
                    "Stop names, positions and routes from NUS's internal shuttle feed, via terminus (https://terminus.run). Unofficial, not affiliated with NUS.",
                  places: [
                    {
                      id: 'KR-MRT',
                      name: 'Kent Ridge MRT',
                      crossingM: 22,
                      sides: [
                        {
                          code: 'KR-MRT',
                          name: 'KR MRT',
                          longName: 'Kent Ridge MRT',
                          lat: 1.29482,
                          lon: 103.784413,
                          services: [
                            { svc: 'A1', next: 'LT27' },
                            { svc: 'D2', next: 'LT27' },
                            { svc: 'K', next: 'LT27' },
                            { svc: 'P', next: 'UHC-OPP' },
                          ],
                        },
                        {
                          code: 'KR-MRT-OPP',
                          name: 'Opp KR MRT',
                          longName: 'Opp Kent Ridge MRT',
                          lat: 1.294962,
                          lon: 103.784556,
                          services: [
                            { svc: 'A2', next: 'PGPR' },
                            { svc: 'D2', next: 'PGPR' },
                            { svc: 'K', next: 'PGPR' },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
          ...KEYED_ERRORS,
        },
      },
    },
    '/api/status.json': {
      get: {
        tags: ['Service'],
        summary: 'Feed status',
        security: [],
        description:
          "Whether NUS's live feed is answering, as the 15-minute check last saw it, and the last 20 confirmed outages. An outage is confirmed only between 07:00 and 23:30 Singapore time, except when NUS refuses the uNivUS version. What the status page at /status shows.",
        operationId: 'getStatus',
        responses: {
          '200': ok({
            type: 'object',
            properties: {
              feed: {
                type: 'string',
                enum: ['up', 'down', 'maintenance', 'unknown'],
                description:
                  "'maintenance': not answering between 23:30 and 07:00 Singapore time, when no shuttle runs. Not an outage, so it has no incident.",
              },
              since: { type: ['string', 'null'], format: 'date-time' },
              cause: {
                type: ['string', 'null'],
                enum: ['version', 'feed', null],
                description: "Why the feed is down, null otherwise. 'version': NUS wants a newer uNivUS version string, at any hour.",
              },
              checkedAt: { type: ['string', 'null'], format: 'date-time' },
              checking: { type: 'boolean', description: 'False when the checks have stopped running.' },
              publicFeed: {
                type: 'string',
                enum: ['up', 'down', 'unknown'],
                description: 'LTA DataMall, for the public buses. Extra to the shuttle feed: it has no incidents and raises no alerts.',
              },
              publicSince: { type: ['string', 'null'], format: 'date-time' },
              incidents: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    start: { type: 'string', format: 'date-time' },
                    end: { type: ['string', 'null'], format: 'date-time' },
                    cause: {
                      type: 'string',
                      enum: ['version', 'feed'],
                      description: "'version': NUS wanted a newer uNivUS version string.",
                    },
                  },
                },
              },
            },
          }),
        },
      },
    },
    '/api/health': {
      get: {
        tags: ['Service'],
        summary: 'Health',
        security: [],
        description:
          'Returns stop graph details, how long the academic calendar lasts, what the 15-minute check last saw of the NUS feed (`upstream`), and which settings are configured (whether each is set, never its value): `pushAndroid`, `pushWeb` and `pushIos` say whether push to the Android app (Firebase), to the web app (Web Push) and to the iPhone app (APNs) is set up. For the operator only (the operator token in the `x-health-token` header), `probe=1` also checks that the upstream auth token works, and `versions=1` reads which uNivUS version the app stores list; without the token both are ignored. Answers 503, with the same body, when the NUS feed is confirmed down, the monitor has stopped running, or the calendar data has run out.',
        operationId: 'getHealth',
        parameters: [
          {
            name: 'probe',
            in: 'query',
            description: 'Operator only: send `1` to check the upstream auth token (uses the cached token when there is one). Adds `auth`.',
            schema: { type: 'string', enum: ['1'] },
          },
          {
            name: 'versions',
            in: 'query',
            description:
              'Operator only: send `1` to read the uNivUS version from Google Play (no NUS calls), as the automatic version update would. Adds `versions`.',
            schema: { type: 'string', enum: ['1'] },
          },
        ],
        responses: {
          '200': {
            description: 'Service status: healthy.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Health' },
                example: {
                  ok: true,
                  now: '2026-09-28T01:14:02.000Z',
                  sgt: '09:14 day1',
                  graph: {
                    generated: '2026-09-28T13:27:41Z',
                    source: 'uNivUS bus proxy via scripts/data/scrape_stops.py',
                    stops: 33,
                    services: ['A1', 'A2', 'D1', 'D2', 'K', 'P', 'R1', 'R2'],
                  },
                  calendar: { through: '2027-08-08', daysLeft: 314, source: 'fetched' },
                  config: {
                    auth: true,
                    proxy: true,
                    publicBuses: true,
                    analytics: true,
                    accounts: true,
                    email: true,
                    alerts: true,
                    pushAndroid: true,
                    pushWeb: true,
                    pushIos: true,
                  },
                  upstream: { up: true, since: '2026-09-27T22:00:00.000Z', checkedAt: '2026-09-28T01:00:00.000Z', cronStale: false },
                },
              },
            },
          },
          '503': {
            description:
              'Unhealthy: the NUS feed is confirmed down, the monitor has stopped running, or the calendar data has run out. The same body, with `ok: false`.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } },
          },
        },
      },
    },
    '/api/auth/login': {
      post: {
        tags: ['Account'],
        summary: 'Email a sign-in code and link',
        description:
          'Emails a 6-digit sign-in code and a sign-in link to the address. The reply is the same whether or not the address is blocked or has an account. ' +
          'One email per address per minute, an app sign-in’s included. Either the code (`/api/auth/code`) or the link signs in, once, within 15 minutes.',
        operationId: 'login',
        security: [],
        requestBody: jsonBody(
          {
            type: 'object',
            required: ['email'],
            properties: {
              email: { type: 'string', format: 'email' },
              turnstile: { type: 'string', description: 'The Turnstile token, when the human check is on (`/api/auth/config`).' },
              next: { type: 'string', enum: ['/app/'], description: 'Signing in from the web app: the link goes back to it.' },
            },
          },
          { email: 'you@u.nus.edu' },
        ),
        responses: {
          '200': ok({ type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } } }),
          '400': errorResponse('Not an email address, or the human check failed.'),
          '429': {
            ...errorResponse('Too many attempts from this IP, or too many sign-in emails for everyone this minute.'),
            headers: RETRY_AFTER,
          },
          '502': errorResponse('The email could not be sent. Try again later.', { error: 'could not send the email, try again later' }),
          '503': {
            ...errorResponse(
              'The human check (Turnstile) is not answering, or the account database could not be reached. Try again after `Retry-After` seconds.',
            ),
            headers: RETRY_AFTER,
          },
        },
      },
    },
    '/api/auth/anon': {
      post: {
        tags: ['Account'],
        summary: 'Start without an account',
        description:
          "An app's first launch: creates an account with no email and returns a device token for it, so every `/api/me` route works " +
          'straight away. Add an email later with `/api/auth/app/start`. Deleted after 60 days unused.',
        operationId: 'anon',
        security: [],
        requestBody: jsonBody(
          {
            type: 'object',
            properties: { name: { type: 'string', maxLength: 40 }, platform: { type: 'string', enum: ['android', 'mac', 'ios'] } },
          },
          { name: 'Pixel 8', platform: 'android' },
        ),
        responses: {
          '201': created({ type: 'object', required: ['token'], properties: { token: { type: 'string' } } }),
          '429': { ...errorResponse('Too many new accounts, from this IP or overall.'), headers: RETRY_AFTER },
        },
      },
    },
    '/api/auth/anon/web': {
      post: {
        tags: ['Account'],
        summary: 'Start without an account, in a browser',
        description:
          'The website\'s "Use terminus without an email": the same account as `/api/auth/anon`, as a web session cookie. Needs the Turnstile token when ' +
          "Turnstile is on. Signing in with an email from that browser (`/api/auth/code` or the link) adds the email to it, or switches to the email's account if it has one.",
        operationId: 'anonWeb',
        security: [],
        requestBody: jsonBody({ type: 'object', properties: { turnstile: { type: 'string' } } }, {}),
        responses: {
          '201': created({ type: 'object', properties: { ok: { type: 'boolean' } } }),
          '400': errorResponse('The human check failed.'),
          '403': errorResponse('The request came from another site.'),
          '429': { ...errorResponse('Too many new accounts, from this IP or overall.'), headers: RETRY_AFTER },
          '503': {
            ...errorResponse(
              'The human check (Turnstile) is not answering, or the account database could not be reached. Try again after `Retry-After` seconds.',
            ),
            headers: RETRY_AFTER,
          },
        },
      },
    },
    '/api/auth/app/start': {
      post: {
        tags: ['Account'],
        summary: 'Sign in an app, approved from the email',
        description:
          'Emails a code to type into the app, and a link to approve it from another device by typing the number the app shows (returned here). ' +
          'Send the anonymous token (if the app has one) as `Authorization: Bearer` to keep its setup. Then poll `/api/auth/app/poll`. ' +
          'One email per address per minute, a website sign-in’s included; a request lasts 15 minutes. After “This wasn’t me” on the approval page, the address takes no app sign-ins for 6 hours (403).',
        operationId: 'appStart',
        // The anonymous token is optional.
        security: [{}, { bearer: [] }],
        requestBody: jsonBody(
          {
            type: 'object',
            required: ['email'],
            properties: {
              email: { type: 'string', format: 'email' },
              name: { type: 'string', maxLength: 40 },
              platform: { type: 'string', enum: ['android', 'mac', 'ios'] },
            },
          },
          { email: 'you@u.nus.edu', name: 'MacBook Air' },
        ),
        responses: {
          '201': created({
            type: 'object',
            properties: {
              request: { type: 'string' },
              poll: { type: 'string' },
              match: { type: 'integer', example: 47 },
              expires: { type: 'string', format: 'date-time' },
            },
          }),
          '400': errorResponse('Not an email address.'),
          '403': errorResponse(
            'The address turned an app sign-in down in the last 6 hours (“This wasn’t me”). Pair the device from the website instead.',
          ),
          '409': errorResponse('This device is already signed in.'),
          '429': {
            ...errorResponse(
              'An email went to this address in the last minute, too many attempts, or too many app sign-in emails for everyone this minute.',
            ),
            headers: RETRY_AFTER,
          },
          '502': errorResponse('The email could not be sent. Try again later.', { error: 'could not send the email, try again later' }),
        },
      },
    },
    '/api/auth/app/poll': {
      post: {
        tags: ['Account'],
        summary: 'Wait for the approval',
        description:
          'Every 3 seconds while the app shows the number. `approved` comes once, with the token; after that the request is spent. ' +
          '`outcome` says what happened to the accounts; `choose` means both this device and the account have a setup, and the app should ask which to keep and call `/api/auth/app/merge`.',
        operationId: 'appPoll',
        security: [],
        requestBody: jsonBody({
          type: 'object',
          required: ['request', 'poll'],
          properties: { request: { type: 'string' }, poll: { type: 'string' } },
        }),
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
          '400': errorResponse('No `request` or `poll`.', { error: 'send request and poll' }),
          '429': {
            ...slowDown('Polled too often from this IP: over 60 polls and codes a minute. Wait for `Retry-After` (10 seconds).'),
            headers: { 'Retry-After': { ...RETRY_AFTER['Retry-After'], schema: { type: 'integer', example: 10 } } },
          },
        },
      },
    },
    '/api/auth/app/code': {
      post: {
        tags: ['Account'],
        summary: 'Confirm with the code from the email',
        description:
          'The 6-digit code from the `/api/auth/app/start` email, typed into the app. Right, it answers like an approved poll, with the token. ' +
          'Five wrong codes end the request. The link in the same email (choosing the number) is the alternative.',
        operationId: 'appCode',
        security: [],
        requestBody: jsonBody({
          type: 'object',
          required: ['request', 'poll', 'code'],
          properties: { request: { type: 'string' }, poll: { type: 'string' }, code: { type: 'string' } },
        }),
        responses: {
          '200': ok({
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['approved'] },
              token: { type: 'string' },
              email: { type: 'string' },
              outcome: { type: 'string', enum: ['created', 'added-email', 'signed-in', 'moved-setup', 'choose'] },
            },
          }),
          '400': errorResponse(
            'No `request` or `poll`, a wrong code (`status: pending`), too many wrong codes (`denied`), or an old request (`expired`). ' +
              'After 20 wrong codes for the address in a day (UTC), every code is refused (`status: pending`) until the next day; the email’s link still works.',
          ),
          '429': {
            ...errorResponse(
              'Too many codes tried from this IP (over 10 a minute), or over 60 polls and codes a minute from it (then `Retry-After` is 10).',
            ),
            headers: RETRY_AFTER,
          },
        },
      },
    },
    '/api/auth/app/merge': {
      post: {
        tags: ['Account'],
        summary: 'Keep one setup after signing in',
        description:
          "After a `choose` outcome, with the new token as the session: `keep: 'device'` replaces the account's setup with the one " +
          "from the old anonymous account (`anon`, its token); `keep: 'account'` keeps the account's. The anonymous account is deleted either way.",
        operationId: 'appMerge',
        security: [{ bearer: [] }],
        requestBody: jsonBody({
          type: 'object',
          required: ['anon', 'keep'],
          properties: { anon: { type: 'string' }, keep: { type: 'string', enum: ['account', 'device'] } },
        }),
        responses: {
          '200': ok({ type: 'object', properties: { ok: { type: 'boolean' }, profile: { $ref: '#/components/schemas/Profile' } } }),
          '400': errorResponse('No `anon` or `keep`, or `anon` is not an anonymous account.'),
        },
      },
    },
    '/api/auth/code': {
      post: {
        tags: ['Account'],
        summary: 'Sign in with an emailed code',
        description:
          'Spends the code from the `/api/auth/login` email and sets the web session cookie. A code dies after 5 wrong guesses; the link in the same email still works.',
        operationId: 'signInCode',
        security: [],
        requestBody: jsonBody(
          {
            type: 'object',
            required: ['email', 'code'],
            properties: { email: { type: 'string', format: 'email' }, code: { type: 'string' } },
          },
          { email: 'you@u.nus.edu', code: '482735' },
        ),
        responses: {
          '200': ok({ type: 'object', properties: { ok: { type: 'boolean' } } }),
          '400': errorResponse(
            'Wrong or expired code, or 20 wrong codes for the address today (UTC): then every code is refused until the next day, and the email’s link still works.',
          ),
          '403': errorResponse('The request came from another site.'),
          '429': { ...errorResponse('Too many attempts from this IP.'), headers: RETRY_AFTER },
        },
      },
    },
    '/api/pair': {
      post: {
        tags: ['Account'],
        summary: 'Pair a device',
        description:
          'Exchanges the 6-character code shown on the account page for a device token. Send the token as ' +
          '`Authorization: Bearer <token>` on `/api/me` routes. It lasts until it is revoked on the account page, or until it goes 90 days unused. Codes work once, for 10 minutes. The account’s owner is emailed to say a device was added.',
        operationId: 'pair',
        security: [],
        requestBody: jsonBody(
          {
            type: 'object',
            required: ['code'],
            properties: {
              code: { type: 'string' },
              name: { type: 'string', maxLength: 40, description: 'Shown in the device list.' },
              platform: {
                type: 'string',
                enum: ['android', 'mac', 'ios'],
                description: 'The app’s platform, used when the request has no `x-terminus-client` header.',
              },
            },
          },
          { code: 'K7QX4M', name: 'Pixel 8', platform: 'android' },
        ),
        responses: {
          '200': ok({ type: 'object', required: ['token'], properties: { token: { type: 'string' } } }),
          '400': errorResponse('Wrong or expired code.'),
          '429': {
            ...errorResponse('Too many attempts from this IP, or too many pairing attempts for everyone this minute.'),
            headers: RETRY_AFTER,
          },
        },
      },
    },
    '/api/pair/check': {
      post: {
        tags: ['Account'],
        summary: 'Whose code is this',
        description: 'Shows which account a pairing code belongs to, masked, without spending it. Apps ask before pairing from a link.',
        operationId: 'pairCheck',
        security: [],
        requestBody: jsonBody({ type: 'object', required: ['code'], properties: { code: { type: 'string' } } }, { code: 'K7QX4M' }),
        responses: {
          '200': ok({ type: 'object', required: ['account'], properties: { account: { type: 'string', example: 'j•••@u.nus.edu' } } }),
          '400': errorResponse('Wrong or expired code.'),
          '429': {
            ...errorResponse('Too many attempts from this IP, or too many pairing attempts for everyone this minute.'),
            headers: RETRY_AFTER,
          },
        },
      },
    },
    '/api/me/next': {
      get: {
        tags: ['Account'],
        summary: 'Next bus to where you are going',
        description:
          'The personal version of `/api/next`. With no `place` or `to`, the destination comes from your timetable:\n\n' +
          '- before your first class: that class, from home\n' +
          '- between classes: the next one, unless the gap is longer than `gapHours`, in which case home until an hour before it\n' +
          '- after your last class: home\n' +
          '- no classes today, or none left to plan: `mode: free`, nothing to catch (departures near you are on `/api/me/nearby`)\n' +
          '- outside your day hours (default 06:00-18:00, stretched for early or late classes): `mode: rest`, no bus\n\n' +
          'The response also carries your favourites (`places`), so a widget can show them as buttons. ' +
          '`card` has every line worded for display (the headline `title`, the `heading` above it, the trip as steps in `journey`), and `remindAt`, when to post the leave reminder: show the strings as they are, and count down only to the times given.',
        operationId: 'meNext',
        security: [{ bearer: [] }, { cookie: [] }],
        parameters: [
          ...coordParams,
          {
            name: 'place',
            in: 'query',
            description: 'Key of a favourite (one of `places`).',
            schema: { type: 'string' },
            example: 'mrt',
          },
          {
            name: 'to',
            in: 'query',
            description:
              'Any stop code, place (a `landmark` code from `/api/campus`, such as a food court) or NUSMods venue code, case-insensitive. One that names nothing known is ignored, as an unknown `place` is.',
            schema: { type: 'string' },
            example: 'COM3',
          },
          h12Param,
          langParam,
        ],
        responses: { '200': ok({ $ref: '#/components/schemas/MeAnswer' }), '401': errorResponse('No valid session.') },
      },
    },
    '/api/me/nearby': {
      get: {
        tags: ['Account'],
        summary: 'Departures near you',
        description:
          "Upcoming buses at up to three stops within walking range, nearest first, plus the nearest stop's opposite stop " +
          "(across the road, or a stop easily mistaken for it) when it isn't one of them. `opposite` is each stop's opposite or partner stop, if it has one. Each departure has its service's `color`. Without coordinates, uses your home.",
        operationId: 'meNearby',
        security: [{ bearer: [] }, { cookie: [] }],
        parameters: [...coordParams, stoppedParam, langParam],
        responses: {
          '200': ok({
            type: 'object',
            properties: {
              stops: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    stop: {
                      type: 'object',
                      properties: { code: { type: 'string' }, name: { type: 'string' }, longName: { type: 'string' } },
                    },
                    opposite: { type: ['string', 'null'] },
                    oppositeAcross: { type: 'boolean' },
                    oppositeName: { type: ['string', 'null'] },
                    distM: { type: 'integer' },
                    walkS: { type: 'integer' },
                    available: { type: 'boolean' },
                    via: {
                      type: 'array',
                      items: { type: 'string' },
                      example: ['UTown', 'Science', 'Kent Ridge MRT'],
                      description:
                        'Which way this stop’s buses go, by places someone new to NUS knows: the ones most of its buses (`board[].via`) pass first, the most shared first, up to three. Empty when they pass none.',
                    },
                    viaText: {
                      type: ['string', 'null'],
                      example: 'to UTown, Science, Kent Ridge MRT',
                      description: '`via` in words (Chinese "往 UTown、理学院 方向"). Null when `via` is empty.',
                    },
                    board: { type: 'array', items: { $ref: '#/components/schemas/BoardRow' } },
                  },
                },
              },
              asOf: {
                type: 'string',
                format: 'date-time',
                description:
                  'When the oldest times on these boards were fetched (a cached or `stale` answer’s original fetch time), so "updated N ago" is true.',
              },
            },
          }),
          '400': errorResponse('No coordinates and no home set.'),
          '401': errorResponse('No valid session.'),
        },
      },
    },
    '/api/me/day': {
      get: {
        tags: ['Account'],
        summary: "Today's timeline",
        description:
          "Each of today's classes with where you set off from and its leave-by (an estimate hours ahead), the trips home in long gaps and after the " +
          'last class, and where each stands: `done`, `next` (the first not done) or `later`, and for a trip home whose time has come, `now`. A class you are on the bus to has `onBus` (`svc`, `off`, `arrive`) ' +
          'in place of a leave-by. Anything not done yet is `removable`: POST /api/me/signal `{kind: "skipped", trip: key}` takes it off today (a class, ' +
          'a usual time, a one-off, or a trip home, which then means staying), `reset` puts it back; entries taken off are not listed. ' +
          'With `lat` and `lon`, the next class is planned from there, as GET /api/me/next plans it, so the two give the same leave-by; later ' +
          'classes are planned from the class or home before them. Clients cache it for the day. `note` says why a day has no classes.',
        operationId: 'meDay',
        security: [{ bearer: [] }, { cookie: [] }],
        parameters: [...coordParams, h12Param, langParam],
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
                  required: [
                    'kind',
                    'key',
                    'label',
                    'title',
                    'line',
                    'status',
                    'from',
                    'fromName',
                    'to',
                    'toName',
                    'startsAt',
                    'endsAt',
                    'removable',
                  ],
                  properties: {
                    kind: { type: 'string', enum: ['class', 'home'] },
                    key: { type: 'string', example: '4:600:UTOWN', description: 'The trip’s key, for POST /api/me/signal.' },
                    label: { type: 'string' },
                    title: {
                      type: 'string',
                      example: 'Home, from UTown',
                      description:
                        'The row’s first line: the class, "Home, from X" (Chinese "回家，从 X 出发"), or "Home after your last class" when that class has no place.',
                    },
                    line: {
                      type: ['string', 'null'],
                      example: 'Leave by ~09:38 · D2 from PGP',
                      description:
                        'The row’s second line: the leave-by and how ("Leave by ~09:38 · D2 from PGP", "Leave by 13:39 · walk", with "~5 min late" when it will be), or the bus you are on ("On the D2 · off at UTown · arrive 09:52"). Null once done, and with nothing to say yet. Show it as it is.',
                    },
                    status: {
                      type: 'string',
                      enum: ['done', 'now', 'next', 'later'],
                      description:
                        '`now` only on a trip home, once the class before it has ended. Entries taken off today are left out rather than listed.',
                    },
                    from: { type: ['string', 'null'] },
                    fromName: { type: ['string', 'null'] },
                    to: { type: 'string' },
                    toName: { type: 'string' },
                    startsAt: { type: 'string', format: 'date-time' },
                    endsAt: { type: ['string', 'null'], format: 'date-time' },
                    venue: { type: 'string' },
                    leave: {
                      oneOf: [{ $ref: '#/components/schemas/Leave' }, { type: 'null' }],
                      description: 'As `leave` on GET /api/me/next.',
                    },
                    onBus: {
                      type: ['object', 'null'],
                      properties: {
                        svc: { type: 'string' },
                        off: { type: ['string', 'null'] },
                        arrive: { type: ['string', 'null'], format: 'date-time' },
                      },
                    },
                    timing: {
                      oneOf: [{ $ref: '#/components/schemas/Timing' }, { type: 'null' }],
                      description: 'As `timing` on GET /api/me/next.',
                    },
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
    '/api/me/signal': {
      post: {
        tags: ['Account'],
        summary: 'Say what happened on the trip',
        description:
          'What happened on a trip, or a plan for today. Cards offer only plans: `skipped` (not going today), `away` ("Not on campus today", ' +
          'on an idle trip: every trip left today, not counted as outcomes) and `back` (undoes it), and `reset` (undo). Nothing asks what ' +
          'happened: no answer is taken as on the planned bus a few minutes after it leaves. `boarded`, `missed`, `left` and `arrived` ' +
          'still work, for older apps. `trip` is the key from a card action or /me/day; without it, the trip in progress. Recorded for the day ' +
          'on every device, and answered with the new `/api/me/next`. Deleted at the end of the day. `location` (with `lat` and `lon`), which older ' +
          'Android apps send during a trip, records nothing: it is answered like `/api/me/next` from there. What was said, and "Not going", is kept ' +
          "35 days as the trip's outcome (in the export, deleted with the account); repeated misses or skips produce a `card.suggestion`.",
        operationId: 'meSignal',
        security: [{ bearer: [] }, { cookie: [] }],
        parameters: [h12Param, langParam],
        requestBody: jsonBody(
          {
            type: 'object',
            required: ['kind'],
            properties: {
              kind: { type: 'string', enum: ['boarded', 'missed', 'skipped', 'left', 'arrived', 'location', 'reset', 'away', 'back'] },
              trip: { type: 'string' },
              lat: { type: 'number' },
              lon: { type: 'number' },
            },
          },
          { kind: 'boarded', trip: '4:600:UTOWN' },
        ),
        responses: {
          '200': ok({ $ref: '#/components/schemas/MeAnswer' }),
          '400': errorResponse('Unknown kind, or a `trip` that is not one of today’s.', { error: 'no such trip today' }),
          '409': errorResponse('No trip in progress to say that about.'),
          '503': errorResponse('Trip tracking is not available.'),
        },
      },
    },
    '/api/me/step': {
      post: {
        tags: ['Account'],
        summary: 'Step to an earlier or later bus',
        description:
          'Takes the bus `card.step` offered for a trip in place of the best one, until the trip ends: `to` is `card.step.earlier` or `card.step.later` as it is, or null for the best bus again. ' +
          'Kept for the day on every device; the leave reminder, widgets and Live Activity follow it. When the feed no longer lists that bus, the next of the same service from the same stop. ' +
          '`dir` (`earlier` or `later`) only counts the step for the operator, by kind of trip, with no account on it. Answered with the new `/api/me/next` for that trip (a favourite or a stop asked for, by its key), from `lat` and `lon` when given; the location is not kept.',
        operationId: 'meStep',
        security: [{ bearer: [] }, { cookie: [] }],
        parameters: [h12Param, langParam],
        requestBody: jsonBody(
          {
            type: 'object',
            required: ['trip', 'to'],
            properties: {
              trip: { type: 'string', maxLength: 80 },
              to: { oneOf: [{ $ref: '#/components/schemas/StepTarget' }, { type: 'null' }] },
              dir: { type: 'string', enum: ['earlier', 'later'] },
              lat: { type: 'number' },
              lon: { type: 'number' },
            },
          },
          { trip: '4:600:UTOWN', to: { svc: 'D2', stop: 'COM3', board: '2026-10-07T01:52:00Z' }, dir: 'later' },
        ),
        responses: {
          '200': ok({ $ref: '#/components/schemas/MeAnswer' }),
          '400': errorResponse('No `trip` or `to`, or a `trip` that is not one of today’s.', { error: 'no such trip today' }),
          '503': errorResponse('Trip tracking is not available.'),
        },
      },
    },
    '/api/me/push': {
      post: {
        tags: ['Account'],
        summary: 'Register this device for push',
        description:
          'An app sends its Firebase Cloud Messaging token; the web app its Web Push subscription (`PushSubscription.toJSON()`, subscribed with the key from GET /api/me/push/key). ' +
          "The iPhone app sends `apns:` and its APNs device token in hex (`apns:<hex>`), and while a trip's Live Activity runs, that activity's push token as `apnsla:<hex>`, and from iOS 17.2 with its Live Activity setting on, the token that starts one as `apnsstart:<hex>`; a development build adds `:sandbox` to any of them (`apns:<hex>:sandbox`), so it is sent through Apple's sandbox. " +
          'A device keeps its latest of each; DELETE forgets them all. These are taken even while APNs is not set up on the server: the iPhone is pushed once it is. ' +
          "When the trip's phase changes, an app gets a data message `{kind: 'card', phase}` and should fetch `/api/me/next`. " +
          'The web app gets the same as an encrypted payload `{kind, phase, urgent}`, only when there is something to show. ' +
          "An iPhone gets an alert with the card's words (`aps.alert` with `mutable-content: 1`, so its notification service extension may re-word it from /api/me/next, `interruption-level` time-sensitive when it's time to go, passive otherwise) and `kind` and `phase` beside `aps`; " +
          'when there is nothing to show (reminders off, no trip), its Live Activity already shows a quiet change, or it registered with `alerts: false`, a background push (`content-available: 1`) with the same `kind` and `phase`. ' +
          'Its Live Activity is sent `liveactivity` pushes, `event` `update` or `end` with the trip as `content-state`; with none running, one is started when the trip is due or missed (`event: start` to its `apnsstart:` token, once per trip and iPhone; see docs/internals.md, APNs). ' +
          "The week before a semester starts, a device whose account imported an older semester's timetable is sent the reminder to import the new one. " +
          "The Android app from 2.5.0 (by its `x-terminus-client` header) gets only `{kind: 'term'}` and fetches the words from GET /api/me/notice; older Android apps and the web app get `{kind: 'term', title, body, zhTitle, zhBody}`, a notification to show as it is; an iPhone gets an alert in its language with the same fields beside `aps`. " +
          'A push address lives on one session; one the push service no longer knows is dropped.',
        operationId: 'mePushRegister',
        security: [{ bearer: [] }, { cookie: [] }],
        requestBody: jsonBody(
          {
            type: 'object',
            properties: {
              token: {
                type: 'string',
                maxLength: 4096,
                description:
                  'An FCM registration token; or from an iPhone `apns:<hex>` (its device token), `apnsla:<hex>` (its Live Activity token) or `apnsstart:<hex>` (the token that starts its Live Activity), with `:sandbox` from a development build.',
              },
              alerts: {
                type: 'boolean',
                description:
                  'With an `apns:` token: whether the leave alerts are on on this iPhone. With `false`, the trip is pushed to it only silently (a background push, no alert); left out, as by an older build, alerts as before.',
              },
              live: {
                type: 'boolean',
                description:
                  'With an `apns:` token: whether the Live Activity setting is on on this iPhone. With `false`, its `apnsstart:` token is forgotten, so no Live Activity is started by push; left out, nothing changes.',
              },
              activity: {
                type: 'boolean',
                description:
                  'With an `apns:` token: whether a Live Activity of this iPhone runs. With `false` (it ended on the phone), its `apnsla:` token is forgotten, so a later trip can start a new one; left out, nothing changes.',
              },
              h12: {
                type: 'boolean',
                description:
                  'With an `apns:` token: whether this iPhone shows 12-hour times. Its notifications and Live Activity are worded so, unless the account chose a clock; left out, as the card pushed.',
              },
              subscription: {
                type: 'object',
                required: ['endpoint', 'keys'],
                properties: {
                  endpoint: { type: 'string', format: 'uri' },
                  keys: { type: 'object', properties: { p256dh: { type: 'string' }, auth: { type: 'string' } } },
                },
              },
            },
          },
          { token: 'fcm-registration-token' },
        ),
        responses: {
          '200': ok({ type: 'object', properties: { ok: { type: 'boolean' } } }),
          '400': errorResponse(
            'No token, a malformed `apns:`, `apnsla:` or `apnsstart:` token, or a subscription that is not an https endpoint with keys.',
          ),
          '503': errorResponse('A subscription, but web push is not set up on this server.'),
        },
      },
      delete: {
        tags: ['Account'],
        summary: 'Stop push to this device',
        operationId: 'mePushForget',
        security: [{ bearer: [] }, { cookie: [] }],
        responses: { '200': ok({ type: 'object', properties: { ok: { type: 'boolean' } } }) },
      },
    },
    '/api/me/push/key': {
      get: {
        tags: ['Account'],
        summary: 'Web Push public key',
        description: "The server's VAPID public key (uncompressed P-256, base64url): the web app's `applicationServerKey`.",
        operationId: 'mePushKey',
        security: [{ bearer: [] }, { cookie: [] }],
        responses: {
          '200': ok({ type: 'object', properties: { key: { type: 'string' } } }),
          '503': errorResponse('Web push is not set up on this server.'),
        },
      },
    },
    '/api/me/choice': {
      post: {
        tags: ['Account'],
        summary: 'Accept or turn down a suggestion',
        description:
          '`id` from `card.suggestion` with `choice: accept` or `dismiss`; or `trip` and `pref` (`earlier`: leave one bus earlier for that class; ' +
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
        responses: {
          '200': ok({
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              choices: { type: 'array', items: { $ref: '#/components/schemas/Choice' }, description: 'As in GET /api/me/choices.' },
            },
          }),
          '400': errorResponse('No such suggestion or choice, or no such trip today.', { error: 'no such trip today' }),
        },
      },
    },
    '/api/me/notice': {
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
                  properties: {
                    title: { type: 'string' },
                    body: { type: 'string' },
                    zhTitle: { type: 'string' },
                    zhBody: { type: 'string' },
                  },
                },
              },
            },
            {
              notice: {
                title: 'Sem 1 2026/27 starts Mon 10 Aug',
                body: 'Import your new timetable from NUSMods, so your plans are right from the first day.',
                zhTitle: '2026/27 第 1 学期将于 8月10日（周一）开始',
                zhBody: '从 NUSMods 导入新课表，让第一天起的行程安排都准确无误。',
              },
            },
          ),
          '401': errorResponse('No valid session.'),
        },
      },
    },
    '/api/me/choices': {
      get: {
        tags: ['Account'],
        summary: 'Trip choices',
        description: 'Classes you leave one bus earlier for, or get no reminders for, and how many trips are in the history.',
        operationId: 'meChoices',
        security: [{ bearer: [] }, { cookie: [] }],
        responses: {
          '200': ok({
            type: 'object',
            properties: {
              choices: { type: 'array', items: { $ref: '#/components/schemas/Choice' } },
              history: { type: 'integer', description: 'Trips in the history (the last 35 days), which DELETE /api/me/history clears.' },
            },
          }),
        },
      },
    },
    '/api/me/history': {
      delete: {
        tags: ['Account'],
        summary: 'Clear trip history',
        description:
          'Forgets what happened on each trip (caught, missed, skipped or no answer; kept 35 days otherwise). Suggestions (`card.suggestion`) come from this history, so none is made from the trips forgotten. Choices already made stay; undo those with POST /api/me/choice.',
        operationId: 'meClearHistory',
        security: [{ bearer: [] }, { cookie: [] }],
        responses: {
          '200': ok({
            type: 'object',
            properties: { ok: { type: 'boolean' }, cleared: { type: 'integer', description: 'Trips forgotten.' } },
          }),
        },
      },
    },
    '/api/me/feedback': {
      post: {
        tags: ['Account'],
        summary: 'Report a wrong answer',
        description:
          'Sends the answer you were looking at, with what was wrong (a reason from the list, a note, or both), for checking against what the buses did. With kind `stop`, suggests the stop students use for a building instead (`venue`, `stop`, and why in `note`, which may be empty); it is kept as feedback with the reason `better-stop`. Only for an account with an email (signed in), so the operator can reply. Kept with your account for a year (in the export, deleted with it); the note alone is emailed to the operator, without your address or the answer. Up to ten a day.',
        operationId: 'sendFeedback',
        security: [{ bearer: [] }, { cookie: [] }],
        requestBody: jsonBody(
          {
            type: 'object',
            required: ['platform'],
            properties: {
              kind: {
                type: 'string',
                enum: ['wrong', 'other', 'stop'],
                default: 'wrong',
                description: 'A wrong answer, a note about anything, or a stop suggestion.',
              },
              reason: {
                type: 'string',
                enum: ['never-came', 'times-off', 'wrong-stop', 'walk-longer', 'wrong-class'],
                description:
                  'What was wrong with the answer, as the apps offer it: the bus never came, the times were off, the wrong stop, a longer walk, the wrong class. Only with kind wrong.',
              },
              note: {
                type: 'string',
                maxLength: 1000,
                description: 'What was wrong, or what you would like. Required unless there is a reason or it is a stop suggestion.',
              },
              venue: { type: 'string', description: 'With kind stop: the building, or a room in it (`LT21`, `COM1-0208`).' },
              stop: { type: 'string', description: 'With kind stop: the code of the stop you use for it (`S17`).' },
              platform: {
                type: 'string',
                enum: ['android', 'mac', 'ios', 'web'],
                description: 'The app sending it: the Android app, the Mac app, the iPhone app, or the website.',
              },
              appVersion: { type: 'string', maxLength: 20 },
              context: { type: 'object', description: 'The answer as shown (a /me/next response), up to 16 KB.' },
            },
          },
          { kind: 'wrong', reason: 'never-came', note: 'Waited 20 min at COM3', platform: 'web', context: { label: 'D2 · 4 min' } },
        ),
        responses: {
          '201': created({ type: 'object', properties: { ok: { type: 'boolean' }, id: { type: 'string' } } }),
          '400': errorResponse(
            'Missing or invalid field (no reason and an empty note, too; a building or stop not known, or the stop the building has already); the message names it.',
          ),
          '401': errorResponse('No valid session.'),
          '403': errorResponse('An anonymous account: sign in with an email first.'),
          '429': { ...errorResponse('Ten reports already today, or too many requests from this account.'), headers: RETRY_AFTER },
        },
      },
    },
    '/api/me/keys': {
      get: {
        tags: ['Account'],
        summary: 'Your API keys',
        description: 'Names, last four characters and dates. A key itself is only ever shown when it is made.',
        operationId: 'listKeys',
        security: [{ bearer: [] }, { cookie: [] }],
        responses: {
          '200': ok({
            type: 'object',
            properties: {
              keys: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    hint: { type: 'string' },
                    created: { type: 'integer' },
                    lastUsed: { type: ['integer', 'null'] },
                  },
                },
              },
            },
          }),
          '401': errorResponse('No valid session.'),
        },
      },
      post: {
        tags: ['Account'],
        summary: 'Make an API key',
        description:
          'From the account page only (a signed-in browser). Up to five per account. The response is the only time the key is shown.',
        operationId: 'createKey',
        security: [{ cookie: [] }],
        requestBody: jsonBody(
          { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 40 } } },
          { name: 'My script' },
        ),
        responses: {
          '201': created({
            type: 'object',
            properties: {
              key: { type: 'string', example: 'tk_…' },
              id: { type: 'string' },
              name: { type: 'string' },
              hint: { type: 'string' },
              created: { type: 'integer', description: 'Epoch milliseconds.' },
              lastUsed: { type: 'null', description: 'Never used yet.' },
            },
          }),
          '400': errorResponse('No name.'),
          '403': errorResponse('Not from the account page.'),
          '409': errorResponse('Five keys already.'),
        },
      },
    },
    '/api/me/profile': {
      get: {
        tags: ['Account'],
        summary: 'Your setup',
        description:
          'The `ETag` header is the profile’s version (`"0"` before it is first saved). Send it back as `If-Match` on PUT to save only if no other device saved since.',
        operationId: 'getProfile',
        security: [{ bearer: [] }, { cookie: [] }],
        responses: {
          '200': {
            ...ok({ $ref: '#/components/schemas/Profile' }),
            headers: {
              ETag: { description: 'The profile’s version, for `If-Match` on PUT /api/me/profile.', schema: { type: 'string' } },
            },
          },
          '401': errorResponse('No valid session.'),
        },
      },
      put: {
        tags: ['Account'],
        summary: 'Replace your setup',
        description:
          'Replaces the whole profile. Missing fields are reset to their defaults. Optional: send `If-Match` with the `ETag` from the GET the edit started from, ' +
          'and the save happens only if the profile is still that version (412 otherwise: read it again and redo the edit). Without it, the last save wins. ' +
          'The new version comes back as `ETag`.',
        operationId: 'putProfile',
        security: [{ bearer: [] }, { cookie: [] }],
        parameters: [
          {
            name: 'If-Match',
            in: 'header',
            required: false,
            schema: { type: 'string', example: '"1767225600000"' },
            description: 'The `ETag` of the profile this edit started from.',
          },
        ],
        requestBody: jsonBody({ $ref: '#/components/schemas/Profile' }),
        responses: {
          '200': {
            ...ok({ $ref: '#/components/schemas/Profile' }),
            headers: { ETag: { description: 'The profile’s new version.', schema: { type: 'string' } } },
          },
          '400': errorResponse('Invalid field; the message names it.'),
          '401': errorResponse('No valid session.'),
          '412': errorResponse('Sent with If-Match, and another device saved the profile since.'),
        },
      },
    },
    '/api/me/once': {
      post: {
        tags: ['Account'],
        summary: 'Add a one-off trip',
        description:
          '"Science library at 14:00 today": `place` (a favourite\'s key) or `to` (a stop, place or room code), `atMin` (minutes past midnight, Singapore time), and optionally `label` ' +
          "and `date` (today by default, up to a week ahead). Kept in the profile's `once` and planned like a class that day, with its leave-by, " +
          'question and "Not going". Answers with the new /me/next, planned from `lat` and `lon` when given, as /me/next is. ' +
          'A save from another device at the same moment is kept: the trip is added to it.',
        operationId: 'meOnce',
        security: [{ bearer: [] }, { cookie: [] }],
        parameters: [...coordParams, h12Param, langParam],
        requestBody: jsonBody(
          {
            type: 'object',
            required: ['atMin'],
            properties: {
              place: { type: 'string' },
              to: { type: 'string' },
              atMin: { type: 'integer' },
              label: { type: 'string' },
              date: { type: 'string', format: 'date' },
            },
          },
          { to: 'CLB', atMin: 840, label: 'Science library' },
        ),
        responses: {
          '200': ok({ $ref: '#/components/schemas/MeAnswer' }),
          '400': errorResponse('Unknown place, a time already past, a date that is not today or in the next week, or too many.'),
          '409': errorResponse('Other devices kept saving the profile meanwhile; try again.'),
        },
      },
    },
    '/api/me/import': {
      post: {
        tags: ['Account'],
        summary: 'Import a NUSMods timetable',
        description:
          'Replaces `trips` with the classes in a NUSMods share link, and `term` with the semester they were read for. Hand-entered classes in `manual` are kept. ' +
          'An import that would leave out a module NUSMods did not answer for (502), or that finds no classes at all (422), changes nothing. The new profile’s version comes back as `ETag`.',
        operationId: 'meImport',
        security: [{ bearer: [] }, { cookie: [] }],
        requestBody: jsonBody(
          { type: 'object', required: ['share'], properties: { share: { type: 'string', format: 'uri' } } },
          { share: 'https://nusmods.com/timetable/sem-1/share?CS2030=LEC:1,LAB:08' },
        ),
        responses: {
          '200': {
            ...ok({
              type: 'object',
              required: ['profile', 'unresolved', 'missing', 'online', 'term'],
              properties: {
                profile: { $ref: '#/components/schemas/Profile' },
                unresolved: {
                  type: 'array',
                  description: 'Classes whose venue could not be matched to a stop, to place by hand.',
                  items: { $ref: '#/components/schemas/Unresolved' },
                },
                missing: {
                  type: 'array',
                  items: { type: 'string' },
                  example: ['CS9999'],
                  description: 'Modules NUSMods has no timetable for in that semester (a typo, or not offered then).',
                },
                online: { type: 'integer', minimum: 0, description: 'Online or TBA lessons, which have no stop and are left out.' },
                term: { type: 'string', example: 'Sem 1 2026/27', description: 'The semester the classes were read for, in words.' },
                dropped: {
                  type: 'integer',
                  minimum: 1,
                  description:
                    'Only when the timetable had more classes than a profile keeps (`limits.trips`): how many of the week’s latest were left out.',
                },
              },
            }),
            headers: {
              ETag: { description: 'The profile’s new version, for `If-Match` on PUT /api/me/profile.', schema: { type: 'string' } },
            },
          },
          '400': errorResponse('Not a NUSMods share link, no modules in it, more than 15, or a code that is not a module.'),
          '409': errorResponse('Other devices kept saving the profile meanwhile; try again.'),
          '422': errorResponse(
            'Nothing to import: no classes in the link for that semester. `missing` lists the modules NUSMods has none for.',
            {
              error: 'Nothing imported: CS9999 has no classes in Sem 1 2026/27. Your timetable was not changed.',
              missing: ['CS9999'],
            },
          ),
          '429': {
            ...errorResponse('Too many imports from this account this minute (each can ask NUSMods for 15 modules), or too many requests.'),
            headers: RETRY_AFTER,
          },
          '502': errorResponse('NUSMods did not answer for some modules (`failed`), so nothing was changed. Try again in a minute.', {
            error: 'NUSMods didn’t respond for CS2030. Nothing was changed. Try again in a minute.',
            failed: ['CS2030'],
          }),
        },
      },
    },
    '/api/me': {
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
    '/api/me/export': {
      get: {
        tags: ['Account'],
        summary: 'Download your data',
        description:
          'Everything kept for the account, as a JSON file: the account and its dates, the profile, devices (with their app, version, push address, an iPhone’s Live Activity push address and the language its notifications are worded in), API keys (names only), feedback, trip outcomes and choices, sign-in requests still waiting, and today’s trip.',
        operationId: 'meExport',
        security: [{ bearer: [] }, { cookie: [] }],
        responses: {
          '200': ok({
            type: 'object',
            properties: {
              email: { type: ['string', 'null'] },
              created: { type: ['string', 'null'], format: 'date-time' },
              lastSeen: { type: ['string', 'null'], format: 'date-time' },
              startedIn: { type: ['string', 'null'], description: 'Where the account was made: the website, or an app.' },
              emailAdded: { type: ['string', 'null'], format: 'date-time' },
              askFrom: { type: ['string', 'null'], format: 'date-time' },
              profile: {
                type: ['object', 'null'],
                description: 'The profile as saved (see GET /api/me/profile); null before the first save.',
              },
              tripOutcomes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { trip: { type: 'string' }, day: { type: 'string', format: 'date' }, outcome: { type: 'string' } },
                },
              },
              tripChoices: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    trip: { type: 'string' },
                    pref: { type: 'string' },
                    label: { type: ['string', 'null'] },
                    setAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
              today: { type: ['object', 'null'], description: 'Today’s trip as the server keeps it.' },
              sessions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', enum: ['web', 'device'] },
                    name: { type: ['string', 'null'] },
                    platform: { type: ['string', 'null'] },
                    app: { type: ['string', 'null'], description: 'The app and its version, as it last said.' },
                    push: {
                      type: ['object', 'null'],
                      properties: { service: { type: 'string', enum: ['firebase', 'web', 'apple'] }, address: {} },
                    },
                    liveActivityPush: {
                      type: ['object', 'null'],
                      description: 'An iPhone’s: the push address of its trip Live Activity, while one runs.',
                      properties: { service: { type: 'string', enum: ['apple'] }, address: { type: 'string' } },
                    },
                    liveActivityStartPush: {
                      type: ['object', 'null'],
                      description:
                        'An iPhone’s: the push address that starts its trip Live Activity when the trip is due or missed, while its Live Activity setting is on.',
                      properties: { service: { type: 'string', enum: ['apple'] }, address: { type: 'string' } },
                    },
                    pushLanguage: {
                      type: ['string', 'null'],
                      enum: ['en', 'zh', null],
                      description: 'An iPhone’s: the language its notifications are worded in.',
                    },
                    pushAlerts: {
                      type: ['boolean', 'null'],
                      description: 'An iPhone’s: whether its leave alerts are on, as it last said (null: not said).',
                    },
                    pushClock: {
                      type: ['string', 'null'],
                      enum: ['12', '24', null],
                      description: 'An iPhone’s: whether it shows 12- or 24-hour times, as it last said (null: not said).',
                    },
                    created: { type: 'string', format: 'date-time' },
                    lastSeen: { type: 'string', format: 'date-time' },
                    expires: { type: ['string', 'null'], format: 'date-time' },
                  },
                },
              },
              signInRequests: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    device: { type: 'string' },
                    platform: { type: ['string', 'null'] },
                    status: { type: 'string' },
                    created: { type: ['string', 'null'], format: 'date-time' },
                    expires: { type: ['string', 'null'], format: 'date-time' },
                  },
                },
              },
              apiKeys: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    endsWith: { type: 'string' },
                    created: { type: 'string', format: 'date-time' },
                    lastUsed: { type: ['string', 'null'], format: 'date-time' },
                  },
                },
              },
              feedback: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    created: { type: 'string', format: 'date-time' },
                    kind: { type: 'string' },
                    reason: { type: ['string', 'null'], description: 'What was wrong, from the list in POST /api/me/feedback.' },
                    note: { type: 'string' },
                    platform: { type: 'string' },
                    appVersion: { type: ['string', 'null'] },
                    replyTo: { type: ['string', 'null'] },
                    answer: { type: ['object', 'null'], description: 'The answer sent with the report.' },
                  },
                },
              },
            },
          }),
          '401': errorResponse('No valid session.'),
        },
      },
    },
    '/api/me/sessions': {
      delete: {
        tags: ['Account'],
        summary: 'Sign out everywhere',
        description: 'Ends every browser session and removes every device, this browser included. From the account page only.',
        operationId: 'endSessions',
        security: [{ cookie: [] }],
        responses: {
          '200': ok({
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              ended: { type: 'integer', description: 'How many sessions and devices were signed out.' },
            },
          }),
          '401': errorResponse('No valid session.'),
          '403': errorResponse('Not from the account page.'),
        },
      },
    },
    '/api/me/pair-code': {
      post: {
        tags: ['Account'],
        summary: 'Make a pairing code',
        description:
          'A 6-character code for `/api/pair`, shown on the account page with its QR code. It works once, for 10 minutes. Needs an account with an email.',
        operationId: 'pairCode',
        security: [{ bearer: [] }, { cookie: [] }],
        responses: {
          '200': ok({
            type: 'object',
            properties: { code: { type: 'string', example: 'K7QX4M' }, expires: { type: 'integer', description: 'Epoch milliseconds.' } },
          }),
          '401': errorResponse('No valid session.'),
          '403': errorResponse('The account has no email.'),
        },
      },
    },
    '/api/me/keys/{id}': {
      delete: {
        tags: ['Account'],
        summary: 'Revoke an API key',
        description:
          'From the account page only. The key stops working at once, except on `/api/buses`, which remembers who is asking for up to 30 seconds and may let it through until then.',
        operationId: 'revokeKey',
        security: [{ cookie: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, description: 'The `id` from `GET /api/me/keys`.', schema: { type: 'string' } },
        ],
        responses: {
          '200': ok({ type: 'object', properties: { ok: { type: 'boolean' } } }),
          '403': errorResponse('Not from the account page.'),
          '404': errorResponse('No such key.'),
        },
      },
    },
    '/api/me/devices': {
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
    '/api/me/devices/{id}': {
      delete: {
        tags: ['Account'],
        summary: 'Remove a device',
        description: 'Signs the device out. Needs an account with an email.',
        operationId: 'removeDevice',
        security: [{ bearer: [] }, { cookie: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, description: 'The `id` from `GET /api/me/devices`.', schema: { type: 'string' } },
        ],
        responses: {
          '200': ok({ type: 'object', properties: { ok: { type: 'boolean' } } }),
          '403': errorResponse('The account has no email.'),
          '404': errorResponse('No such device.'),
        },
      },
    },
    '/api/auth/config': {
      get: {
        tags: ['Account'],
        summary: 'What the sign-in form needs',
        description: 'The Turnstile site key when the human check is on, or null.',
        operationId: 'authConfig',
        security: [],
        responses: {
          '200': ok({ type: 'object', properties: { turnstileSiteKey: { type: ['string', 'null'] } } }),
          '429': slowDown('Too many requests from this IP. Wait for `Retry-After`.'),
        },
      },
    },
    '/auth/verify': {
      get: {
        tags: ['Account'],
        summary: 'The sign-in link',
        description:
          'Where the link in the `/api/auth/login` email goes. An HTML page naming the account, with a button that posts the form below; opening the link spends nothing, because mail scanners open every link.',
        operationId: 'verifyPage',
        security: [],
        parameters: [{ name: 't', in: 'query', required: true, description: 'The token from the email.', schema: { type: 'string' } }],
        responses: {
          '200': { description: 'The sign-in page.', content: { 'text/html': {} } },
          '400': { description: 'The link has expired or was used.', content: { 'text/html': {} } },
          '429': slowDown('Too many requests from this IP. Wait for `Retry-After`.'),
        },
      },
      post: {
        tags: ['Account'],
        summary: 'Sign in with the link',
        description:
          'The page’s form. Spends the token, sets the web session cookie and goes to the account page. Only from the site’s own pages.',
        operationId: 'verify',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/x-www-form-urlencoded': {
              schema: { type: 'object', required: ['t'], properties: { t: { type: 'string' }, next: { type: 'string', enum: ['app'] } } },
            },
          },
        },
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
        description:
          'Where the link in the `/api/auth/app/start` email goes. An HTML page asking for the number the app shows, and a "This wasn’t me" button.',
        operationId: 'approvePage',
        security: [],
        parameters: [{ name: 'r', in: 'query', required: true, description: 'The request from the email.', schema: { type: 'string' } }],
        responses: {
          '200': { description: 'The approval page.', content: { 'text/html': {} } },
          '400': { description: 'The request has expired.', content: { 'text/html': {} } },
          '429': slowDown('Too many requests from this IP. Wait for `Retry-After`.'),
        },
      },
      post: {
        tags: ['Account'],
        summary: 'Type the number',
        description:
          'The page’s form: the right number approves the app’s sign-in (its next `/api/auth/app/poll` gets the token); a wrong one, or `none`, cancels it (`none` also stops app sign-ins to the address for 6 hours). Only from the site’s own pages.',
        operationId: 'approve',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                required: ['r', 'n'],
                properties: { r: { type: 'string' }, n: { type: 'string', description: 'The number typed, or `none`.' } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Approved, or cancelled with `none`.', content: { 'text/html': {} } },
          '400': {
            description: 'The wrong number (the sign-in is cancelled), or the request has expired.',
            content: { 'text/html': {} },
          },
          '403': errorResponse('The form was posted from another site.'),
          '429': { ...errorResponse('Too many attempts from this IP.'), headers: RETRY_AFTER },
        },
      },
    },
    '/api/auth/logout': {
      post: {
        tags: ['Account'],
        summary: 'Sign out',
        description: 'Ends this session (a browser’s, or a device token) and clears the cookie.',
        operationId: 'logout',
        // Signed out already is fine: there is nothing to end.
        security: [{}, { bearer: [] }, { cookie: [] }],
        responses: {
          '200': ok({ type: 'object', properties: { ok: { type: 'boolean' } } }),
          '403': errorResponse('The form was posted from another site.'),
          '429': {
            ...errorResponse('A token that is no session, sent too often from this IP. Wait for `Retry-After`.', {
              error: 'too many attempts, try again in a minute',
            }),
            headers: RETRY_AFTER,
          },
        },
      },
    },
    '/docs': {
      get: {
        tags: ['Service'],
        summary: 'This documentation',
        description: 'The HTML page that renders `/api/openapi.json`.',
        operationId: 'docs',
        security: [],
        responses: { '200': { description: 'The documentation page.', content: { 'text/html': {} } } },
      },
    },
    '/api/openapi.json': {
      get: {
        tags: ['Service'],
        summary: 'This description',
        description: 'The OpenAPI 3.1 description of the API, with `servers` set to the site that served it.',
        operationId: 'openapi',
        security: [],
        responses: { '200': ok({ type: 'object' }) },
      },
    },
    '/api/admin/stats': {
      get: {
        tags: ['Service'],
        summary: 'The operator dashboard’s data',
        description:
          'Counts of accounts, devices and feedback, the feed’s state and recent incidents, and (when configured) answers and errors per day. Answers 404 without the operator token.',
        operationId: 'adminStats',
        security: [{ operator: [] }],
        responses: {
          '200': ok({
            type: 'object',
            properties: {
              now: { type: 'string', format: 'date-time' },
              feed: {
                type: ['object', 'null'],
                properties: {
                  up: { type: 'boolean' },
                  since: { type: 'string', format: 'date-time' },
                  checkedAt: { type: 'string', format: 'date-time' },
                },
              },
              incidents: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    start: { type: 'string', format: 'date-time' },
                    end: { type: ['string', 'null'], format: 'date-time' },
                    cause: { type: 'string' },
                  },
                },
              },
              analytics: {
                type: ['object', 'null'],
                description: 'Answers and errors per day, from Analytics Engine; null when it is not configured.',
              },
              accounts: { type: 'object', additionalProperties: { type: 'integer' } },
              apps: { type: 'object', additionalProperties: { type: 'integer' } },
              devices: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { platform: { type: ['string', 'null'] }, total: { type: 'integer' }, active7: { type: 'integer' } },
                },
              },
              clients: {
                type: 'array',
                description:
                  'App versions, from the version each device last sent: devices used in the last 7 days (`n`), 30 and 90. A device unused for 90 days is signed out.',
                items: {
                  type: 'object',
                  properties: {
                    client: { type: ['string', 'null'] },
                    n: { type: 'integer' },
                    d30: { type: 'integer' },
                    d90: { type: 'integer' },
                  },
                },
              },
              signups: { type: 'array', items: { type: 'object', properties: { day: { type: 'string' }, n: { type: 'integer' } } } },
              apiKeys: { type: 'object', additionalProperties: { type: 'integer' } },
              feedback: { type: 'object', description: 'Reports in the last week, and the latest 25 with their notes and answers.' },
              collect: {
                type: 'object',
                description: 'Which of the extra statistics are being collected: set with POST /api/admin/collect.',
                properties: {
                  active: { type: 'boolean' },
                  eta: { type: 'boolean' },
                  errors: { type: 'boolean' },
                  legacy: { type: 'boolean' },
                  settings: { type: 'boolean' },
                },
              },
              eta: {
                type: ['object', 'null'],
                description:
                  'How close the feed’s arrival times came to when the buses did come, over the last 14 scored days: overall, by how far ahead, by service and by hour. null without storage.',
              },
              model: {
                type: ['object', 'null'],
                description:
                  'The arrival-time model run in shadow (it answers no one): whether it runs (`on`), and each of the last 28 days it answered, every method’s error overall and by how far ahead, with the share of questions history could answer. null without storage.',
              },
            },
          }),
          '404': errorResponse('No operator token, or the wrong one.'),
        },
      },
    },
    '/api/admin/collect': {
      post: {
        tags: ['Service'],
        summary: 'Turn one of the operator’s statistics on or off',
        description:
          'The switches for what terminus collects beyond its answers: `active` (how many accounts used it each day, by app and version, counted from the sessions already kept), `eta` (the feed’s arrival times against when the timelapse recorder saw each bus arrive), `errors` (crash and error reports from the apps and the website, POST /api/errors), `legacy` (requests that still use the old address, the API’s old paths or too old an app, by app version and route) and `settings` (how many active accounts have each setting, once a day). Each is off until turned on. Answers every switch. Answers 404 without the operator token.',
        operationId: 'adminCollect',
        security: [{ operator: [] }],
        requestBody: jsonBody({
          type: 'object',
          required: ['name', 'on'],
          properties: { name: { type: 'string', enum: ['active', 'eta', 'errors', 'legacy', 'settings'] }, on: { type: 'boolean' } },
        }),
        responses: {
          '200': ok({
            type: 'object',
            properties: {
              active: { type: 'boolean' },
              eta: { type: 'boolean' },
              errors: { type: 'boolean' },
              legacy: { type: 'boolean' },
              settings: { type: 'boolean' },
            },
          }),
          '400': errorResponse('No such switch, or `on` is not true or false.'),
          '404': errorResponse('No operator token, or the wrong one.'),
        },
      },
    },
    '/api/admin/crashes/dismiss': {
      post: {
        tags: ['Service'],
        summary: 'Hide a crash from the operator’s dashboard',
        description:
          'Analytics Engine cannot delete a report, so this hides one crash, by its fingerprint, from `appErrors` in GET /api/admin/stats until a report of it comes in after now. Answers 404 without the operator token.',
        operationId: 'adminDismissCrash',
        security: [{ operator: [] }],
        requestBody: jsonBody({
          type: 'object',
          required: ['fingerprint'],
          properties: { fingerprint: { type: 'string', pattern: '^[0-9a-f]{1,32}$', example: '18b32d7aae56' } },
        }),
        responses: {
          '204': { description: 'Hidden.' },
          '400': errorResponse('No fingerprint, or not one.'),
          '404': errorResponse('No operator token, or the wrong one.'),
        },
      },
    },
    '/api/admin/reports/delete': {
      post: {
        tags: ['Service'],
        summary: 'Delete a user’s report from the operator’s dashboard',
        description:
          'Deletes one “This was wrong” report or stop suggestion, by the `id` in `feedback.latest` of GET /api/admin/stats, for good. Answers 204 whether or not it was still there, and 404 without the operator token.',
        operationId: 'adminDeleteReport',
        security: [{ operator: [] }],
        requestBody: jsonBody({
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', pattern: '^[\\w-]{1,64}$', example: '0b9f3c2e-5d1a-4c7e-9a8b-2f6d4e1c3a70' } },
        }),
        responses: {
          '204': { description: 'Deleted, or already gone.' },
          '400': errorResponse('No id, or not a report’s.'),
          '404': errorResponse('No operator token, or the wrong one.'),
        },
      },
    },
    '/api/errors': {
      post: {
        tags: ['Service'],
        summary: 'Report a crash or an error in an app or the website',
        description:
          'What broke, never who it broke for: no account, session, device or install id is asked for or kept. The message and stack are scrubbed of URL queries, email addresses, home folder names, coordinates, long numbers and token-like strings before they are kept, for three months. Each app has a switch to stop sending them. Answers 204 whether or not the report was kept (it is dropped while the operator has `errors` off).',
        operationId: 'reportError',
        security: [],
        requestBody: jsonBody({
          type: 'object',
          required: ['platform', 'version', 'type'],
          properties: {
            platform: { type: 'string', enum: ['android', 'mac', 'ios', 'web'] },
            version: { type: 'string', maxLength: 32, description: 'The app’s version, e.g. `3.1.0`.' },
            os: {
              type: 'string',
              maxLength: 40,
              description: 'The system or browser and its major version, e.g. `Android 15`, `macOS 26`, `Chrome 140`.',
            },
            type: {
              type: 'string',
              maxLength: 120,
              description: 'The error’s type, e.g. `java.lang.IllegalStateException` or `TypeError`.',
            },
            message: { type: 'string', description: 'The error’s message; the first 300 characters are kept.' },
            stack: { type: 'string', description: 'The stack trace; the first 40 lines are kept.' },
            fatal: { type: 'boolean', description: 'true for a crash that ended the app.' },
          },
        }),
        responses: {
          '204': { description: 'Received.' },
          '400': errorResponse('Not a report: platform, version or type missing or not allowed.'),
          '429': { ...errorResponse('Too many requests from this address.'), headers: RETRY_AFTER },
        },
      },
    },
    '/api/admin/passkey/challenge': {
      get: {
        tags: ['Service'],
        summary: 'A passkey challenge, for the operator’s pages',
        description:
          'A fresh WebAuthn challenge (base64url, good for five minutes), the relying party id (this request’s host: each address keeps its own passkeys) and the COSE algorithms accepted. With `register=1`, for adding a passkey: needs the operator token itself in `x-health-token` (answers 404 without it, before any passkey is made), and lists the passkeys kept for this host in `exclude`. Answers 404 when the operator token is not configured on the server.',
        operationId: 'passkeyChallenge',
        security: [],
        parameters: [
          {
            name: 'register',
            in: 'query',
            description: 'Set to `1` for a challenge to add a passkey with.',
            schema: { type: 'string', enum: ['1'] },
          },
        ],
        responses: {
          '200': ok(
            {
              type: 'object',
              required: ['challenge', 'rpId', 'algs'],
              properties: {
                challenge: { type: 'string' },
                rpId: { type: 'string' },
                algs: { type: 'array', items: { type: 'integer' } },
                exclude: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'With `register=1`: the ids of the passkeys kept for this host.',
                },
              },
            },
            { challenge: 'AAABkx3T9QBp2kq0Vf8mX7c1n4WbQe5yRzLhJtU0', rpId: 'terminus.run', algs: [-8, -7, -257] },
          ),
          '404': errorResponse('The operator token is not configured; or, with `register=1`, not sent.'),
        },
      },
    },
    '/api/admin/passkey/register': {
      post: {
        tags: ['Service'],
        summary: 'Add a passkey for the operator’s pages',
        description:
          'Keeps a new passkey, made with a challenge from `/api/admin/passkey/challenge`, and answers with an operator session, as signing in does. Needs the operator token itself in `x-health-token` (a session will not do): answers 404 without it. `key` is the public key as the browser gives it (`getPublicKey()`, SPKI) and `alg` its COSE algorithm; the user must have been verified (a fingerprint, a face or the device’s PIN).',
        operationId: 'passkeyRegister',
        security: [{ operator: [] }],
        requestBody: jsonBody({
          type: 'object',
          required: ['id', 'key', 'alg', 'clientData', 'authData'],
          properties: {
            id: { type: 'string', description: 'The credential id, base64url.' },
            key: { type: 'string', description: 'The public key, SPKI, base64url.' },
            alg: { type: 'integer', enum: [-8, -7, -257] },
            clientData: { type: 'string', description: '`clientDataJSON`, base64url.' },
            authData: { type: 'string', description: '`getAuthenticatorData()`, base64url.' },
            name: { type: 'string', maxLength: 60, description: 'What the device is, for telling passkeys apart.' },
          },
        }),
        responses: {
          '201': { ...ok({ $ref: '#/components/schemas/OperatorSession' }), description: 'Kept; signed in.' },
          '400': errorResponse('Something missing, or a kind of key not accepted.'),
          '403': errorResponse('The challenge ran out, or the passkey was not made for this site, or without verifying the user.'),
          '404': errorResponse('No operator token, or the wrong one.'),
          '409': errorResponse('Twenty passkeys are kept already.'),
        },
      },
    },
    '/api/admin/passkey/signin': {
      post: {
        tags: ['Service'],
        summary: 'Sign in to the operator’s pages with a passkey',
        description:
          'Checks a WebAuthn assertion for a challenge from `/api/admin/passkey/challenge` against the passkeys kept for this host, and answers with an operator session: sent in `x-health-token`, it opens what the operator token does (except adding a passkey) for 12 hours. Changing the operator token ends every session.',
        operationId: 'passkeySignIn',
        security: [],
        requestBody: jsonBody({
          type: 'object',
          required: ['id', 'clientData', 'authData', 'signature'],
          properties: {
            id: { type: 'string', description: 'The credential id, base64url.' },
            clientData: { type: 'string', description: '`clientDataJSON`, base64url.' },
            authData: { type: 'string', description: '`authenticatorData`, base64url.' },
            signature: { type: 'string', description: 'The signature, base64url.' },
          },
        }),
        responses: {
          '200': ok({ $ref: '#/components/schemas/OperatorSession' }),
          '400': errorResponse('Something missing.'),
          '403': errorResponse('Not a passkey kept for this site, or the challenge ran out, or the signature does not check.'),
          '404': errorResponse('The operator token is not configured.'),
        },
      },
    },
    '/api/timelapse/days': {
      get: {
        tags: ['Service'],
        summary: 'Recorded days of shuttles, for the timelapse',
        description:
          'The days the timelapse recorder has kept, newest first: closed days from storage, today’s while it records, and any of the few days before whose recorder has not yet managed to write it to storage (also `closed: false`). `recording` says whether the recorder is switched on and what it is doing today. Needs the operator token, or the timelapse token (which opens these two routes and nothing else), in `x-health-token`: answers 404 without one.',
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
                      closed: {
                        type: 'boolean',
                        description:
                          'true once the window closed and the day was written to storage; false for today, still recording, and for an earlier day not yet written.',
                      },
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
            {
              days: [
                { date: '2026-10-07', closed: false, bytes: null, samples: 1520 },
                { date: '2026-10-06', closed: true, bytes: 412_903, samples: null },
              ],
              recording: { date: '2026-10-07', enabled: true, state: 'polling', samples: 1520 },
            },
          ),
          '404': errorResponse('No operator token, or the wrong one.'),
          '503': errorResponse('Timelapse storage is not set up on this server.', { error: 'timelapse storage is not configured' }),
        },
      },
    },
    '/api/timelapse/days/{date}': {
      get: {
        tags: ['Service'],
        summary: 'One recorded day of shuttles',
        description:
          'The day’s readings as one gzipped JSON file: every service’s buses about every 30 s, as service, number plate, position (whole steps of 1/q degree from `origin`) and metres along the route line, with the route lines and stops they were measured on. Times are deltas from `t0`. A closed day never changes and is cached for a year; today’s is built from what the recorder holds so far and is not cached. The timelapse page (/admin/timelapse/) reads it. Needs the operator token or the timelapse token.',
        operationId: 'timelapseDay',
        security: [{ operator: [] }],
        parameters: [
          {
            name: 'date',
            in: 'path',
            required: true,
            description: 'A Singapore date, YYYY-MM-DD.',
            example: '2026-10-06',
            schema: { type: 'string', format: 'date' },
          },
        ],
        responses: {
          '200': { description: 'The day file, gzipped JSON.', content: { 'application/gzip': {} } },
          '404': errorResponse('No operator token, or no recording for that day.'),
          '503': {
            ...errorResponse(
              'The recorder holding the day did not answer within 10 s (wait for `Retry-After`), or timelapse storage is not set up on this server.',
            ),
            headers: RETRY_AFTER,
          },
        },
      },
    },
    '/map/style.json': {
      get: {
        tags: ['Map'],
        summary: 'The street map’s style',
        description:
          'A MapLibre style: the Protomaps light or dark map without its points of interest, with every URL on this site. Open, like the website.',
        operationId: 'mapStyle',
        security: [],
        parameters: [
          { name: 'theme', in: 'query', schema: { type: 'string', enum: ['light', 'dark'], default: 'light' } },
          {
            name: 'lang',
            in: 'query',
            description: 'Street and place names in English or Chinese.',
            schema: { type: 'string', enum: ['en', 'zh'], default: 'en' },
          },
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
          '416': { description: 'The range starts past the end of the file.' },
          '429': slowDown('Too many reads of parts not yet cached, from one IP. Wait for `Retry-After`.'),
          '503': {
            ...errorResponse('The file could not be read just now (parts already cached are still served). Wait for `Retry-After`.'),
            headers: RETRY_AFTER,
          },
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
          {
            name: 'fontstack',
            in: 'path',
            required: true,
            schema: { type: 'string', enum: ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'] },
          },
          { name: 'range', in: 'path', required: true, schema: { type: 'string' }, example: '0-255' },
        ],
        responses: {
          '200': { description: 'The glyphs.', content: { 'application/x-protobuf': {} } },
          '304': { description: 'Your copy is current (`If-None-Match`).' },
          '404': errorResponse('No such font or range.'),
          '429': slowDown('Too many reads of files not yet cached, from one IP. Wait for `Retry-After`.'),
          '503': { ...errorResponse('Could not be read just now. Wait for `Retry-After`.'), headers: RETRY_AFTER },
        },
      },
    },
    '/map/sprites/v4/{sprite}': {
      get: {
        tags: ['Map'],
        summary: 'Map icons',
        description: 'The style’s sprite sheet and its index.',
        operationId: 'mapSprite',
        security: [],
        parameters: [
          {
            name: 'sprite',
            in: 'path',
            required: true,
            schema: {
              type: 'string',
              enum: ['light.json', 'light.png', 'light@2x.json', 'light@2x.png', 'dark.json', 'dark.png', 'dark@2x.json', 'dark@2x.png'],
            },
          },
        ],
        responses: {
          '200': { description: 'The sheet or its index.', content: { 'image/png': {}, 'application/json': {} } },
          '304': { description: 'Your copy is current (`If-None-Match`).' },
          '404': errorResponse('Not uploaded.'),
          '429': slowDown('Too many reads of files not yet cached, from one IP. Wait for `Retry-After`.'),
          '503': { ...errorResponse('Could not be read just now. Wait for `Retry-After`.'), headers: RETRY_AFTER },
        },
      },
    },
    '/download/latest.json': {
      get: {
        tags: ['Downloads'],
        summary: 'The latest release',
        description: 'The version, and the file and SHA-256 of each app, as the apps’ update checks read it.',
        operationId: 'latest',
        security: [],
        responses: { '200': ok({ type: 'object' }), '404': errorResponse('No release yet.'), '503': DOWNLOADS_OFF },
      },
    },
    '/download/android': {
      get: {
        tags: ['Downloads'],
        summary: 'The Android app',
        description: 'The latest APK. The SHA-256 is in the `x-sha256` header.',
        operationId: 'downloadAndroid',
        security: [],
        parameters: [
          {
            name: 'abi',
            in: 'query',
            description: 'A CPU type other than arm64.',
            schema: { type: 'string', enum: ['armeabi-v7a', 'x86_64'] },
          },
        ],
        responses: {
          '200': { description: 'The APK.', content: { 'application/vnd.android.package-archive': {} } },
          '404': errorResponse('No release yet.'),
          '503': DOWNLOADS_OFF,
        },
      },
    },
    '/download/mac': {
      get: {
        tags: ['Downloads'],
        summary: 'The Mac app',
        description: 'The latest disk image. The SHA-256 is in the `x-sha256` header.',
        operationId: 'downloadMac',
        security: [],
        responses: {
          '200': { description: 'The disk image.', content: { 'application/x-apple-diskimage': {} } },
          '404': errorResponse('No release yet.'),
          '503': DOWNLOADS_OFF,
        },
      },
    },
    '/download/appcast.xml': {
      get: {
        tags: ['Downloads'],
        summary: 'The Mac app’s update feed',
        description: 'The Sparkle appcast the Mac app checks for updates.',
        operationId: 'appcast',
        security: [],
        responses: {
          '200': { description: 'The feed.', content: { 'application/xml': {} } },
          '404': errorResponse('No release yet.'),
          '503': DOWNLOADS_OFF,
        },
      },
    },
    '/download/releases/{version}/{file}': {
      get: {
        tags: ['Downloads'],
        summary: 'A release’s file',
        description:
          'Any release’s APKs, disk image or zip, by version: `terminus-<version>.apk` (also `-armv7`, `-x86_64`), `.dmg` or `.zip`.',
        operationId: 'releaseFile',
        security: [],
        parameters: [
          { name: 'version', in: 'path', required: true, schema: { type: 'string' }, example: '2.0.4' },
          { name: 'file', in: 'path', required: true, schema: { type: 'string' }, example: 'terminus-2.0.4.apk' },
        ],
        responses: { '200': { description: 'The file.' }, '404': errorResponse('No such file.'), '503': DOWNLOADS_OFF },
      },
    },
  };
}
