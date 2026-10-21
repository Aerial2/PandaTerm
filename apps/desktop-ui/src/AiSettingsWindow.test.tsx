// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAiProviderConfig: vi.fn(),
  saveAiProviderConfig: vi.fn(),
  syncAiProviderModels: vi.fn(),
  testAiProvider: vi.fn(),
  addAiProviderAccount: vi.fn(),
  deleteAiProviderAccount: vi.fn(),
  getMcpConfig: vi.fn(),
  saveMcpConfig: vi.fn(),
  reconnectMcpServer: vi.fn(),
  listMcpImportCandidates: vi.fn(),
  importMcpServersFromPath: vi.fn(),
  exportMcpServersCursorJson: vi.fn(),
  writeClipboardText: vi.fn(),
  emitTo: vi.fn(),
  listen: vi.fn(),
  invoke: vi.fn(),
  getCurrentWebviewWindow: vi.fn(),
}));

vi.mock('./api', () => ({
  getAiProviderConfig: mocks.getAiProviderConfig,
  saveAiProviderConfig: mocks.saveAiProviderConfig,
  syncAiProviderModels: mocks.syncAiProviderModels,
  testAiProvider: mocks.testAiProvider,
  addAiProviderAccount: mocks.addAiProviderAccount,
  deleteAiProviderAccount: mocks.deleteAiProviderAccount,
  getMcpConfig: mocks.getMcpConfig,
  saveMcpConfig: mocks.saveMcpConfig,
  reconnectMcpServer: mocks.reconnectMcpServer,
  listMcpImportCandidates: mocks.listMcpImportCandidates,
  importMcpServersFromPath: mocks.importMcpServersFromPath,
  exportMcpServersCursorJson: mocks.exportMcpServersCursorJson,
  writeClipboardText: mocks.writeClipboardText,
}));
vi.mock('@tauri-apps/api/event', () => ({ emitTo: mocks.emitTo, listen: mocks.listen }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: mocks.getCurrentWebviewWindow,
}));

import { AiSettingsWindow } from './AiSettingsWindow';
import type { AiProviderConfig, McpConfigSnapshot } from './api';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => undefined;
}

const accountA = {
  id: 'account-a',
  name: '团队上游',
  base_url: 'https://a.example/v1',
  model: 'shared-model',
  models: ['shared-model', 'a-only'],
  enabled_models: ['shared-model', 'a-only'],
  api_format: 'openai',
  api_key_configured: true,
};
const accountB = {
  id: 'account-b',
  name: '个人上游',
  base_url: 'https://b.example/v1',
  model: 'shared-model',
  models: ['shared-model', 'b-only'],
  enabled_models: ['shared-model', 'b-only'],
  api_format: 'openai',
  api_key_configured: true,
};

function configFor(account: typeof accountA, activeAccountId = 'account-a'): AiProviderConfig {
  return {
    account_id: account.id,
    account_name: account.name,
    base_url: account.base_url,
    model: account.model,
    models: account.models,
    enabled_models: account.enabled_models,
    reasoning_effort: 'none',
    api_format: 'openai',
    context_window: 0,
    max_tokens: 0,
    use_api_key: true,
    api_key_configured: account.api_key_configured,
    // Deliberately omit the secret: tests assert only the configured marker.
    api_key: '',
    accounts: [accountA, accountB],
    active_account_id: activeAccountId,
  };
}

const emptyMcp: McpConfigSnapshot = { servers: [] };

function installApiDefaults() {
  mocks.getAiProviderConfig.mockImplementation(async (accountId?: string) => (
    configFor(accountId === 'account-b' ? accountB : accountA)
  ));
  mocks.saveAiProviderConfig.mockImplementation(async (request: { account_id?: string; activate?: boolean }) => (
    configFor(request.account_id === 'account-b' ? accountB : accountA, request.activate === false ? 'account-a' : (request.account_id ?? 'account-a'))
  ));
  mocks.addAiProviderAccount.mockResolvedValue(configFor(accountB));
  mocks.getMcpConfig.mockResolvedValue(emptyMcp);
  mocks.saveMcpConfig.mockResolvedValue(emptyMcp);
  mocks.reconnectMcpServer.mockResolvedValue(emptyMcp);
  mocks.listMcpImportCandidates.mockResolvedValue([]);
  mocks.importMcpServersFromPath.mockResolvedValue({ servers: [], server_count: 0 });
  mocks.exportMcpServersCursorJson.mockResolvedValue('{}');
  mocks.writeClipboardText.mockResolvedValue(undefined);
  mocks.emitTo.mockResolvedValue(undefined);
  mocks.invoke.mockResolvedValue(undefined);
  mocks.listen.mockResolvedValue(() => undefined);
  mocks.getCurrentWebviewWindow.mockReturnValue({
    label: 'ai-settings',
    show: vi.fn().mockResolvedValue(undefined),
    setFocus: vi.fn().mockResolvedValue(undefined),
    onCloseRequested: vi.fn().mockResolvedValue(() => undefined),
  });
}

function settle() {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function text(container: HTMLElement, value: string) {
  return Array.from(container.querySelectorAll<HTMLElement>('*')).find((element) => (
    element.childElementCount === 0 && element.textContent?.trim() === value
  ));
}

function button(container: HTMLElement, label: string) {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((element) => (
    element.textContent?.includes(label) || element.getAttribute('aria-label') === label
  ));
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

function input(container: HTMLElement, label: string) {
  const found = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
    ?? Array.from(container.querySelectorAll<HTMLInputElement>('input')).find((element) => (
      element.closest('label')?.textContent?.includes(label)
    ));
  if (!found) throw new Error(`input not found: ${label}`);
  return found;
}

function setNativeInputValue(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('native input value setter is unavailable');
  setter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<AiSettingsWindow />);
  });
  await settle();
  return { container, root: root! };
}

async function openAccount(container: HTMLElement, name: string) {
  const card = Array.from(container.querySelectorAll<HTMLButtonElement>('.ai-upstream-card')).find((element) => (
    element.textContent?.includes(name)
  ));
  if (!card) throw new Error(`upstream card not found: ${name}`);
  await act(async () => { card.click(); });
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '?tab=models');
  installApiDefaults();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('AiSettingsWindow redesigned models overview/detail', () => {
  it('renders overview without detail fields and reads a target account without activating it', async () => {
    const { container, root } = await mount();

    expect(container.textContent).toContain('新会话默认模型');
    expect(container.textContent).toContain('团队上游');
    expect(container.textContent).toContain('个人上游');
    expect(container.textContent).not.toContain('供应商名称');
    expect(container.textContent).not.toContain('接口地址');
    expect(container.textContent).not.toContain('访问密钥');

    await openAccount(container, '个人上游');
    expect(mocks.getAiProviderConfig).toHaveBeenCalledWith('account-b');
    expect(mocks.saveAiProviderConfig).not.toHaveBeenCalled();
    expect(container.textContent).toContain('供应商名称');
    expect(container.textContent).toContain('b-only');
    expect(container.textContent).not.toContain('sk-');

    await act(async () => { root.unmount(); });
  });

  it('marks configured credentials without rendering their value', async () => {
    const { container, root } = await mount();
    await openAccount(container, '团队上游');

    const key = container.querySelector<HTMLInputElement>('input[placeholder="••••••••"]');
    expect(key).not.toBeNull();
    expect(key?.value).toBe('');
    expect(key?.placeholder).toContain('••••••••');
    expect(container.textContent).not.toContain('api-key');

    await act(async () => { root.unmount(); });
  });

  it('edits account B, autosaves with activate=false, and flushes before Back', async () => {
    const { container, root } = await mount();
    await openAccount(container, '个人上游');

    setNativeInputValue(input(container, '供应商名称'), '个人上游已改');
    await act(async () => { button(container, '返回模型').click(); });
    await settle();

    expect(mocks.saveAiProviderConfig).toHaveBeenCalled();
    expect(mocks.saveAiProviderConfig).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: 'account-b', account_name: '个人上游已改', activate: false }),
      '',
    );
    expect(mocks.getAiProviderConfig).toHaveBeenLastCalledWith(undefined);
    expect(container.textContent).not.toContain('供应商名称');

    await act(async () => { root.unmount(); });
  });

  it('keeps detail open and reports an error when the Back flush fails', async () => {
    const { container, root } = await mount();
    await openAccount(container, '个人上游');
    mocks.saveAiProviderConfig.mockRejectedValueOnce(new Error('save failed'));

    setNativeInputValue(input(container, '供应商名称'), '保存失败的编辑');
    await act(async () => { button(container, '返回模型').click(); });
    await settle();

    expect(container.textContent).toContain('供应商名称');
    expect(container.textContent).toContain('自动保存失败');
    expect(mocks.getAiProviderConfig).not.toHaveBeenLastCalledWith(undefined);

    await act(async () => { root.unmount(); });
  });

  it('activates the selected account/model pair, keeping same-named models distinct by account id', async () => {
    const { container, root } = await mount();
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="新会话默认模型"]');
    expect(trigger).not.toBeNull();

    await act(async () => { trigger?.click(); });
    await settle();
    const option = text(document.body, 'shared-model · 个人上游');
    expect(option).not.toBeUndefined();
    await act(async () => { option?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    await settle();

    expect(mocks.getAiProviderConfig).toHaveBeenCalledWith('account-b');
    expect(mocks.saveAiProviderConfig).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: 'account-b', model: 'shared-model', activate: true }),
    );

    await act(async () => { root.unmount(); });
  });

  it('adds a manual model and toggles its enabled state in detail', async () => {
    const { container, root } = await mount();
    await openAccount(container, '团队上游');

    setNativeInputValue(input(container, '模型名称'), 'manual-model');
    await act(async () => { button(container, '添加模型').click(); });
    await settle();

    expect(container.textContent).toContain('manual-model');
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="启用 manual-model"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-checked')).toBe('true');

    await act(async () => { toggle?.click(); });
    await settle();
    expect(toggle?.getAttribute('aria-checked')).toBe('false');

    await act(async () => { root.unmount(); });
  });
});
