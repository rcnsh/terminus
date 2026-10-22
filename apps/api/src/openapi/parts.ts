/** What the spec's paths and schemas share: parameters, responses and the example answer. */

export const quality = {
  type: 'string',
  enum: ['live', 'scheduled', 'unknown', 'stale', 'ended'],
  description:
    'How reliable the answer is, best to worst. `live`: an ETA from the feed for a tracked bus. ' +
    '`scheduled`: the feed responded but listed no bus, so the time is an estimate from the usual gap between buses; for a public bus, a time from LTA’s timetable rather than a bus on the road. ' +
    '`unknown`: the feed could not be reached, so no time is given. ' +
    '`stale`: the last cached live answer, returned because the feed is down; `asOf` is when it was originally fetched. ' +
    '`ended`: the service is outside its operating hours.',
};

/** `?stopped=1`: the services not running now too, for the Buses tab. */
export const stoppedParam = {
  name: 'stopped',
  in: 'query',
  description:
    'Set to `1` to list the services that call at the stop but are outside their hours now, after the running ones, by name, with `running: false`, why (`stopped`) and when each starts again (`resumesAt`). ' +
    'A service the feed still gives a time for is running. Default: running services only.',
  schema: { type: 'string', enum: ['1'] },
};

/** `?public=1`: the public buses too, as an account's `publicBuses` does for `/api/me/*`. */
export const publicParam = {
  name: 'public',
  in: 'query',
  description:
    'Set to `1` to count the public buses (95, 151, 96 and others) that call at the campus’s stops as well as the shuttles. ' +
    'They have a fare, so one is the answer only when it clearly saves time; a public bus leg carries `paid: true`. Default: shuttles only.',
  schema: { type: 'string', enum: ['1'] },
};

export const coordParams = [
  {
    name: 'lat',
    in: 'query',
    description:
      'Latitude of the caller, rounded to four decimal places (about 11 m) when read, and never stored. Ignored unless `lon` is also sent.',
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

export const errorResponse = (description: string, example?: Record<string, unknown>) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, ...(example ? { example } : {}) } },
});

export const ok = (schema: Record<string, unknown>, example?: Record<string, unknown>) => ({
  description: 'OK',
  content: { 'application/json': { schema, ...(example ? { example } : {}) } },
});

/** A 201: something was made. */
export const created = (schema: Record<string, unknown>, example?: Record<string, unknown>) => ({
  ...ok(schema, example),
  description: 'Created',
});

export const jsonBody = (schema: Record<string, unknown>, example?: Record<string, unknown>) => ({
  required: true,
  content: { 'application/json': { schema, ...(example ? { example } : {}) } },
});

export const RETRY_AFTER = {
  'Retry-After': { description: 'Seconds to wait before trying again.', schema: { type: 'integer', example: 60 } },
};

/** A 429 that always says how long to wait. */
export const slowDown = (description: string) => ({
  ...errorResponse(description, { error: 'too many requests, slow down' }),
  headers: RETRY_AFTER,
});

/** `?lang=`: the language the server writes in, on the routes that write words. */
export const langParam = {
  name: 'lang',
  in: 'query',
  description:
    'The language of the words in the answer: `en`, or `zh` for Simplified Chinese. Without it, the `terminus-lang` cookie, else `Accept-Language` (any `zh*` is Chinese). On `/api/me` routes, an account’s own `lang` setting, when not `auto`, wins over all of these. Errors are worded the same way. Every `/api` reply says the language it was written in, in `Content-Language` (`en` or `zh-Hans`).',
  schema: { type: 'string', enum: ['en', 'zh'] },
};

/** `?h12=1`: 12-hour clock times on the routes that write them. */
export const h12Param = {
  name: 'h12',
  in: 'query',
  description:
    'Set to `1` for 12-hour clock times ("6:36 PM") rather than 24-hour ("18:36"). An account’s `clock` setting, when not `auto`, wins over it.',
  schema: { type: 'string', enum: ['1'] },
};

/** What every answer route can say before it answers: no key, or too many requests. */
export const KEYED_ERRORS = {
  '401': {
    ...errorResponse(
      'No API key, a key that is not (or no longer) one, and no signed-in session or device token. Create a key on the account page.',
      {
        error: 'this needs an API key: create one at https://terminus.run/account and send it as x-api-key',
      },
    ),
    headers: { 'WWW-Authenticate': { description: '`Bearer realm="terminus"`.', schema: { type: 'string' } } },
  },
  '429': slowDown(
    'Too many requests: over 60 a minute for an API key, over 120 a minute for a signed-in account (a session or device), or over 60 a minute from the IP address for a request with neither. Wait for `Retry-After`.',
  ),
};

/** Every /download/* route, on a server with no downloads bucket. */
export const DOWNLOADS_OFF = errorResponse('Downloads are not set up on this server.', { error: 'downloads are not configured' });

export const answerExample = {
  label: 'D2 · 4 min',
  detail: 'KR MRT · cross the road · UTown in ~12 min · crowding: low · or A2 in 9 min',
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
