import { useEffect, useMemo, useState } from 'react';
import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { Graph } from './model';

const elk = new ELK();
const W = 220, H = 44;

/** P17. Left to right, layered. Layout runs on every change, but the viewport (pan and zoom) is left alone so nothing jumps when a side is expanded. */
export default function LineageCanvas({ graph, selected, onSelect }: { graph: Graph; selected?: string; onSelect(qn: string): void }) {
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  const key = useMemo(() => [...graph.nodes.keys()].sort().join('|') + '#' + [...graph.edges.keys()].sort().join('|'), [graph]);
  useEffect(() => {
    let live = true;
    void elk.layout({
      id: 'root', layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.spacing.nodeNode': '24', 'elk.layered.spacing.nodeNodeBetweenLayers': '80' },
      children: [...graph.nodes.keys()].map((id) => ({ id, width: W, height: H })),
      edges: [...graph.edges.values()].map((e) => ({ id: `${e.from}>${e.to}`, sources: [e.from], targets: [e.to] })),
    }).then((out) => { if (live) setPos(Object.fromEntries((out.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]))); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const nodes: Node[] = [...graph.nodes.values()].map((n) => ({
    id: n.qn, position: pos[n.qn] ?? { x: 0, y: 0 }, width: W, height: H, data: { label: n.qn.split('.').slice(-2).join('.') },
    selected: n.qn === selected, ariaLabel: `${n.type} ${n.qn}`,
    className: `border ${n.qn === graph.root ? 'border-brand border-2' : 'border-border'} bg-background text-xs`,
  }));
  const edges: Edge[] = [...graph.edges.values()].map((e) => ({ id: `${e.from}>${e.to}`, source: e.from, target: e.to, label: e.job, style: { stroke: 'var(--foreground)' } }));
  return (
    <div className="h-[32rem] border border-border" role="group" aria-label="Lineage canvas; the table view lists the same links">
      <ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{ padding: 0.2, maxZoom: 1 }} nodesConnectable={false} nodesDraggable={false} minZoom={0.2}
        onNodeClick={(_, n) => onSelect(n.id)} proOptions={{ hideAttribution: true }}>
        <Controls showInteractive={false} /><Background />
      </ReactFlow>
    </div>
  );
}
