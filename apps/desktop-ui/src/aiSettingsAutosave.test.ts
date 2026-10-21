import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSettingsAutosave, type AutosaveStatus } from './aiSettingsAutosave';

function deferred() {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = () => no(new Error('simulated failure'));
  });
  return { promise, resolve, reject };
}

function setup(save: (value: number) => Promise<void>) {
  const statuses: AutosaveStatus[] = [];
  const queue = createSettingsAutosave({
    save,
    equal: (a: number, b: number) => a === b,
    onStatus: (status) => statuses.push(status),
  });
  queue.reset(0);
  return { queue, statuses };
}

afterEach(() => vi.useRealTimers());

describe('settings autosave', () => {
  it('does not save hydrated settings and debounces rapid input to the latest draft', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_value: number) => {});
    const { queue } = setup(save);
    queue.update(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(save).not.toHaveBeenCalled();
    queue.update(1);
    await vi.advanceTimersByTimeAsync(400);
    queue.update(2);
    await vi.advanceTimersByTimeAsync(599);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save.mock.calls.map(([value]) => value)).toEqual([2]);
  });

  it('flushes immediately before a close or account switch', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const { queue } = setup(() => pending.promise);
    queue.update(1);
    const action = vi.fn();
    const transition = queue.flush().then((saved) => { if (saved) action(); });
    await Promise.resolve();
    expect(action).not.toHaveBeenCalled();
    pending.resolve();
    await transition;
    expect(action).toHaveBeenCalledOnce();
  });

  it('serializes requests and skips superseded drafts during an in-flight save', async () => {
    const first = deferred();
    const save = vi.fn((value: number) => value === 1 ? first.promise : Promise.resolve());
    const { queue, statuses } = setup(save);
    queue.update(1);
    const flushed = queue.flush();
    queue.update(2);
    queue.update(3);
    expect(save.mock.calls.map(([value]) => value)).toEqual([1]);
    first.resolve();
    expect(await flushed).toBe(true);
    expect(save.mock.calls.map(([value]) => value)).toEqual([1, 3]);
    expect(statuses[statuses.length - 1]).toBe('saved');
    queue.dispose();
  });

  it('persists a revert made while an earlier write is running', async () => {
    const first = deferred();
    const save = vi.fn((value: number) => value === 1 ? first.promise : Promise.resolve());
    const { queue } = setup(save);
    queue.update(1);
    const flushed = queue.flush();
    queue.update(0);
    first.resolve();
    expect(await flushed).toBe(true);
    expect(save.mock.calls.map(([value]) => value)).toEqual([1, 0]);
    queue.dispose();
  });

  it('retains a failed draft, blocks transitions, and retries the same input', async () => {
    const save = vi.fn(async (_value: number) => {}).mockRejectedValueOnce(new Error('simulated failure'));
    const { queue, statuses } = setup(save);
    queue.update(1);
    expect(await queue.flush()).toBe(false);
    expect(statuses[statuses.length - 1]).toBe('error');
    expect(await queue.flush()).toBe(true);
    expect(save.mock.calls.map(([value]) => value)).toEqual([1, 1]);
  });

  it('clears an error when a failed edit is reverted to the saved value', async () => {
    const save = vi.fn(async (_value: number) => {}).mockRejectedValueOnce(new Error('simulated failure'));
    const { queue, statuses } = setup(save);
    queue.update(1);
    expect(await queue.flush()).toBe(false);
    queue.update(0);
    expect(statuses[statuses.length - 1]).toBe('idle');
    expect(await queue.flush()).toBe(true);
    expect(save).toHaveBeenCalledOnce();
  });

  it('saves newer input even if the superseded request fails', async () => {
    const first = deferred();
    const save = vi.fn((value: number) => value === 1 ? first.promise : Promise.resolve());
    const { queue } = setup(save);
    queue.update(1);
    const flushed = queue.flush();
    queue.update(2);
    first.reject();
    expect(await flushed).toBe(true);
    expect(save.mock.calls.map(([value]) => value)).toEqual([1, 2]);
    queue.dispose();
  });

  it('resets to the next account without carrying over pending writes', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_value: number) => {});
    const { queue } = setup(save);
    queue.update(1);
    await queue.flush();
    queue.reset(10);
    queue.update(10);
    await vi.advanceTimersByTimeAsync(1000);
    expect(save.mock.calls.map(([value]) => value)).toEqual([1]);
    queue.update(11);
    await queue.flush();
    expect(save.mock.calls.map(([value]) => value)).toEqual([1, 11]);
  });
});
