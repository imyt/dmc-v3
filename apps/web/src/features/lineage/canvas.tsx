import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, Position, ReactFlow, type Edge, type Node, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { Graph } from './model';

const elk = new ELK();
const W = 220, H = 44;
/** The last two parts of the path (table and column), so the label fits the box; the full name is on the node's accessible label. */
const shortName = (qn: string): string => (qn.includes('/') ? qn.split('/').slice(-2).join('/') : qn.split('.').slice(-2).join('.'));

/** P17. Left to right, layered. Layout runs on every change, but the viewport (pan and zoom) is left alone so nothing jumps when a side is expanded. */
export default function LineageCanvas({ graph, selected, onSelect }: { graph: Graph; selected?: string; onSelect(qn: string): void }) {
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  const flow = useRef<ReactFlowInstance | null>(null);
  const fitted = useRef(false);
  const key = useMemo(() => [...graph.nodes.keys()].sort().join('|') + '#' + [...graph.edges.keys()].sort().join('|'), [graph]);
  const rootSeen = useRef(graph.root);
  useEffect(() => {
    let live = true;
    if (rootSeen.current !== graph.root) { rootSeen.current = graph.root; fitted.current = false; }
    void elk.layout({
      id: 'root', layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.spacing.nodeNode': '24', 'elk.layered.spacing.nodeNodeBetweenLayers': '80' },
      children: [...graph.nodes.keys()].map((id) => ({ id, width: W, height: H })),
      edges: [...graph.edges.values()].map((e) => ({ id: `${e.from}>${e.to}`, sources: [e.from], targets: [e.to] })),
    }).then((out) => {
      if (!live) return;
      setPos(Object.fromEntries((out.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }])));
      // the first layout is the one the person looks at: fit it once. Later layouts (an expanded side) leave the viewport alone.
      if (!fitted.current) { fitted.current = true; setTimeout(() => void flow.current?.fitView({ padding: 0.2, maxZoom: 1 }), 50); }
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const nodes: Node[] = [...graph.nodes.values()].map((n) => ({
    id: n.qn, position: pos[n.qn] ?? { x: 0, y: 0 }, width: W, height: H, sourcePosition: Position.Right, targetPosition: Position.Left, data: { label: shortName(n.qn) },
    selected: n.qn === selected, ariaLabel: `${n.type} ${n.qn}`,
    className: `border ${n.qn === graph.root ? 'border-brand border-2' : 'border-border'} bg-background text-xs`,
  }));
  const edges: Edge[] = [...graph.edges.values()].map((e) => ({ id: `${e.from}>${e.to}`, source: e.from, target: e.to, label: e.job, style: { stroke: 'var(--foreground)' } }));
  return (
    <div className="h-[32rem] border border-border" role="group" aria-label="Lineage canvas; the table view lists the same links">
      <ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{ padding: 0.2, maxZoom: 1 }} nodesConnectable={false} nodesDraggable={false} minZoom={0.2}
        onInit={(i) => { flow.current = i; }} onNodeClick={(_, n) => onSelect(n.id)} proOptions={{ hideAttribution: true }}>
        <Controls showInteractive={false} /><Background />
      </ReactFlow>
    </div>
  );
}
