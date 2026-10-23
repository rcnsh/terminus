/** The spec's security schemes and schemas (openapi.ts puts them in the spec). */

import { quality } from './parts.ts';

export function components(): Record<string, unknown> {
  return {
    securitySchemes: {
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description: 'A key from the account page (API keys). Starts with `tk_`. Opens the answer routes (Answers and Stops) only.',
      },
      bearer: {
        type: 'http',
        scheme: 'bearer',
        description:
          'A device token (from `/api/pair`, `/api/auth/anon` or an app’s sign-in), on every route that takes a bearer token. On the answer routes (Answers and Stops) an API key works too; on `/api/me` routes it does not: an API key opens only the answers.',
      },
      cookie: { type: 'apiKey', in: 'cookie', name: '__Host-tm_s', description: 'Set by signing in on the account page.' },
      operator: {
        type: 'apiKey',
        in: 'header',
        name: 'x-health-token',
        description: 'The operator token (HEALTH_TOKEN), or a session from signing in with a passkey, for the dashboard.',
      },
    },
    schemas: {
      Quality: quality,
      Answer: {
        type: 'object',
        required: ['label', 'detail', 'alt', 'stop', 'quality', 'asOf', 'arrivals'],
        properties: {
          label: {
            type: 'string',
            maxLength: 40,
            description: 'The headline, e.g. `D2 · 4 min`. Display verbatim.',
            example: 'D2 · 4 min',
          },
          detail: { type: 'string', description: 'One line of supporting detail. Display verbatim.' },
          alt: { type: ['string', 'null'], description: 'A second option using a different bus or stop, or null if there is none.' },
          stop: {
            type: 'object',
            description: 'Where to board.',
            required: ['code', 'name', 'confidence'],
            properties: {
              code: { type: 'string' },
              name: { type: 'string' },
              confidence: {
                type: 'number',
                minimum: 0,
                maximum: 1,
                description: 'How sure the API is that this is the right stop. Below ~0.6, treat it as a guess.',
              },
            },
          },
          quality: { $ref: '#/components/schemas/Quality' },
          asOf: {
            type: 'string',
            format: 'date-time',
            description: 'When the data was fetched. On a `stale` answer this is the original fetch time.',
          },
          arrivals: { type: 'array', items: { $ref: '#/components/schemas/Arrival' }, description: 'Raw arrivals at the boarding stop.' },
          departsAt: {
            type: ['string', 'null'],
            format: 'date-time',
            description:
              'When the bus leaves the boarding stop. Count down from this rather than re-showing `label` later. Null with no live time.',
          },
          arriveAt: {
            type: ['string', 'null'],
            format: 'date-time',
            description: 'When you reach the destination stop, by bus or on foot.',
          },
          arrived: {
            type: 'boolean',
            description: 'Already at the destination (either side of the road), so there is no bus or countdown.',
          },
          leave: {
            oneOf: [{ $ref: '#/components/schemas/Leave' }, { type: 'null' }],
            description:
              'The latest time to set off. On `/api/me/next` for a class, the latest that still gets you there on time; otherwise, for the bus in `departsAt`. ' +
              'When you will be late whatever you do, `at` is now, or, when the first bus waits for the service to start, when to leave for that one. Null or absent when you should go now. Once `at` has passed, show "Leave now".',
          },
          bus: {
            oneOf: [{ $ref: '#/components/schemas/BusLeg' }, { type: 'null' }],
            description:
              'The headline bus as a leg: where, when, and how long the walk and the ride take. Absent when the answer is to walk or nothing runs.',
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
              why: {
                type: ['string', 'null'],
                description:
                  'Why not a bus ("D1 would be 16 min", "Services ended for the night"). Null for a short walk with nothing to board.',
              },
            },
          },
        },
      },
      Leave: {
        type: 'object',
        description: 'When to set off, and on which bus: `leave` on GET /api/me/next and on /me/day’s rows.',
        required: ['at', 'estimated', 'svc', 'stop', 'board', 'arrive'],
        properties: {
          at: { type: 'string', format: 'date-time' },
          svc: {
            type: ['string', 'null'],
            description: 'The bus this time is for. For a class it can differ from the headline bus. Null when walking.',
          },
          stop: { type: ['string', 'null'], description: 'Where to board it, short name.' },
          board: {
            type: ['string', 'null'],
            format: 'date-time',
            description: 'When that bus leaves the stop. With `estimated`, when you reach the stop. Null when walking.',
          },
          arrive: {
            type: ['string', 'null'],
            format: 'date-time',
            description: 'When you get there by leaving at `at`: the venue for a class, otherwise the stop.',
          },
          note: {
            type: ['string', 'null'],
            description: 'Why the time is earlier than it could be, e.g. the bus is often busy then. Display verbatim.',
          },
          off: {
            type: 'string',
            description:
              'Where to get off, when the bus only stops across the road from the destination (e.g. `Opp NUSS` for AS 5). `arrive` includes the walk back across. Absent otherwise.',
          },
          stopCode: { type: 'string', description: 'Stop code of `stop`. Absent when walking.' },
          offCode: { type: 'string', description: 'Stop code of `off`. Absent without a crossing.' },
          toStop: {
            type: 'string',
            example: 'UTown',
            description:
              'Where you get off, short name: the destination stop this bus calls at (for a place with several stops, the one it calls at), or `off`. Absent when walking.',
          },
          toCode: { type: 'string', description: 'Stop code of `toStop`. Absent when walking.' },
          paid: { type: 'boolean', enum: [true], description: 'The bus is a public one, with a fare. Absent for a shuttle.' },
          route: {
            type: 'string',
            description:
              'For a public two-way service, its route in the graph (`151/1`), which `svc` (`151`) cannot name. Absent otherwise.',
          },
          estimated: {
            type: 'boolean',
            description: 'Based on the usual gap between buses, or on a timetable, rather than a live time. Show it with a `~`.',
          },
          stale: {
            type: 'boolean',
            enum: [true],
            description:
              'The bus time is from an older reading: live times a few minutes old, or the plan an earlier answer kept for this trip. Exact, but not live now: do not mark it live. Absent otherwise.',
          },
          walkS: { type: 'integer', description: 'Seconds on foot to `stop`. Absent when walking.' },
          rideS: { type: 'integer', description: 'Seconds on the bus. Absent when walking.' },
          endWalkS: {
            type: 'integer',
            description:
              'Without a class to aim at: seconds on foot from where you get off to the place itself (a room, a building, a food court), which `arrive` does not count. A class’s `arrive` is already at its room. Absent for a stop.',
          },
          change: {
            $ref: '#/components/schemas/BusChange',
            description:
              'A trip that changes buses: the second bus. `svc`, `stop`, `stopCode`, `board`, `walkS` and `rideS` are then the first bus; `arrive`, `toStop`, `toCode`, `off` and `offCode` the end of the trip. Absent on one bus.',
          },
        },
      },
      BusChange: {
        type: 'object',
        description: 'The second bus of a trip that changes buses: where the first drops you, where the second goes from, and when.',
        required: ['svc', 'from', 'fromCode', 'stop', 'stopCode', 'reach', 'board', 'rideS', 'estimated'],
        properties: {
          svc: { type: 'string', example: 'P' },
          from: { type: 'string', example: 'Kent Vale', description: 'Where the first bus drops you, short name.' },
          fromCode: { type: 'string', example: 'KV' },
          stop: { type: 'string', description: 'Where the second bus goes from: `from`, or the stop across the road from it.' },
          stopCode: { type: 'string' },
          crossS: { type: 'integer', description: 'Seconds on foot across the road from `from` to `stop`. Absent at the same stop.' },
          reach: { type: ['string', 'null'], format: 'date-time', description: 'When the first bus gets to `from`. Null with no time.' },
          board: { type: ['string', 'null'], format: 'date-time', description: 'When the second bus leaves `stop`. Null with no time.' },
          rideS: { type: 'integer', description: 'Seconds on the second bus.' },
          estimated: { type: 'boolean', description: 'The second bus’s time is not a live one. Show it with a `~`.' },
        },
      },
      Timing: {
        type: 'object',
        description: 'Whether you will make a class: `timing` on GET /api/me/next and on /me/day’s rows.',
        properties: {
          status: { type: 'string', enum: ['on-time', 'tight', 'late'] },
          text: { type: 'string', example: 'Arrive 09:52 · 8 min early' },
          classAt: { type: 'string', format: 'date-time' },
          reachAt: { type: 'string', format: 'date-time', description: 'When you reach the class on the headline bus.' },
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
          paid: {
            type: 'boolean',
            enum: [true],
            description: 'A public bus, with a fare. Absent for a shuttle. Clients mark it, so the user knows there is a fare.',
          },
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
          arrive: {
            type: ['string', 'null'],
            format: 'date-time',
            description: 'When you reach the destination stop. Null with no time.',
          },
          estimated: {
            type: 'boolean',
            description:
              'Not a live time: based on the usual gap between buses or a timetable, or an old reading while the feed is down. Show it with a `~`.',
          },
          off: {
            type: 'string',
            description: 'Where to get off, when the bus only stops across the road from the destination. Absent otherwise.',
          },
          toStop: { type: 'string', description: 'Where you get off, short name: the destination stop this bus calls at, or `off`.' },
          endWalkS: {
            type: 'integer',
            description:
              'Seconds on foot from where you get off to the place itself (a room, a building, a food court), which `arrive` does not count. Absent for a stop.',
          },
          paid: {
            type: 'boolean',
            enum: [true],
            description: 'A public bus (95, 151, …), with a fare, unlike the free shuttle. Absent for a shuttle.',
          },
          change: {
            $ref: '#/components/schemas/BusChange',
            description:
              'Where no single bus goes there: the bus to change to. The fields above are then the first bus, except `arrive`, `toStop` and `off`, which are the end of the trip. Absent on one bus.',
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
          plate: { type: ['string', 'null'], example: 'PD726D', description: 'Null for a public bus: LTA does not publish plates.' },
          berth: {
            type: ['string', 'null'],
            description:
              'The feed’s own code for the stop. At a terminus it tells the departing run from the terminating one; compare it, but don’t read meaning into its format. Null for a public bus.',
          },
          ends: {
            type: 'boolean',
            enum: [true],
            description: 'The bus ends its run at this stop and can’t be boarded here. Absent otherwise.',
          },
          scheduled: {
            type: 'boolean',
            enum: [true],
            description:
              'The time is from the operator’s timetable, not a bus on the road (a public bus LTA reports as unmonitored). Absent for a live time.',
          },
        },
      },
      BoardRow: {
        type: 'object',
        required: [
          'svc',
          'etaS',
          'quality',
          'ambiguousBerth',
          'later',
          'color',
          'towards',
          'via',
          'crowd',
          'endsAt',
          'running',
          'eta',
          'laterText',
          'toText',
        ],
        properties: {
          svc: { type: 'string' },
          etaS: {
            type: ['integer', 'null'],
            description:
              'Seconds from the request until the bus arrives, counted from now even when the feed’s answer is older (a bus whose time passed over a minute ago is left out).',
          },
          eta: {
            type: ['string', 'null'],
            example: '~6 min',
            description:
              '`etaS` in words, in the request’s language: "4 min", "now" under 45 seconds, and a `~` on a `scheduled` or `stale` time ("~6 min", Chinese "约 6 分钟"). Null when `etaS` is. Show it as it is.',
          },
          laterText: {
            type: ['string', 'null'],
            example: 'then 12, ~20 min',
            description:
              'The next few buses after this one, up to two, in whole minutes, each `scheduled` one marked `~`: "then 12, ~20 min" (Chinese "之后 12、约 20 分钟"). Null when `later` is empty.',
          },
          toText: {
            type: 'string',
            example: 'to Central Library, Prince George’s Park Foyer',
            description:
              '`towards` in words: "to A, B" (Chinese "经 A，开往 B"), "to A" with one name (Chinese "开往 A"), or "Ends here" (Chinese "本站为终点站") at the end of the line. A client that sets the next stop in bold finds it as `towards[0]`.',
          },
          quality: { $ref: '#/components/schemas/Quality' },
          ambiguousBerth: {
            type: 'boolean',
            description: 'True when the direction of this service at this stop could not be confirmed.',
          },
          paid: { type: 'boolean', enum: [true], description: 'A public bus, with a fare. Absent for a shuttle.' },
          later: {
            type: 'array',
            description:
              'The buses after the one in `etaS`, soonest first, as far as the feed knows them (usually one more for a shuttle, up to two for a public bus). Each has its own quality: a timetabled one is `scheduled`.',
            items: {
              type: 'object',
              required: ['etaS', 'quality', 'eta'],
              properties: {
                etaS: { type: 'integer' },
                quality: { $ref: '#/components/schemas/Quality' },
                eta: { type: 'string', example: '~15 min', description: '`etaS` in words, as the row’s `eta`.' },
              },
            },
          },
          color: {
            type: ['string', 'null'],
            description: 'The colour of the service, as on the buses (#rrggbb). Null for a public bus.',
          },
          towards: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Where the service goes from this stop, by full name: the next stop, then the stop the route ends at (for a loop, the stop it started from). One name when they are the same, none at the end of the line. Place names stay English in every language.',
            example: ['Central Library', 'Prince George’s Park Foyer'],
          },
          via: {
            type: 'array',
            items: { type: 'string' },
            description:
              'The well-known places the service passes from this stop, in order, up to three (the MRT stations, UTown, PGP, Kent Vale, Central Library, COM 3, BIZ, and the faculties: Arts, Science, Engineering), for someone who does not know the routes yet. Each once, never the place this stop is. A faculty is in the request’s language; a place keeps its English name. Empty when it passes none: show `toText` then.',
            example: ['Central Library', 'Arts', 'BIZ'],
          },
          crowd: {
            type: ['string', 'null'],
            enum: ['low', 'medium', 'high', null],
            description: 'How full the bus in `etaS` is, from the live feed. Null when it gives none, or there is no bus.',
          },
          endsAt: {
            type: ['string', 'null'],
            format: 'date-time',
            description: 'When the service stops running today. Null when its hours are not known.',
          },
          running: {
            type: 'boolean',
            description:
              'False only on a row for a service outside its hours, listed with `?stopped=1`: no time (`etaS` null, `quality` `ended`), no crowding, after every running row.',
          },
          stopped: {
            type: 'string',
            enum: ['ended', 'notYet', 'noService'],
            description:
              'Only when `running` is false: `ended` (it ran today and has finished), `notYet` (it starts later today) or `noService` (it does not run today; Sunday hours on a public holiday).',
          },
          resumesAt: {
            type: ['string', 'null'],
            format: 'date-time',
            description: 'Only when `running` is false: when it next starts, looking up to 8 days ahead. Null when no start is found.',
          },
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
              opposite: {
                type: ['string', 'null'],
                description: 'The code of the stop across the road, or one easily mistaken for it. Null when it has none.',
              },
              oppositeAcross: {
                type: 'boolean',
                description:
                  'True when `opposite` is across the road; false for a stop that is only near (Prince George’s Park and its Foyer), or none.',
              },
              oppositeName: { type: ['string', 'null'], description: 'The full name of `opposite`, null when there is none.' },
            },
          },
          board: { type: 'array', items: { $ref: '#/components/schemas/BoardRow' } },
          asOf: {
            type: 'string',
            format: 'date-time',
            description:
              'When the times on the board were fetched: a cached or `stale` answer’s original fetch time, so "updated N ago" is true.',
          },
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
          endsAt: {
            type: ['string', 'null'],
            format: 'date-time',
            description: 'When the service stops running today. Null when its hours are not known.',
          },
          running: {
            type: 'boolean',
            description:
              'Whether the service is running now: inside its hours, as a board row’s `running` (unknown hours count as running), or with a bus out on the line whatever the hours say.',
          },
          stopped: {
            type: ['string', 'null'],
            enum: ['ended', 'notYet', 'noService', null],
            description: 'Why it is not running, as on a board row. Null while it runs.',
          },
          resumesAt: {
            type: ['string', 'null'],
            format: 'date-time',
            description: 'When it next starts, as on a board row. Null while it runs, or when no start is found in 8 days.',
          },
          stops: {
            type: 'array',
            description: 'The stops in route order. A loop’s first stop is not listed again at its end.',
            items: {
              type: 'object',
              required: ['code', 'name', 'longName', 'services'],
              properties: {
                code: { type: 'string' },
                name: { type: 'string' },
                longName: {
                  type: 'string',
                  description: 'The name in full (Yusof Ishak House for YIH), for where there is room for it.',
                },
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
                id: { type: 'string', description: 'The same as on `/api/buses`.' },
                plate: { type: 'string' },
                crowd: { type: ['string', 'null'], enum: ['low', 'medium', 'high', null] },
                at: { type: ['integer', 'null'], description: 'The index in `stops` of the stop the bus is at; null between stops.' },
                after: {
                  type: ['integer', 'null'],
                  description:
                    'Between stops: the index in `stops` of the stop it passed. It is on its way to the next one (the first, after a loop’s last). Null at a stop.',
                },
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
              row: {
                oneOf: [{ $ref: '#/components/schemas/BoardRow' }, { type: 'null' }],
                description:
                  'The service’s row on the stop’s board, as `/api/arrivals?stopped=1` gives it: a service outside its hours has a row with `running: false`.',
              },
            },
          },
          available: { type: 'boolean', description: 'False when the live feed could not be reached.' },
          asOf: {
            type: 'string',
            format: 'date-time',
            description:
              'How old the oldest thing on the page is: the buses, or the `stop` row when its board was kept or stale. For "Updated 5 s ago"; the row’s `etaS` already counts from the request.',
          },
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
              required: [
                'id',
                'plate',
                'lat',
                'lon',
                'along',
                'heading',
                'moving',
                'crowd',
                'at',
                'slot',
                'stretch',
                'nextStop',
                'upcoming',
                'towards',
              ],
              properties: {
                id: { type: 'string', description: 'Stable for a bus while it runs.' },
                plate: { type: 'string', example: 'PD726D', description: 'The bus’s number plate, as painted on it.' },
                lat: {
                  type: 'number',
                  description: 'Where to draw the bus: the stop’s own position when it is at a stop, else a point on its route line.',
                },
                lon: { type: 'number' },
                along: {
                  type: 'number',
                  description:
                    'Metres along the service’s route line in `/api/campus` (`routes[svc].line`) of that place (at a stop, the stop’s place on the line), so a map can move the bus along the road from one place to the next. It does not go back between answers, except past the start of a loop, or when a bus first placed on the wrong side of the road is put right.',
                },
                heading: {
                  type: ['integer', 'null'],
                  description: 'The way the road runs there, the way the bus is going: degrees clockwise from north.',
                },
                moving: { type: 'boolean' },
                crowd: { type: ['string', 'null'], enum: ['low', 'medium', 'high', null] },
                at: {
                  type: ['object', 'null'],
                  description: 'The stop the bus is at (within 40 metres of it along its route), or null between stops.',
                  properties: { code: { type: 'string' }, name: { type: 'string' } },
                },
                slot: {
                  type: 'integer',
                  minimum: 0,
                  description: 'At a stop, its place among the buses there: 0 for the one in front, then 1, 2 behind it. 0 between stops.',
                },
                stretch: {
                  type: ['object', 'null'],
                  description:
                    'Between stops, the part of its route line the bus is somewhere on: from the stop it passed (`last`) to its next stop, in metres along the line (`from`, `to`). Null at a stop.',
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
                upcoming: {
                  type: 'array',
                  description:
                    'The stops still ahead of the bus on its line, in order: `nextStop` first, then on to where the line ends (round a loop, back to its first stop). Empty past the end of a line that does not loop.',
                  items: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' } } },
                },
                towards: {
                  type: 'object',
                  description: 'Where the bus’s line ends: the first stop of a loop, the last stop of a line that does not loop.',
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
          viewBox: {
            type: 'string',
            deprecated: true,
            description: 'SVG viewBox the x/y coordinates are projected into. Kept for older clients; draw from `lat`/`lon` instead.',
          },
          stops: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                name: { type: 'string' },
                longName: { type: 'string' },
                opposite: { type: ['string', 'null'], description: 'The stop across the road, if any.' },
                x: {
                  type: 'number',
                  deprecated: true,
                  description: 'Projected into `viewBox`. Kept for older clients; use `lat`/`lon`.',
                },
                y: { type: 'number', deprecated: true, description: 'As `x`.' },
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
                loop: {
                  type: 'boolean',
                  description:
                    'True when the service runs round and starts again where it began. A bus on a loop goes on past the start of `line` (its `along` starts again from 0); the two ends of `line` need not meet.',
                },
                color: { type: 'string', description: "The service's colour, as on the buses." },
                line: {
                  type: 'array',
                  items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
                  description: 'The path to draw, as [lon, lat] pairs (GeoJSON LineString coordinates).',
                },
                shaped: {
                  type: 'boolean',
                  description:
                    'True when `line` follows the roads (OpenStreetMap); false when it is straight lines between stops, because the stops changed since the road shapes were last made.',
                },
              },
            },
          },
          residences: {
            type: 'array',
            description:
              'On-campus residences and the stops that serve each, for picking home stops: the common ones first, then by name. Outlines are not included.',
            items: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                name: { type: 'string' },
                stops: { type: 'array', items: { type: 'string' } },
                walkM: { type: 'integer', description: 'Metres on foot from the residence to its nearest stop (the first in `stops`).' },
                walkMin: {
                  type: 'integer',
                  minimum: 1,
                  example: 3,
                  description:
                    'That walk in whole minutes at the normal pace (1.3 m/s), never under 1: what a picker shows beside the residence.',
                },
                common: {
                  type: 'boolean',
                  description: 'Where most students live (PGP, UTown Residence). Pickers show these in their own group at the top.',
                },
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
                kind: {
                  type: 'string',
                  enum: ['stop', 'landmark', 'building', 'room'],
                  description: '`landmark`: a named place such as a food court, served by every stop in `stops`.',
                },
                stops: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Landmarks only: every stop that serves it. Send its `code` as `to` and the quicker one is used.',
                },
                detail: { type: 'string', description: 'Landmarks only: what it is, in the request’s language, e.g. "Food court".' },
                walkM: { type: 'integer', description: 'Metres on foot from `stopCode`, along campus paths. Absent for a stop.' },
                aliases: { type: 'array', items: { type: 'string' }, description: 'Other names people search for, lower case.' },
              },
            },
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
          offCampus: {
            type: 'boolean',
            enum: [true],
            description: 'The room is far from every stop (Duke-NUS, the hospital): no shuttle goes there. Absent otherwise.',
          },
        },
      },
      Class: {
        type: 'object',
        required: ['day', 'arriveByMin', 'to', 'label'],
        properties: {
          day: { type: 'integer', minimum: 0, maximum: 6, description: '0 = Sunday.' },
          arriveByMin: { type: 'integer', minimum: 0, maximum: 1439, description: 'Class start, minutes past midnight SGT.' },
          endMin: { type: 'integer', maximum: 1440, description: 'Class end, minutes past midnight SGT. After `arriveByMin`.' },
          to: { type: 'string', description: 'Destination: a stop code, or a place code (a `landmark` in `/api/campus`).' },
          label: {
            type: 'string',
            minLength: 1,
            maxLength: 60,
            description: 'Saved on one line: line breaks and control characters become spaces.',
          },
          venue: { type: 'string', maxLength: 40, description: 'The NUSMods room, such as `COM1-0212`. Longer is cut to 40 characters.' },
          weeks: {
            description:
              'From NUSMods: the teaching weeks the class runs in, or the dates it runs between (real dates, `start` not after `end`; every `weekInterval` weeks, or only the `weeks` of the range counted from `start`). ' +
              'Absent: every teaching week of the semester in `term`. A class in `manual`, entered by hand, runs every week whatever this says.',
            oneOf: [
              { type: 'array', maxItems: 20, items: { type: 'integer', minimum: 1, maximum: 20 } },
              {
                type: 'object',
                required: ['start', 'end'],
                properties: {
                  start: { type: 'string', format: 'date' },
                  end: { type: 'string', format: 'date' },
                  weekInterval: { type: 'integer', minimum: 1, maximum: 10 },
                  weeks: { type: 'array', maxItems: 30, items: { type: 'integer', minimum: 1, maximum: 30 } },
                },
              },
            ],
          },
        },
      },
      Profile: {
        type: 'object',
        properties: {
          home: {
            type: ['object', 'null'],
            description: 'Null when no home is set (an empty `stops` is saved as null).',
            properties: {
              stops: {
                type: 'array',
                maxItems: 3,
                items: { type: 'string' },
                description: 'Usual boarding stops near home, best first. Repeats are dropped.',
              },
              lat: {
                type: 'number',
                deprecated: true,
                writeOnly: true,
                description: 'Accepted from older clients and ignored: never kept or returned.',
              },
              lon: { type: 'number', deprecated: true, writeOnly: true, description: 'As `lat`: ignored.' },
            },
          },
          gapHours: {
            type: 'number',
            minimum: 0.5,
            maximum: 12,
            default: 2,
            description: 'A gap between classes longer than this means going home in between.',
          },
          dayStartMin: {
            type: 'integer',
            minimum: 0,
            maximum: 1439,
            default: 360,
            description: 'Start of your day, minutes past midnight SGT; before `dayEndMin`. Earlier, `/api/me/next` rests.',
          },
          dayEndMin: {
            type: 'integer',
            minimum: 0,
            maximum: 1439,
            default: 1080,
            description: 'End of your day; after `dayStartMin`. Later, `/api/me/next` rests, unless a class runs late.',
          },
          walkPace: {
            type: 'string',
            enum: ['slow', 'normal', 'fast'],
            default: 'normal',
            description: 'How fast you walk: 1.1, 1.3 or 1.5 m/s. Scales every walk except `homeWalkMin`.',
          },
          fullBusMargin: {
            type: 'boolean',
            default: true,
            description: 'Aim one bus earlier when the bus to wait for is often busy at that stop and time.',
          },
          publicBuses: {
            type: 'boolean',
            default: false,
            description:
              'Count the public buses (95, 151, 96 and others) at the campus’s stops too, on `/api/me/next` and `/api/me/nearby`. They have a fare, so one is the answer only when it clearly saves time over the free shuttle, and its leg carries `paid: true`. Off until the user turns it on.',
          },
          preferBus: {
            type: 'boolean',
            default: true,
            description:
              'Prefer the bus to walking: when choosing between walking and the bus, or between stops, a minute on foot counts as 1.5 minutes waiting or riding. Times shown are not changed. Off, they count the same.',
          },
          seen: {
            type: 'array',
            maxItems: 20,
            items: { type: 'string', pattern: '^[a-z0-9-]{1,32}$' },
            description: 'One-time screens already shown, e.g. `onboarding`. Repeats are dropped.',
          },
          pinnedStops: {
            type: 'array',
            maxItems: 8,
            uniqueItems: true,
            default: [],
            items: { type: 'string' },
            description:
              'Stops pinned to the Buses tab, in the order to show them: shuttle stop codes, or LTA’s five-digit code for a public stop of its own. Repeats are dropped.',
          },
          homeWalkMin: {
            type: 'integer',
            minimum: 0,
            maximum: 30,
            default: 5,
            description:
              'Minutes from home to your nearest home stop. Counts when a trip starts from home without a location, and as the least walk to your home stops when the location is inside the residence they serve (the lift and the stairs count, the outline cannot tell which floor you are on).',
          },
          lang: {
            type: 'string',
            enum: ['auto', 'en', 'zh'],
            default: 'auto',
            description:
              "The language terminus writes in: answers, cards, emails and errors. `auto` follows each request's `Accept-Language` (any `zh*` is Simplified Chinese); `?lang=en|zh` on a request overrides it, and a set `lang` here overrides both.",
          },
          clock: {
            type: 'string',
            enum: ['auto', '12', '24'],
            default: 'auto',
            description:
              'Clock times in answers and cards, 12-hour ("6:36 PM") or 24-hour ("18:36"). `auto` follows each request (`?h12=1` for 12-hour); `12` or `24` here overrides it, so every device shows the same.',
          },
          trips: { type: 'array', items: { $ref: '#/components/schemas/Class' }, description: 'From the NUSMods import.' },
          manual: { type: 'array', items: { $ref: '#/components/schemas/Class' }, description: 'Entered by hand. Kept on re-import.' },
          places: {
            type: 'array',
            maxItems: 12,
            description:
              "Favourites: one-tap destinations. The apps set `label` to the name of what was picked (a stop, a food court, or a building's code).",
            items: {
              type: 'object',
              required: ['key', 'label', 'to'],
              properties: {
                key: { type: 'string', pattern: '^[a-z0-9-]{1,24}$' },
                label: { type: 'string', maxLength: 24, description: 'Saved on one line, as a class’s `label`.' },
                to: { type: 'string' },
              },
            },
          },
          usual: {
            type: 'array',
            maxItems: 30,
            description:
              'Favourites with a usual time ("Gym, Tuesdays 18:00"): each is a trip on that day like a class, arriving by `atMin`, then an hour there. One whose place is gone is ignored.',
            items: {
              type: 'object',
              required: ['place', 'day', 'atMin'],
              properties: {
                place: { type: 'string', description: "A favourite's key." },
                day: { type: 'integer', minimum: 0, maximum: 6 },
                atMin: { type: 'integer', minimum: 0, maximum: 1439 },
              },
            },
          },
          once: {
            type: 'array',
            maxItems: 10,
            description:
              'One-off trips, planned like a class on their date only. Past dates are dropped on save. POST /api/me/once adds one.',
            items: {
              type: 'object',
              required: ['date', 'arriveByMin', 'to', 'label'],
              properties: {
                date: { type: 'string', format: 'date' },
                arriveByMin: { type: 'integer', minimum: 0, maximum: 1439 },
                to: { type: 'string' },
                label: { type: 'string', maxLength: 60 },
              },
            },
          },
          share: { type: ['string', 'null'], maxLength: 2000, description: 'The NUSMods share link last imported.' },
          term: {
            type: ['object', 'null'],
            description:
              'The semester `trips` were imported for, set by the import. Null before the first. Imported classes run only in its teaching weeks, and it is how terminus knows the timetable is out of date. ' +
              'Send it back as it came: a PUT without it clears it.',
            required: ['acadYear', 'semester'],
            properties: {
              acadYear: { type: 'string', pattern: '^\\d{4}/\\d{4}$', example: '2026/2027' },
              semester: { type: 'integer', minimum: 1, maximum: 4, description: '3 and 4 are the special terms.' },
            },
          },
          limits: {
            type: 'object',
            readOnly: true,
            description:
              'Sent with the profile (GET and PUT /api/me/profile, the import, the merge): the limits the server enforces, so an app’s fields and pickers stop where it does. Ignored when sent back.',
            required: ['pinnedStops', 'label', 'places', 'placeLabel', 'homeStops', 'homeWalkMin', 'trips', 'usual', 'once'],
            properties: {
              pinnedStops: { type: 'integer', example: 8, description: 'Most stops in `pinnedStops`.' },
              label: { type: 'integer', example: 60, description: 'Longest name of a class or a one-off trip, in characters.' },
              places: { type: 'integer', example: 12, description: 'Most favourites.' },
              placeLabel: { type: 'integer', example: 24, description: 'Longest name of a favourite, in characters.' },
              homeStops: { type: 'integer', example: 3, description: 'Most home stops.' },
              homeWalkMin: {
                type: 'object',
                properties: { min: { type: 'integer', example: 0 }, max: { type: 'integer', example: 30 } },
                description: 'The range of `homeWalkMin`, inclusive.',
              },
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
                enum: ['trip', 'rest', 'free'],
                description:
                  '`rest` outside your day hours: no bus, and `detail` names your next class. Show a rest state, not a bus. ' +
                  '`free` on a day with no classes, or none left to plan (and for a new account with no timetable yet): nothing to catch, so no bus in the headline; `card.upcoming` has the next class.',
              },
              warning: {
                type: ['string', 'null'],
                example: 'Last D2 from UTown in 18 min',
                description:
                  'On the way home near the end of service: the last bus is soon. Absent or null otherwise. Also in `card.warning`.',
              },
              card: {
                type: 'object',
                description:
                  'The answer worded for display, the same on every app: headline parts, the phase of the trip, `actions` (buttons), `warning`, and `notice`, ' +
                  'a line to show above the answer while NUS’s live bus times are down ("NUS’s live bus times have been down since 9:14 AM"), or null. Show its strings as they are.',
                properties: {
                  kind: {
                    type: 'string',
                    enum: ['class', 'trip', 'rest', 'arrived', 'setup', 'free'],
                    description:
                      'What the card is: a class with a leave-by, any other trip, resting outside your day, there already, nothing to start from (`setup`), or a day with nothing to catch (`free`).',
                  },
                  title: {
                    type: 'string',
                    example: 'D2 · 09:42',
                    description:
                      'The headline. With a bus to count down to, its service and departure as a clock time ("D2 · 09:42", "~09:42" for an estimate, Chinese "约 09:42"), which stays true until the bus leaves; otherwise `label` as it is ("Walk · 8 min", "No classes today").',
                  },
                  heading: {
                    type: ['string', 'null'],
                    example: 'Next class · CS2030 @ COM1',
                    description:
                      'The small line above the card, from `dest.why`: "Next class · X", "Long gap · Home", "Heading home" or "Going to X" (Chinese "下一节课 · X", "空档较长 · 回家", "回家", "去 X"). Null with no destination (`rest`, `free`).',
                  },
                  remindAt: {
                    type: ['string', 'null'],
                    format: 'date-time',
                    example: '2026-08-27T01:31:40Z',
                    description:
                      'When to post the leave reminder: `leave.at` less five minutes (when the trip turns `due`). Null when there is none to post: reminders off for the trip (`remind` false), not a class, no leave-by, the trip under way or over (any phase but `idle` and `due`), or the class has started. ' +
                      'Schedule it on the device; at `leave.at` the reminder becomes "Leave now".',
                  },
                  staleAt: {
                    type: ['string', 'null'],
                    format: 'date-time',
                    description:
                      'Dim the answer from this instant: the bus has gone, the plan has moved on, or it is 15 minutes old. Null: never on its own.',
                  },
                  crowd: {
                    type: ['string', 'null'],
                    example: 'Crowding: medium',
                    description: 'How full the headline bus is, in words.',
                  },
                  quality: {
                    type: ['string', 'null'],
                    example: 'Estimated time',
                    description:
                      'What is less than live about the times: "Estimated time", "Live times are a few minutes old", "No live data". Null when they are live.',
                  },
                  leaveBy: {
                    type: ['string', 'null'],
                    example: 'Leave by ~09:36',
                    description:
                      'The leave-by. Say "Leave now" once `leave.at` passes, except at the stop (phase `waiting`), where it is the bus to wait for ("D2 at 09:41"), shown as it is.',
                  },
                  leaveVia: {
                    type: ['string', 'null'],
                    example: 'catch the 09:38 D2 at PGP',
                    description: 'After the leave-by on trips that are not classes. A public bus is "95 ($)".',
                  },
                  catch: {
                    type: ['string', 'null'],
                    example: 'Catch the ~09:42 R2 at PGP',
                    description: 'Class only: the bus to catch, or "Walk there".',
                  },
                  arrive: {
                    type: ['string', 'null'],
                    example: 'Arrive ~09:51 · 9 min early',
                    description: 'Class only: when you get there and how early or late.',
                  },
                  catchLine: {
                    type: ['string', 'null'],
                    description: 'Class only: `catch` and `arrive` on one line, for a widget or notification.',
                  },
                  late: { type: 'boolean', description: 'Class only: the arrival misses the start.' },
                  goNow: {
                    type: ['string', 'null'],
                    example: 'Or go now: R2 at 09:06 · arrive 09:15',
                    description: 'Class only: the headline bus, when it is not the one to wait for.',
                  },
                  note: { type: ['string', 'null'], description: 'Class only: why the leave-by is earlier than it could be.' },
                  estimate: {
                    type: ['string', 'null'],
                    description: 'Class only: said under a leave-by that rests on the usual gap between buses.',
                  },
                  phase: {
                    type: 'string',
                    enum: ['idle', 'due', 'heading', 'waiting', 'riding', 'missed', 'arrived'],
                    description: 'Where the trip is. `idle` with no trip in progress.',
                  },
                  phaseText: {
                    type: ['string', 'null'],
                    example: 'On your way',
                    description: 'A few words on the phase, above the answer. Null when idle or there.',
                  },
                  glance: {
                    type: 'string',
                    maxLength: 12,
                    example: 'D2 09:41',
                    description:
                      'For a watch face, the menu bar or a tile. Never a minute count, which would freeze while nothing refreshes: outside a trip, the headline bus and its clock time ("D2 09:41", "D2 ~9:41a" 12-hour); in a trip, its phase ("Leave 9:36a", "Off 09:51"); otherwise a word or two ("Set up", "No classes").',
                  },
                  line: {
                    type: 'string',
                    example: 'Leave by ~09:36 · R2 from PGP',
                    description: 'One line, for a collapsed notification or a compact widget.',
                  },
                  actions: {
                    type: 'array',
                    description: 'Buttons to show, in order. Send `id` and `trip` to POST /api/me/signal.',
                    items: {
                      type: 'object',
                      required: ['id', 'label', 'trip'],
                      properties: {
                        id: { type: 'string', enum: ['boarded', 'missed', 'skipped', 'arrived', 'reset', 'away', 'back'] },
                        label: { type: 'string', example: 'Not going' },
                        trip: { type: 'string', example: '4:600:UTOWN' },
                      },
                    },
                  },
                  warning: { type: ['string', 'null'], example: 'Last D2 from UTown in 18 min' },
                  nextChangeAt: {
                    type: ['string', 'null'],
                    format: 'date-time',
                    description:
                      'When this card is next expected to change by itself (the next phase, or going stale): fetch again then. A leave-by counts here no sooner than 30 s ahead, so a late bus sliding it does not mean polling every few seconds.',
                  },
                  remind: { type: 'boolean', description: 'False when the user turned reminders off for this trip. See `remindAt`.' },
                  suggestion: {
                    type: ['object', 'null'],
                    description:
                      'Something terminus has learned and offers to change, with its two buttons: send `id` and the choice to POST /api/me/choice. Never during a trip.',
                    properties: {
                      id: { type: 'string', example: 'earlier:4:600:UTOWN' },
                      text: { type: 'string' },
                      accept: { type: 'string', example: 'Leave earlier' },
                      dismiss: { type: 'string', example: 'No thanks' },
                    },
                  },
                  ride: {
                    type: ['object', 'null'],
                    description:
                      'On the bus: the stops from boarding to getting off, and the board and arrival times, for a progress bar. Null otherwise.',
                    required: ['svc', 'color', 'stops', 'board', 'arrive'],
                    properties: {
                      svc: { type: 'string', example: 'R2' },
                      color: { type: 'string', example: '#34a853', description: 'The service’s colour, `#rrggbb`.' },
                      stops: {
                        type: 'array',
                        items: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' } } },
                      },
                      board: { type: 'string', format: 'date-time' },
                      arrive: { type: 'string', format: 'date-time' },
                      change: {
                        type: 'object',
                        description:
                          'On the first bus of a trip that changes buses: the bus to change to. `stops` then end where you change. Absent otherwise.',
                        required: ['svc', 'color', 'stop', 'board', 'text'],
                        properties: {
                          svc: { type: 'string', example: 'P' },
                          color: { type: 'string', description: 'The service’s colour, `#rrggbb`.' },
                          stop: { type: 'string', example: 'Kent Vale', description: 'Where it goes from.' },
                          board: { type: ['string', 'null'], format: 'date-time', description: 'When it leaves. Null with no time.' },
                          text: {
                            type: 'string',
                            example: 'Then P at 09:42 from Kent Vale',
                            description: 'Show under the progress bar, as it is.',
                          },
                        },
                      },
                    },
                  },
                  gone: {
                    type: 'boolean',
                    description:
                      'The planned bus has left and nothing says whether you are on it: `line` says it has gone and gives the next way there. Notify with that line, quietly, never "Leave now".',
                  },
                  walkTo: {
                    type: ['object', 'null'],
                    description:
                      'Where to walk to now, for a maps app: the stop to catch the bus at, or the destination’s stop on foot. Null on the bus, at the stop, once there, and with nothing to catch.',
                    properties: { name: { type: 'string' }, lat: { type: 'number' }, lon: { type: 'number' } },
                  },
                  notice: { type: ['string', 'null'] },
                  h12: { type: 'boolean', description: 'The card’s times are 12-hour. Write any time you show yourself the same way.' },
                  journey: {
                    type: ['object', 'null'],
                    description:
                      'The trip as steps, for apps that draw it (a line from you to the destination, or a list of steps): walk to the stop, take the bus, get there, and walk on when the destination is a room or building away from the stop. ' +
                      'On foot the whole way it is the walk alone: `bus`, `boardAt` and `ride` are null, `walk` is the whole walk and `why` says why not a bus. ' +
                      'Null on the bus, once there, and with no time to give. Count down to `leave.at` and `boardAt` yourself; show the strings as they are.',
                    required: [
                      'leave',
                      'walk',
                      'bus',
                      'boardAt',
                      'ride',
                      'off',
                      'to',
                      'toStop',
                      'arrive',
                      'walkEnd',
                      'arriveStop',
                      'slack',
                      'live',
                      'backup',
                      'why',
                      'change',
                      'title',
                      'place',
                      'byText',
                      'walkText',
                      'rideText',
                      'walkEndText',
                      'arriveText',
                      'arriveWhere',
                      'backupText',
                      'summary',
                    ],
                    properties: {
                      leave: { type: ['string', 'null'], description: 'When to set off ("4:01 PM", "~4:01 PM"). Null when it is now.' },
                      walk: {
                        type: ['string', 'null'],
                        description: 'The walk to the stop ("3 min"). Null at the stop. On foot, the whole walk there.',
                      },
                      bus: {
                        oneOf: [{ $ref: '#/components/schemas/JourneyBus' }, { type: 'null' }],
                        description: 'The bus to catch. Null on foot.',
                      },
                      boardAt: {
                        type: ['string', 'null'],
                        format: 'date-time',
                        description: 'When the bus leaves, to count down to. Null on foot.',
                      },
                      ride: { type: ['string', 'null'], description: 'Time on the bus ("3 min"). Null on foot.' },
                      off: {
                        type: ['string', 'null'],
                        description: 'Where to get off, when that is across the road from the destination.',
                      },
                      to: { type: 'string', description: 'Where you are going ("GEA1000 @ UTown").' },
                      toStop: { type: 'string', description: 'The stop you get off at ("UTown"), short enough for the end of a line.' },
                      arrive: {
                        type: ['string', 'null'],
                        description: 'When you get there ("4:08 PM"): to the room or building itself when `walkEnd` is set.',
                      },
                      walkEnd: {
                        type: ['string', 'null'],
                        description:
                          'The walk from `toStop` to where you are going ("2 min"): a class’s room, a building or room searched for, a food court. Null when the destination is the stop.',
                      },
                      arriveStop: {
                        type: ['string', 'null'],
                        description: 'When the bus gets to `toStop` ("4:06 PM"). The same as `arrive` when `walkEnd` is null.',
                      },
                      slack: { type: ['string', 'null'], description: 'A class only: "3 min early", "2 min late".' },
                      live: { type: 'boolean', description: 'The bus’s time is live, not an estimate.' },
                      backup: {
                        oneOf: [{ $ref: '#/components/schemas/JourneyBus' }, { type: 'null' }],
                        description: 'Another bus: the next one for a trip, or for a class the sooner bus to go now on.',
                      },
                      why: { type: ['string', 'null'], description: 'On foot: why not a bus ("D1 would be 16 min"). Null with a bus.' },
                      change: {
                        type: ['object', 'null'],
                        description:
                          'A trip that changes buses: off `bus` at `from`, across the road to `stop` when it is not the same stop, and on to the second bus. ' +
                          '`bus` is then the first bus, and `ride` and `rideText` name the change too ("14 min, then P"), for an app that draws one bus; one that draws both uses `firstRide` and `firstRideText` for the first. Null on one bus and on foot.',
                        required: [
                          'from',
                          'stop',
                          'reach',
                          'walk',
                          'wait',
                          'bus',
                          'boardAt',
                          'ride',
                          'firstRide',
                          'firstRideText',
                          'changeText',
                          'rideText',
                        ],
                        properties: {
                          from: { type: 'string', example: 'Kent Vale', description: 'Where the first bus drops you.' },
                          stop: { type: 'string', description: 'Where the second bus goes from: `from`, or the stop across the road.' },
                          reach: {
                            type: 'string',
                            example: '09:37',
                            description: 'When the first bus gets to `from` ("~09:37" for an estimate).',
                          },
                          walk: { type: ['string', 'null'], description: 'The walk across the road ("1 min"). Null at the same stop.' },
                          wait: {
                            type: ['string', 'null'],
                            example: '5 min',
                            description: 'The wait there for the second bus. Null under a minute.',
                          },
                          bus: { $ref: '#/components/schemas/JourneyBus' },
                          boardAt: { type: 'string', format: 'date-time', description: 'When the second bus leaves, to count down to.' },
                          ride: { type: 'string', example: '14 min', description: 'Time on the second bus.' },
                          firstRide: { type: 'string', example: '14 min', description: 'Time on the first bus.' },
                          firstRideText: {
                            type: 'string',
                            example: '14 min ride · off at Kent Vale',
                            description: 'The first bus’s step, in place of `rideText`.',
                          },
                          changeText: {
                            type: 'string',
                            example: 'Change at Kent Vale · 5 min wait',
                            description: 'The change as a step.',
                          },
                          rideText: {
                            type: 'string',
                            example: '14 min ride',
                            description: 'The second bus’s step, with where to get off when that is across the road.',
                          },
                        },
                      },
                      title: {
                        type: 'string',
                        example: 'To GEA1000 @ UTown · starts 10:00',
                        description:
                          'Where to, with a class’s start ("To X · starts 10:00"; Chinese "去 X · 10:00 开始", "回家" for home).',
                      },
                      place: {
                        type: 'string',
                        example: 'GEA1000',
                        description: 'Where you are going, short enough for the end of a line: `to` without its " @ " part.',
                      },
                      byText: {
                        type: ['string', 'null'],
                        example: 'by ~09:36',
                        description: 'Under the leave countdown, until it is time to go. Null when `leave` is, and at the stop.',
                      },
                      walkText: {
                        type: ['string', 'null'],
                        example: '5 min walk',
                        description: '`walk` as a step: the walk to the stop, or the whole walk on foot. Null when `walk` is.',
                      },
                      rideText: {
                        type: ['string', 'null'],
                        example: '10 min ride · off at Opp NUSS',
                        description: '`ride` as a step, with where to get off when that is across the road. Null on foot.',
                      },
                      walkEndText: {
                        type: ['string', 'null'],
                        example: '2 min walk',
                        description: '`walkEnd` as a step, from `toStop` to the place. Null when `walkEnd` is.',
                      },
                      arriveText: {
                        type: ['string', 'null'],
                        example: 'Arrive ~09:51 · 9 min early',
                        description: 'When you get there, with a class’s slack. Null when `arrive` is.',
                      },
                      arriveWhere: {
                        type: 'string',
                        example: '2 min walk from UTown',
                        description: 'Under the arrival: the walk on from `toStop`, or "at UTown".',
                      },
                      backupText: {
                        type: ['string', 'null'],
                        example: 'Or go now: R2 at 09:06 from PGP',
                        description:
                          'The other way: for a class the sooner bus to go now on ("Or go now: R2 at 09:06 from PGP"), for a trip the other bus ("Or A1 at 09:09 from PGP"), on foot `why`. A public bus is "95 ($)". Null with none.',
                      },
                      summary: {
                        type: 'string',
                        example: 'arrive ~09:51 · R2 ~09:42 at PGP',
                        description:
                          'The trip on one line, most needed first, for a compact widget: a class’s arrival then its bus ("arrive ~09:51 · R2 ~09:42 at PGP"), the walk to the stop then the bus ("Walk to PGP · A1 09:09"), the bus at the stop ("A1 09:09 at PGP"), or on foot the walk and why ("8 min walk · D1 would be 16 min").',
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
                      when: {
                        type: 'string',
                        example: 'Tomorrow · Tue',
                        description: '"Today", "Tomorrow · Tue", a weekday, or a date ("Mon 28 Sep").',
                      },
                      title: { type: 'string', example: 'CS2030 at 10:00' },
                      where: {
                        type: 'string',
                        example: 'At COM1 · get off at COM 3',
                        description: 'The room and the stop to get off at, or the stop alone when the room is at it.',
                      },
                      off: {
                        type: ['string', 'null'],
                        description: 'Why today has no classes, when it is a break ("Recess week", a holiday).',
                      },
                    },
                  },
                },
              },
              walkSpeedMs: {
                type: 'number',
                description:
                  'The user’s walking speed in metres a second, from their walking pace (1.1, 1.3 or 1.5). For walk times an app works out itself from metres, such as `walkM` in search results.',
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
                description:
                  'Planned answers only: the next moment the plan changes by itself (a class starts or ends, the day starts or ends). Refresh then, and when `departsAt` passes.',
              },
              timing: {
                oneOf: [{ $ref: '#/components/schemas/Timing' }, { type: 'null' }],
                description: 'For a class: whether you will make it, counting the walk from the stop to the venue.',
              },
            },
          },
        ],
      },
      Choice: {
        type: 'object',
        description: 'A class you leave one bus earlier for (`earlier`), or get no reminders for (`quiet`).',
        properties: {
          trip: { type: 'string', example: '4:600:UTOWN' },
          pref: { type: 'string', enum: ['earlier', 'quiet'] },
          label: { type: ['string', 'null'] },
          since: { type: 'string', format: 'date-time' },
        },
      },
      OperatorSession: {
        type: 'object',
        required: ['session', 'expires'],
        properties: {
          session: { type: 'string', description: 'Send it in `x-health-token`, as the operator token.' },
          expires: { type: 'string', format: 'date-time' },
        },
      },
      Health: {
        type: 'object',
        required: ['ok', 'now', 'sgt', 'graph', 'calendar', 'config', 'upstream'],
        properties: {
          ok: { type: 'boolean', description: 'False when the answer is a 503.' },
          now: { type: 'string', format: 'date-time' },
          sgt: { type: 'string', example: '09:14 day1', description: 'Singapore time and weekday (0 = Sunday).' },
          graph: {
            type: 'object',
            properties: {
              generated: { type: 'string', description: 'When the stop graph was scraped.' },
              source: { type: 'string' },
              stops: { type: 'integer' },
              services: { type: 'array', items: { type: 'string' } },
            },
          },
          calendar: {
            type: 'object',
            description:
              'The academic calendar: the last day it covers, and whether it is the copy bundled at deploy or one the weekly check fetched since.',
            properties: {
              through: { type: 'string', format: 'date' },
              daysLeft: { type: 'integer', description: 'Whole days until then; 0 or less is unhealthy.' },
              source: { type: 'string', enum: ['bundled', 'fetched'] },
            },
          },
          config: {
            type: 'object',
            description: 'Whether each setting is configured, never its value.',
            properties: {
              auth: { type: 'boolean', description: 'The NUS feed’s guest sign-in.' },
              proxy: { type: 'boolean', description: 'The NUS feed itself.' },
              publicBuses: { type: 'boolean', description: 'LTA DataMall, for the public buses.' },
              analytics: { type: 'boolean' },
              accounts: { type: 'boolean', description: 'The account database.' },
              email: { type: 'boolean', description: 'Sign-in and other emails can be sent.' },
              alerts: { type: 'boolean', description: 'Feed alerts are emailed to the operator.' },
              pushAndroid: { type: 'boolean' },
              pushWeb: { type: 'boolean' },
              pushIos: { type: 'boolean', description: 'APNs, to the iPhone app: its key, key id, team id and topic are all set.' },
            },
            additionalProperties: { type: 'boolean' },
          },
          upstream: {
            type: ['object', 'null'],
            description:
              'The NUS feed as the 15-minute check last saw it. Null before its first run. `cronStale`: the checks have stopped.',
            properties: {
              up: { type: 'boolean' },
              since: { type: 'string', format: 'date-time' },
              checkedAt: { type: 'string', format: 'date-time' },
              cronStale: { type: 'boolean' },
            },
          },
          auth: {
            type: 'object',
            description: 'Operator only, with `probe=1`: whether a guest token for the NUS feed can be had (never the token).',
            properties: {
              ok: { type: 'boolean' },
              cached: { type: 'boolean' },
              domain: { type: 'string' },
              expiresIn: { type: 'string', example: '23h' },
              reason: { type: 'string' },
            },
          },
          versions: {
            type: 'object',
            description:
              'Operator only, with `versions=1`: the uNivUS version sent now, what the app stores list, and the versions an automatic update would try.',
            properties: {
              current: { type: 'string' },
              play: { type: ['string', 'null'] },
              apkcombo: { type: ['string', 'null'] },
              errors: { type: 'array', items: { type: 'string' } },
              wouldTry: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: { type: 'string' },
          update: { type: 'boolean', description: 'True with a 426: the app must be updated before it is served again.' },
        },
        additionalProperties: true,
      },
    },
  };
}
