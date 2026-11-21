import { GRAPH, GRAPH_PUBLIC } from '../src/answer/graph.ts';
import headways from '../data/headways.json' with { type: 'json' };

export function withoutMeasuredHeadways() {
  for (const graph of [GRAPH, GRAPH_PUBLIC]) {
    delete graph.headwaysByTime;
    for (const svc of Object.keys(headways.usualS)) delete graph.headwayS[svc];
  }
}
