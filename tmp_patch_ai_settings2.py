# -*- coding: utf-8 -*-
from pathlib import Path

path = Path(r"e:\Project\Rust\PandaTerm\apps\desktop-ui\src\App.tsx")
text = path.read_text(encoding="utf-8")

def replace_once(src: str, old: str, new: str, label: str) -> str:
    if old not in src:
        raise SystemExit(f"NOT FOUND: {label}")
    return src.replace(old, new, 1)

# backdrop
text = replace_once(
    text,
    """          onMouseDown={() => {
            if (!isAiConfigSaving && !isAiModelsSyncing && !isMcpSaving) setIsAiSettingsOpen(false);
          }}
""",
    """          onMouseDown={() => {
            if (!isAiConfigSaving && !isAiModelsSyncing && !isMcpSaving) requestCloseAiSettings();
          }}
""",
    "backdrop",
)

# close X
text = replace_once(
    text,
    """                <button
                  type="button"
                  className="ai-settings-close"
                  aria-label="关闭"
                  disabled={isAiConfigSaving || isAiModelsSyncing || isMcpSaving}
                  onClick={() => setIsAiSettingsOpen(false)}
                >
                  <X size={16} />
                </button>
""",
    """                <button
                  type="button"
                  className="ai-settings-close"
                  aria-label="关闭"
                  disabled={isAiConfigSaving || isAiModelsSyncing || isMcpSaving}
                  onClick={() => requestCloseAiSettings()}
                >
                  <X size={16} />
                </button>
""",
    "close-x",
)

# models footer
text = replace_once(
    text,
    """                  <footer className="ai-settings-footer">
                    <button
                      type="button"
                      className="ai-settings-btn"
                      disabled={isAiConfigSaving || isAiModelsSyncing}
                      onClick={() => setIsAiSettingsOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="ai-settings-btn primary"
                      disabled={isAiConfigLoading || isAiConfigSaving || isAiModelsSyncing || Boolean(aiProviderConfig?.error) || !aiConfigDraft.base_url.trim() || !aiConfigDraft.model.trim()}
                    >
                      {isAiConfigSaving ? 'Saving…' : 'Save'}
                    </button>
                  </footer>
""",
    """                  <footer className="ai-settings-footer">
                    <button
                      type="button"
                      className="ai-settings-btn"
                      disabled={isAiConfigSaving || isAiModelsSyncing}
                      onClick={() => requestCloseAiSettings()}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="ai-settings-btn primary"
                      disabled={
                        isAiConfigLoading
                        || isAiConfigSaving
                        || isAiModelsSyncing
                        || Boolean(aiProviderConfig?.error)
                        || !aiConfigDraft.base_url.trim()
                        || !aiConfigDraft.model.trim()
                        || !isAiConfigDraftDirty(aiConfigDraft, aiApiKeyDraft, aiProviderConfig)
                      }
                    >
                      {isAiConfigSaving
                        ? 'Saving…'
                        : isAiConfigDraftDirty(aiConfigDraft, aiApiKeyDraft, aiProviderConfig)
                          ? 'Save'
                          : 'Saved'}
                    </button>
                  </footer>
""",
    "models-footer",
)

# mcp footer cancel
text = replace_once(
    text,
    """                  <footer className="ai-settings-footer">
                    <button
                      type="button"
                      className="ai-settings-btn"
                      disabled={isMcpSaving}
                      onClick={() => setIsAiSettingsOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="ai-settings-btn primary"
                      disabled={isMcpLoading || isMcpSaving || !isMcpServersDraftDirty(mcpServersDraft, mcpSnapshot)}
                      onClick={() => void submitMcpConfig()}
                    >
                      {isMcpSaving ? 'Saving…' : isMcpServersDraftDirty(mcpServersDraft, mcpSnapshot) ? 'Save MCP' : 'Saved'}
                    </button>
                  </footer>
""",
    """                  <footer className="ai-settings-footer">
                    <button
                      type="button"
                      className="ai-settings-btn"
                      disabled={isMcpSaving}
                      onClick={() => requestCloseAiSettings()}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="ai-settings-btn primary"
                      disabled={isMcpLoading || isMcpSaving || !isMcpServersDraftDirty(mcpServersDraft, mcpSnapshot)}
                      onClick={() => void submitMcpConfig()}
                    >
                      {isMcpSaving ? 'Saving…' : isMcpServersDraftDirty(mcpServersDraft, mcpSnapshot) ? 'Save MCP' : 'Saved'}
                    </button>
                  </footer>
""",
    "mcp-footer",
)

# transport + remote fields
text = replace_once(
    text,
    """                                        <label className="ai-settings-field ai-settings-field-full">
                                          <span>Transport <em>stdio only</em></span>
                                          <select
                                            className="ai-settings-input"
                                            value={server.transport}
                                            disabled={isMcpSaving || busy}
                                            onChange={(event) => updateMcpServerDraft(server.id, {
                                              transport: event.target.value as McpTransport,
                                            })}
                                          >
                                            <option value="stdio">stdio</option>
                                            <option value="sse" disabled>sse (coming soon)</option>
                                            <option value="streamable-http" disabled>streamable-http (coming soon)</option>
                                          </select>
                                        </label>

                                        {server.transport === 'stdio' ? (
                                          <>
                                            <label className="ai-settings-field ai-settings-field-full">
                                              <span>Command</span>
                                              <input
                                                className="ai-settings-input"
                                                value={server.command}
                                                placeholder="npx / node / uvx …"
                                                spellCheck={false}
                                                disabled={isMcpSaving || busy}
                                                onChange={(event) => updateMcpServerDraft(server.id, { command: event.target.value })}
                                              />
                                            </label>
                                            <label className="ai-settings-field ai-settings-field-full">
                                              <span>Args <em>space-separated</em></span>
                                              <input
                                                className="ai-settings-input"
                                                value={server.args.join(' ')}
                                                placeholder="-y @modelcontextprotocol/server-filesystem ."
                                                spellCheck={false}
                                                disabled={isMcpSaving || busy}
                                                onChange={(event) => updateMcpServerDraft(server.id, {
                                                  args: event.target.value.trim() ? event.target.value.trim().split(/\\s+/) : [],
                                                })}
                                              />
                                            </label>
                                            <label className="ai-settings-field ai-settings-field-full">
                                              <span>Env <em>KEY=VALUE per line</em></span>
                                              <textarea
                                                className="ai-settings-textarea"
                                                rows={3}
                                                value={Object.entries(server.env).map(([key, value]) => `${key}=${value}`).join('\\n')}
                                                placeholder="FOO=bar"
                                                spellCheck={false}
                                                disabled={isMcpSaving || busy}
                                                onChange={(event) => {
                                                  const env: Record<string, string> = {};
                                                  for (const line of event.target.value.split(/\\r?\\n/)) {
                                                    const trimmed = line.trim();
                                                    if (!trimmed) continue;
                                                    const eq = trimmed.indexOf('=');
                                                    if (eq <= 0) continue;
                                                    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
                                                  }
                                                  updateMcpServerDraft(server.id, { env });
                                                }}
                                              />
                                            </label>
                                            <label className="ai-settings-field ai-settings-field-full">
                                              <span>CWD</span>
                                              <input
                                                className="ai-settings-input"
                                                value={server.cwd ?? ''}
                                                placeholder="Optional working directory"
                                                spellCheck={false}
                                                disabled={isMcpSaving || busy}
                                                onChange={(event) => updateMcpServerDraft(server.id, {
                                                  cwd: event.target.value.trim() || null,
                                                })}
                                              />
                                            </label>
                                          </>
                                        ) : (
                                          <label className="ai-settings-field ai-settings-field-full">
                                            <span>URL</span>
                                            <input
                                              className="ai-settings-input"
                                              value={server.url}
                                              placeholder="https://example.com/mcp"
                                              spellCheck={false}
                                              disabled={isMcpSaving || busy}
                                              onChange={(event) => updateMcpServerDraft(server.id, { url: event.target.value })}
                                            />
                                          </label>
                                        )}
""",
    """                                        <label className="ai-settings-field ai-settings-field-full">
                                          <span>Transport <em>stdio runtime · remote config only</em></span>
                                          <select
                                            className="ai-settings-input"
                                            value={server.transport}
                                            disabled={isMcpSaving || busy}
                                            onChange={(event) => updateMcpServerDraft(server.id, {
                                              transport: event.target.value as McpTransport,
                                            })}
                                          >
                                            <option value="stdio">stdio</option>
                                            <option value="sse">sse (config only)</option>
                                            <option value="streamable-http">streamable-http (config only)</option>
                                          </select>
                                        </label>

                                        {server.transport === 'stdio' ? (
                                          <>
                                            <label className="ai-settings-field ai-settings-field-full">
                                              <span>Command</span>
                                              <input
                                                className="ai-settings-input"
                                                value={server.command}
                                                placeholder="npx / node / uvx …"
                                                spellCheck={false}
                                                disabled={isMcpSaving || busy}
                                                onChange={(event) => updateMcpServerDraft(server.id, { command: event.target.value })}
                                              />
                                            </label>
                                            <label className="ai-settings-field ai-settings-field-full">
                                              <span>Args <em>space-separated</em></span>
                                              <input
                                                className="ai-settings-input"
                                                value={server.args.join(' ')}
                                                placeholder="-y @modelcontextprotocol/server-filesystem ."
                                                spellCheck={false}
                                                disabled={isMcpSaving || busy}
                                                onChange={(event) => updateMcpServerDraft(server.id, {
                                                  args: event.target.value.trim() ? event.target.value.trim().split(/\\s+/) : [],
                                                })}
                                              />
                                            </label>
                                            <label className="ai-settings-field ai-settings-field-full">
                                              <span>Env <em>KEY=VALUE per line</em></span>
                                              <textarea
                                                className="ai-settings-textarea"
                                                rows={3}
                                                value={Object.entries(server.env).map(([key, value]) => `${key}=${value}`).join('\\n')}
                                                placeholder="FOO=bar"
                                                spellCheck={false}
                                                disabled={isMcpSaving || busy}
                                                onChange={(event) => {
                                                  const env: Record<string, string> = {};
                                                  for (const line of event.target.value.split(/\\r?\\n/)) {
                                                    const trimmed = line.trim();
                                                    if (!trimmed) continue;
                                                    const eq = trimmed.indexOf('=');
                                                    if (eq <= 0) continue;
                                                    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
                                                  }
                                                  updateMcpServerDraft(server.id, { env });
                                                }}
                                              />
                                            </label>
                                            <label className="ai-settings-field ai-settings-field-full">
                                              <span>CWD</span>
                                              <input
                                                className="ai-settings-input"
                                                value={server.cwd ?? ''}
                                                placeholder="Optional working directory"
                                                spellCheck={false}
                                                disabled={isMcpSaving || busy}
                                                onChange={(event) => updateMcpServerDraft(server.id, {
                                                  cwd: event.target.value.trim() || null,
                                                })}
                                              />
                                            </label>
                                          </>
                                        ) : (
                                          <>
                                            <label className="ai-settings-field ai-settings-field-full">
                                              <span>URL <em>http(s) · connect later</em></span>
                                              <input
                                                className="ai-settings-input"
                                                value={server.url}
                                                placeholder="https://example.com/mcp"
                                                spellCheck={false}
                                                disabled={isMcpSaving || busy}
                                                onChange={(event) => updateMcpServerDraft(server.id, { url: event.target.value })}
                                              />
                                            </label>
                                            <label className="ai-settings-field ai-settings-field-full">
                                              <span>Headers <em>KEY=VALUE per line</em></span>
                                              <textarea
                                                className="ai-settings-textarea"
                                                rows={3}
                                                value={Object.entries(server.headers ?? {}).map(([key, value]) => `${key}=${value}`).join('\\n')}
                                                placeholder="Authorization=Bearer …"
                                                spellCheck={false}
                                                disabled={isMcpSaving || busy}
                                                onChange={(event) => {
                                                  const headers: Record<string, string> = {};
                                                  for (const line of event.target.value.split(/\\r?\\n/)) {
                                                    const trimmed = line.trim();
                                                    if (!trimmed) continue;
                                                    const eq = trimmed.indexOf('=');
                                                    if (eq <= 0) continue;
                                                    headers[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
                                                  }
                                                  updateMcpServerDraft(server.id, { headers });
                                                }}
                                              />
                                            </label>
                                            <p className="ai-settings-mcp-remote-note">
                                              Remote transport is stored for Cursor-compatible configs. Runtime connect is stdio-only for now.
                                            </p>
                                          </>
                                        )}
""",
    "transport-fields",
)

# MCP path hint after section title actions
text = replace_once(
    text,
    """                      <div className="ai-settings-section-title-row">
                        <div className="ai-settings-section-title">Installed MCP Servers</div>
                        <div className="ai-settings-mcp-actions">
                          <button
                            type="button"
                            className="ai-settings-ghost-btn"
                            disabled={isMcpLoading || isMcpSaving}
                            onClick={() => void refreshMcpConfig()}
                          >
                            <RefreshCw size={14} className={isMcpLoading ? 'spin' : undefined} aria-hidden />
                            <span>Refresh</span>
                          </button>
                          <button
                            type="button"
                            className="ai-settings-ghost-btn primary-ghost"
                            disabled={isMcpLoading || isMcpSaving}
                            onClick={() => {
                              const server = createEmptyMcpServer();
                              setMcpServersDraft((current) => [...current, server]);
                              setExpandedMcpServerId(server.id);
                            }}
                          >
                            <Plus size={14} aria-hidden />
                            <span>New MCP Server</span>
                          </button>
                        </div>
                      </div>
""",
    """                      <div className="ai-settings-section-title-row">
                        <div className="ai-settings-section-title">Installed MCP Servers</div>
                        <div className="ai-settings-mcp-actions">
                          <button
                            type="button"
                            className="ai-settings-ghost-btn"
                            disabled={isMcpLoading || isMcpSaving}
                            onClick={() => void refreshMcpConfig()}
                          >
                            <RefreshCw size={14} className={isMcpLoading ? 'spin' : undefined} aria-hidden />
                            <span>Refresh</span>
                          </button>
                          <button
                            type="button"
                            className="ai-settings-ghost-btn primary-ghost"
                            disabled={isMcpLoading || isMcpSaving}
                            onClick={() => {
                              const server = createEmptyMcpServer();
                              setMcpServersDraft((current) => [...current, server]);
                              setExpandedMcpServerId(server.id);
                            }}
                          >
                            <Plus size={14} aria-hidden />
                            <span>New MCP Server</span>
                          </button>
                        </div>
                      </div>
                      {mcpSnapshot?.config_path ? (
                        <div className="ai-settings-mcp-path" title={mcpSnapshot.config_path}>
                          <span>Config</span>
                          <code>{mcpSnapshot.config_path}</code>
                          <button
                            type="button"
                            className="ai-settings-ghost-btn"
                            title="Copy path"
                            onClick={() => {
                              void navigator.clipboard?.writeText(mcpSnapshot.config_path || '').catch(() => {});
                            }}
                          >
                            <Clipboard size={13} aria-hidden />
                            <span>Copy</span>
                          </button>
                        </div>
                      ) : null}
""",
    "mcp-path",
)

# reconnect disabled note for remote already has transport check

path.write_text(text, encoding="utf-8")
print("phase2 ok")