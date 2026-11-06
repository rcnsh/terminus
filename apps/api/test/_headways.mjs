/**
 * Takes the measured headways (data/headways.json) out of the graph, so every
 * shuttle's guess is DEFAULT_HEADWAY_S again. For tests of how a guess is
 * used (a change, a trip, a push), which shouldn't change each time the
 * headways are measured again. Each test file runs in its own process, so
 * this reaches only the file that calls it.
 */
import { GRAPH, GRAPH_PUBLIC } from '../src/answer/graph.ts';
import headways from '../data/headways.json' with { type: 'json' };

export function withoutMeasuredHeadways() {
  for (const graph of [GRAPH, GRAPH_PUBLIC]) {
    delete graph.headwaysByTime;
    for (const svc of Object.keys(headways.usualS)) delete graph.headwayS[svc];
  }
}
