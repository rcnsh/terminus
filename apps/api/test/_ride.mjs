/**
 * Where a phone on a shuttle would be: a point on the real road line
 * (shapes.json), part way along a ride. For the tests of seenOnBus.
 */
import { GRAPH } from '../src/graph.ts';
import { shapeFor } from '../src/campus.ts';
import { pointAlong } from '../src/buses.ts';
import { indexGraph, rideSpan } from '../src/resolve.ts';

function ride(svc, from, to) {
  const shape = shapeFor(svc, GRAPH.routes[svc]);
  const span = rideSpan(indexGraph(GRAPH), svc, from, to);
  if (!shape || !span || span.i + span.hops >= shape.at.length) throw new Error(`no measurable ride ${svc} ${from}->${to}`);
  return { shape, start: shape.at[span.i], end: shape.at[span.i + span.hops] };
}

/** Metres along the road from `from` to `to` on `svc`. */
export function rideLength(svc, from, to) {
  const { start, end } = ride(svc, from, to);
  return end - start;
}

/** `{ lat, lon }` on the road `metres` past `from` on `svc`'s ride to `to`. */
export function onRide(svc, from, to, metres) {
  const { shape, start } = ride(svc, from, to);
  const p = pointAlong(shape, start + metres);
  return { lat: p.lat, lon: p.lon };
}

/** The same, as a query string for /me/next. */
export const onRideQuery = (svc, from, to, metres) => {
  const p = onRide(svc, from, to, metres);
  return `?lat=${p.lat.toFixed(5)}&lon=${p.lon.toFixed(5)}`;
};
