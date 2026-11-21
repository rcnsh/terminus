import { GRAPH } from '../src/answer/graph.ts';
import { shapeFor } from '../src/map/campus.ts';
import { pointAlong } from '../src/map/buses.ts';
import { indexGraph, rideSpan } from '../src/answer/resolve.ts';

function ride(svc, from, to) {
  const shape = shapeFor(svc, GRAPH.routes[svc]);
  const span = rideSpan(indexGraph(GRAPH), svc, from, to);
  if (!shape || !span || span.i + span.hops >= shape.at.length) throw new Error(`no measurable ride ${svc} ${from}->${to}`);
  return { shape, start: shape.at[span.i], end: shape.at[span.i + span.hops] };
}

export function rideLength(svc, from, to) {
  const { start, end } = ride(svc, from, to);
  return end - start;
}

export function onRide(svc, from, to, metres) {
  const { shape, start } = ride(svc, from, to);
  const p = pointAlong(shape, start + metres);
  return { lat: p.lat, lon: p.lon };
}

export const onRideQuery = (svc, from, to, metres) => {
  const p = onRide(svc, from, to, metres);
  return `?lat=${p.lat.toFixed(5)}&lon=${p.lon.toFixed(5)}`;
};
