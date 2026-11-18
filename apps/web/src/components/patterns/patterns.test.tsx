import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Completeness, DecisionItem, DiffView, FacetPanel, FieldWithSource, MetricPanel, PermissionAction, StatusBadge, type FacetSelection } from '.';
import { csvCell, diffLines, toCsv } from '@/lib/diff';

describe('diff and csv helpers', () => {
  it('diffs lines', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc').map((l) => l.kind + ':' + l.text)).toEqual(['same:a', 'del:b', 'add:x', 'same:c']);
    expect(diffLines('', 'a').map((l) => l.kind)).toEqual(['add']);
  });
  it('quotes csv and neutralises formulas', () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(toCsv(['h'], [['1'], ['2']])).toBe('h\r\n1\r\n2\r\n');
  });
});

describe('patterns', () => {
  it('badges carry text as well as colour', () => {
    render(<StatusBadge kind="severity" value="critical" />);
    expect(screen.getByText('Critical')).toBeInTheDocument();
  });

  it('synced fields are locked and offer a change request', async () => {
    const onRequest = vi.fn();
    render(<dl><FieldWithSource label="Owner" value="Priya" source={{ tool: 'ARIS', syncedAt: '2026-11-17T06:30:00Z' }} onRequestChange={onRequest} /></dl>);
    expect(screen.getByRole('img', { name: /synced field/i })).toBeInTheDocument();
    expect(screen.getByText(/Source: ARIS/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Request change' }));
    expect(onRequest).toHaveBeenCalled();
  });

  it('permission actions: shown, hidden, or disabled with the reason', () => {
    const { rerender } = render(<PermissionAction action={{ id: 'a', label: 'Edit', allowed: true }} onPress={() => {}} />);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled();
    rerender(<PermissionAction action={{ id: 'a', label: 'Edit', allowed: false, reason: 'Managed in ARIS' }} onPress={() => {}} />);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<PermissionAction action={{ id: 'a', label: 'Edit', allowed: false, reason: 'Managed in ARIS' }} onPress={() => {}} expected />);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(screen.getByText('Managed in ARIS')).toBeInTheDocument();
  });

  it('completeness lists what is missing', () => {
    render(<Completeness label="Scope" steps={[{ label: 'Owner', done: true }, { label: 'Datasets', done: false }]} />);
    expect(screen.getByText(/50% \(1 of 2\)/)).toBeInTheDocument();
    expect(screen.getByText('Datasets')).toBeInTheDocument();
  });

  it('facet panel reports selection and clears', async () => {
    function Host() {
      const [s, set] = useState<FacetSelection>({});
      return <><FacetPanel selected={s} onChange={set} groups={[{ id: 't', label: 'Type', values: [{ value: 'd', label: 'Dataset', count: 3 }] }]} /><output>{JSON.stringify(s)}</output></>;
    }
    render(<Host />);
    await userEvent.click(screen.getByRole('checkbox', { name: /Dataset/ }));
    expect(screen.getByRole('status')).toHaveTextContent('{"t":["d"]}');
    await userEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));
    expect(screen.getByRole('status')).toHaveTextContent('{}');
  });

  it('decision item sends the decision with the comment and flags overdue', async () => {
    const onDecide = vi.fn();
    render(<DecisionItem now={new Date('2026-11-20T00:00:00Z')} onDecide={onDecide} item={{ id: 'i1', title: 'T', context: 'c', severity: 'low', dueAt: '2026-11-18T00:00:00Z', allowed: ['approve', 'reject'] }} />);
    expect(screen.getByText(/Overdue by 48 h/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Modify' })).toBeNull();
    await userEvent.type(screen.getByRole('textbox'), 'ok');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onDecide).toHaveBeenCalledWith('i1', 'approve', 'ok');
  });

  it('diff view switches layout and counts changes', async () => {
    render(<DiffView title="d" before={'a\nb'} after={'a\nc'} />);
    expect(screen.getByText('1 added, 1 removed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Side by side' }));
    expect(screen.getByLabelText('Before')).toBeInTheDocument();
    expect(screen.getByLabelText('After')).toBeInTheDocument();
  });

  it('metric panel says whether the target is met and offers a table', async () => {
    render(<MetricPanel title="Owners" value={92} target={95} breakdown={[{ label: 'Retail', value: 97 }]} />);
    expect(screen.getByText('not met')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show table' }));
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});

describe('data table', () => {
  const cols = [{ id: 'n', header: 'Name', cell: (r: { n: string }) => r.n, text: (r: { n: string }) => r.n, sortable: true }];
  it('selects rows, shows bulk actions, and pages', async () => {
    const { DataTable } = await import('./data-table');
    const next = vi.fn();
    render(<DataTable label="T" columns={cols} rows={[{ n: 'a' }, { n: 'b' }]} rowId={(r) => r.n} bulkActions={(ids) => <span>bulk {ids.join(',')}</span>} paging={{ hasPrevious: false, hasNext: true, onPrevious() {}, onNext: next }} />);
    const boxes = screen.getAllByRole('checkbox');
    await userEvent.click(boxes.find((b) => b.getAttribute('aria-label') === 'Select a')!);
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getByText('bulk a')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(next).toHaveBeenCalled();
  });
  it('shows the empty state with what DMC is doing', async () => {
    const { DataTable } = await import('./data-table');
    render(<DataTable label="T" columns={cols} rows={[]} rowId={(r) => r.n} empty={{ title: 'Nothing here', doing: 'DMC checks every night.' }} />);
    expect(screen.getByText('DMC checks every night.')).toBeInTheDocument();
  });
});
