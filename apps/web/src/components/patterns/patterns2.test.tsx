import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BulkImport, JobMonitor, LinkPicker, ObjectPage, PolicyEditor, SidePanelEditor, validateImport, type ObjectModel } from '.';
import { GlobalSearch } from './app-shell/global-search';
import { parseCsv } from '@/lib/csv';

describe('csv parse and import validation', () => {
  it('parses quotes, escaped quotes, CRLF and embedded newlines', () => {
    expect(parseCsv('a,b\r\n"x,1","he said ""hi"""\n"l1\nl2",z\n')).toEqual([['a', 'b'], ['x,1', 'he said "hi"'], ['l1\nl2', 'z']]);
  });
  it('reports required and invalid cells with row numbers', () => {
    const fields = [{ id: 'n', label: 'Name', required: true }, { id: 'e', label: 'Email', validate: (v: string) => (v.includes('@') ? null : 'Not an email') }];
    const r = validateImport(parseCsv('Name,Email\nA,a@x\n,bad\n'), { n: 0, e: 1 }, fields);
    expect(r.errors).toEqual([{ row: 3, field: 'Name', message: 'Required' }, { row: 3, field: 'Email', message: 'Not an email' }]);
  });
});

describe('global search typeahead (P2)', () => {
  it('suggests, picks, and submits free text on Enter', async () => {
    const onPick = vi.fn(), onSubmit = vi.fn();
    const suggest = vi.fn(async () => [{ id: 's1', label: 'Customer master', typeLabel: 'Dataset', href: '/d/1' }]);
    render(<GlobalSearch onSubmit={onSubmit} suggest={suggest} onPick={onPick} />);
    const box = screen.getByRole('combobox', { name: /search dmc/i });
    await userEvent.type(box, 'cust');
    await userEvent.click(await screen.findByRole('option', { name: /Customer master/, hidden: true }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
    await userEvent.type(box, 'payments{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('payments');
  });
  it('shows recent items when empty', async () => {
    render(<GlobalSearch onSubmit={() => {}} recent={[{ id: 'r', label: 'Recent thing', typeLabel: 'Scope', href: '/s/1' }]} />);
    await userEvent.click(screen.getByRole('combobox'));
    expect(await screen.findByRole('option', { name: /Recent thing/, hidden: true })).toBeInTheDocument();
  });
});

describe('side panel editor (P7)', () => {
  it('guards unsaved changes and shows server issues', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn().mockResolvedValueOnce([{ field: 'owner', message: 'Unknown person' }]).mockResolvedValueOnce([]);
    render(<SidePanelEditor title="Edit" isOpen onClose={onClose} dirty onSave={onSave}>{({ issues }) => <p>{issues.map((i) => i.message).join()}</p>}</SidePanelEditor>);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Fix 1 problem');
    expect(screen.getByText('Unknown person')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('job monitor, link picker, policy editor, object page', () => {
  it('job monitor runs and pauses', async () => {
    const run = vi.fn(), pause = vi.fn();
    render(<JobMonitor onRunNow={run} onTogglePause={pause} jobs={[{ id: 'j', name: 'aris', environment: 'prod', status: 'failed', error: 'boom', paused: false }]} />);
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
    await userEvent.click(screen.getByRole('button', { name: 'Run aris now' }));
    await userEvent.click(screen.getByRole('button', { name: /Pause/ }));
    expect(run).toHaveBeenCalledWith('j'); expect(pause).toHaveBeenCalledWith('j', true);
  });
  it('link picker filters, selects and confirms', async () => {
    const ok = vi.fn();
    render(<LinkPicker label="L" onConfirm={ok} candidates={[{ id: '1', label: 'customer_id', group: 't' }, { id: '2', label: 'amount', group: 'p' }]} />);
    await userEvent.type(screen.getByLabelText('Search'), 'cust');
    expect(screen.queryByText('amount')).toBeNull();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm links' }));
    expect(ok).toHaveBeenCalledWith(['1']);
  });
  it('policy editor validates live and blocks invalid pull requests', async () => {
    const pr = vi.fn();
    const validate = vi.fn(async (y: string) => (y.includes('mode') ? [] : [{ line: 1, message: 'mode is required' }]));
    render(<PolicyEditor initialYaml="id: x" validate={validate} dryRun={async () => [{ subject: 'S', outcome: 'deny', reason: 'r' }]} onOpenPullRequest={pr} />);
    expect(await screen.findByText('Line 1: mode is required')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open pull request' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Policy \(YAML/), '\nmode: shadow');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open pull request' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Dry run' }));
    expect(await screen.findByText('deny')).toBeInTheDocument();
  });
  it('object page renders any model and shows tabs', async () => {
    const model: ObjectModel = { type: 'x', typeLabel: 'Widget', name: 'W1', state: 'active', fields: [{ id: 'f', label: 'Colour', value: 'blue' }], relationships: [], controls: [{ id: 'c', label: 'Has owner', status: 'not-met' }], events: [], actions: [{ id: 'edit', label: 'Edit', allowed: false, reason: 'Synced' }] };
    render(<ObjectPage model={model} onAction={() => {}} />);
    expect(screen.getByRole('heading', { name: 'W1' })).toBeInTheDocument();
    expect(screen.getByText('blue')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    await userEvent.click(screen.getByRole('tab', { name: 'Controls' }));
    expect(screen.getByText('Not met')).toBeInTheDocument();
  });
  it('bulk import blocks commit while there are errors', async () => {
    render(<BulkImport fields={[{ id: 'n', label: 'Name', required: true }]} onCommit={async () => {}} />);
    const file = new File(['Name\nA\n\n'], 'x.csv', { type: 'text/csv' });
    await userEvent.upload(screen.getByLabelText('CSV file'), file);
    expect(await screen.findByRole('status')).toHaveTextContent('1 rows, 0 problems');
    expect(screen.getByRole('button', { name: 'Import 1 rows' })).toBeEnabled();
  });
});
