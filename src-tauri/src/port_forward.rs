//! Local forwarding is owned by a terminal connection generation, not its profile.
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use panda_session::LocalPortForward;
use serde::Serialize;
use tokio::{
    io::{copy, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{oneshot, watch, Mutex},
    task::JoinSet,
};
use uuid::Uuid;

type SharedHandle<H> = Arc<russh::client::Handle<H>>;

const MAX_CLIENTS: usize = 64;
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

type Key = (Uuid, Uuid);
type Events = Arc<dyn Fn(PortForwardSnapshot) + Send + Sync>;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PortForwardState {
    Listening,
    Stopping,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct PortForwardStatus {
    pub rule_id: Uuid,
    pub instance_id: Uuid,
    pub state: PortForwardState,
    pub local_host: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PortForwardSnapshot {
    pub terminal_id: Uuid,
    pub generation: Uuid,
    pub revision: u64,
    pub forwards: Vec<PortForwardStatus>,
}

struct Instance {
    status: PortForwardStatus,
    cancel: watch::Sender<bool>,
    done: watch::Receiver<bool>,
}
#[derive(Default)]
struct Generation {
    revision: u64,
    forwards: HashMap<Uuid, Instance>,
}

#[derive(Clone, Default)]
pub struct PortForwardManager {
    inner: Arc<Mutex<HashMap<Key, Generation>>>,
    pending: Arc<std::sync::Mutex<HashMap<Key, Vec<tokio::task::JoinHandle<()>>>>>,
}

fn snapshot(key: Key, generation: Option<&Generation>) -> PortForwardSnapshot {
    let mut forwards: Vec<_> = generation
        .into_iter()
        .flat_map(|g| g.forwards.values())
        .map(|i| i.status.clone())
        .collect();
    forwards.sort_by_key(|s| s.rule_id);
    PortForwardSnapshot {
        terminal_id: key.0,
        generation: key.1,
        revision: generation.map_or(0, |g| g.revision),
        forwards,
    }
}

async fn cancelled(rx: &mut watch::Receiver<bool>) {
    loop {
        if *rx.borrow_and_update() {
            return;
        }
        if rx.changed().await.is_err() {
            return;
        }
    }
}

impl PortForwardManager {
    pub async fn list(&self, terminal_id: Uuid, generation: Uuid) -> PortForwardSnapshot {
        let inner = self.inner.lock().await;
        snapshot(
            (terminal_id, generation),
            inner.get(&(terminal_id, generation)),
        )
    }

    /// Called while the terminal table guard proves this generation is alive.
    /// Binding is local and synchronous; no network awaits happen under either lock.
    pub async fn start<H: russh::client::Handler + Send + 'static>(
        &self,
        terminal_id: Uuid,
        generation: Uuid,
        rule: LocalPortForward,
        handle: SharedHandle<H>,
        events: Events,
    ) -> Result<PortForwardSnapshot, String> {
        panda_session::validate_local_port_forwards(std::slice::from_ref(&rule))
            .map_err(|e| e.to_string())?;
        let key = (terminal_id, generation);
        let mut inner = self.inner.lock().await;
        let g = inner.entry(key).or_default();
        if let Some(instance) = g.forwards.get(&rule.id) {
            if instance.status.state == PortForwardState::Failed && *instance.done.borrow() {
                // A fully drained failed instance can safely be replaced.
            } else if instance.status.state == PortForwardState::Listening {
                return Ok(snapshot(key, Some(g)));
            } else {
                return Err("forward instance must be stopped before restarting".into());
            }
        }
        let instance_id = Uuid::new_v4();
        let address = SocketAddr::new(
            rule.local_host
                .parse::<IpAddr>()
                .map_err(|e| e.to_string())?,
            rule.local_port,
        );
        let listener = std::net::TcpListener::bind(address)
            .and_then(|l| {
                l.set_nonblocking(true)?;
                Ok(l)
            })
            .and_then(TcpListener::from_std);
        let (cancel, cancel_rx) = watch::channel(false);
        let (done_tx, done) = watch::channel(false);
        let status = PortForwardStatus {
            rule_id: rule.id,
            instance_id,
            state: if listener.is_ok() {
                PortForwardState::Listening
            } else {
                PortForwardState::Failed
            },
            local_host: rule.local_host.clone(),
            local_port: rule.local_port,
            remote_host: rule.remote_host.clone(),
            remote_port: rule.remote_port,
            last_error: listener
                .as_ref()
                .err()
                .map(|e| format!("Cannot listen on {address}: {e}")),
        };
        g.forwards.insert(
            rule.id,
            Instance {
                status,
                cancel,
                done,
            },
        );
        g.revision += 1;
        let result = snapshot(key, Some(g));
        drop(inner);
        events(result.clone());
        if let Ok(listener) = listener {
            let manager = self.clone();
            tokio::spawn(async move {
                manager
                    .listen(key, instance_id, rule, listener, handle, cancel_rx, events)
                    .await;
                done_tx.send_replace(true);
            });
        } else {
            done_tx.send_replace(true);
        }
        Ok(result)
    }

    async fn error(
        &self,
        key: Key,
        rule_id: Uuid,
        instance_id: Uuid,
        message: String,
        fatal: bool,
        events: &Events,
    ) {
        let mut inner = self.inner.lock().await;
        if let Some(g) = inner.get_mut(&key) {
            if let Some(instance) = g.forwards.get_mut(&rule_id) {
                if instance.status.instance_id != instance_id
                    || instance.status.state == PortForwardState::Stopping
                {
                    return;
                }
                instance.status.last_error = Some(message);
                if fatal {
                    instance.status.state = PortForwardState::Failed;
                }
                g.revision += 1;
                let event = snapshot(key, Some(g));
                drop(inner);
                events(event);
            }
        }
    }

    async fn listen<H: russh::client::Handler + Send + 'static>(
        &self,
        key: Key,
        instance_id: Uuid,
        rule: LocalPortForward,
        listener: TcpListener,
        handle: SharedHandle<H>,
        mut cancel: watch::Receiver<bool>,
        events: Events,
    ) {
        let mut clients = JoinSet::new();
        loop {
            tokio::select! {
                biased;
                _ = cancelled(&mut cancel) => break,
                result = clients.join_next(), if !clients.is_empty() => {
                    if let Some(Err(e)) = result {
                        self.error(key, rule.id, instance_id, format!("Forward client task failed: {e}"), false, &events).await;
                    }
                }
                accepted = listener.accept() => {
                    match accepted {
                        Ok((socket, peer)) => {
                            if clients.len() >= MAX_CLIENTS {
                                drop(socket);
                                self.error(key, rule.id, instance_id, "Forward client limit reached (64)".into(), false, &events).await;
                                continue;
                            }
                            let manager = self.clone();
                            let rule = rule.clone();
                            let handle = handle.clone();
                            let cancel = cancel.clone();
                            let events = events.clone();
                            clients.spawn(async move {
                                if let Err(e) = forward_client(socket, peer, &rule, handle, cancel, manager.clone(), key).await {
                                    manager.error(key, rule.id, instance_id, e, false, &events).await;
                                }
                            });
                        }
                        Err(e) => {
                            self.error(key, rule.id, instance_id, format!("Forward accept failed: {e}"), true, &events).await;
                            break;
                        }
                    }
                }
            }
        }
        // Close the listening socket before waiting on clients, and cancel clients
        // on accept failure as well as on explicit stop.
        drop(listener);
        let cancellation = {
            let inner = self.inner.lock().await;
            inner
                .get(&key)
                .and_then(|g| g.forwards.get(&rule.id))
                .filter(|i| i.status.instance_id == instance_id)
                .map(|i| i.cancel.clone())
        };
        if let Some(tx) = cancellation {
            tx.send_replace(true);
        }
        while clients.join_next().await.is_some() {}
    }

    pub async fn stop(
        &self,
        terminal_id: Uuid,
        generation: Uuid,
        rule_id: Uuid,
        instance_id: Uuid,
        events: Events,
    ) -> PortForwardSnapshot {
        let key = (terminal_id, generation);
        let (done, event) = {
            let mut inner = self.inner.lock().await;
            let Some(g) = inner.get_mut(&key) else {
                return snapshot(key, None);
            };
            let Some(instance) = g.forwards.get_mut(&rule_id) else {
                return snapshot(key, Some(g));
            };
            if instance.status.instance_id != instance_id {
                return snapshot(key, Some(g));
            }
            instance.cancel.send_replace(true);
            let done = instance.done.clone();
            let changed = instance.status.state != PortForwardState::Stopping;
            if changed {
                instance.status.state = PortForwardState::Stopping;
                g.revision += 1;
            }
            (done, changed.then(|| snapshot(key, Some(g))))
        };
        if let Some(event) = event {
            events(event);
        }
        let mut done = done;
        while !*done.borrow_and_update() {
            if done.changed().await.is_err() {
                break;
            }
        }
        let mut inner = self.inner.lock().await;
        if let Some(g) = inner.get_mut(&key) {
            if g.forwards
                .get(&rule_id)
                .is_some_and(|i| i.status.instance_id == instance_id)
            {
                g.forwards.remove(&rule_id);
                g.revision += 1;
            }
        }
        let result = snapshot(key, inner.get(&key));
        drop(inner);
        events(result.clone());
        result
    }

    pub async fn stop_generation(&self, terminal_id: Uuid, generation: Uuid, events: Events) {
        let instances = {
            let inner = self.inner.lock().await;
            inner
                .get(&(terminal_id, generation))
                .map(|g| {
                    // Signal all clients/listeners immediately, then await them outside the lock.
                    g.forwards
                        .values()
                        .map(|i| {
                            i.cancel.send_replace(true);
                            (i.status.rule_id, i.status.instance_id)
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };
        for (rule_id, instance_id) in instances {
            self.stop(
                terminal_id,
                generation,
                rule_id,
                instance_id,
                events.clone(),
            )
            .await;
        }
        self.inner.lock().await.remove(&(terminal_id, generation));
    }

    /// Call only after shutting down this generation's transport. russh can retain
    /// confirmation senders after disconnect, so bound the drain then abort and
    /// await residual opens. No late channel can be established on a dead socket.
    pub async fn drain_generation(&self, terminal_id: Uuid, generation: Uuid) {
        let mut tasks = self
            .pending
            .lock()
            .unwrap()
            .remove(&(terminal_id, generation))
            .unwrap_or_default();
        let deadline = tokio::time::Instant::now() + CLOSE_TIMEOUT;
        while let Some(mut task) = tasks.pop() {
            if tokio::time::timeout_at(deadline, &mut task).await.is_err() {
                task.abort();
                for remaining in &tasks {
                    remaining.abort();
                }
                let _ = task.await;
                for remaining in tasks {
                    let _ = remaining.await;
                }
                break;
            }
        }
    }

    pub async fn stop_all(&self, events: Events) {
        let keys: Vec<_> = self.inner.lock().await.keys().copied().collect();
        for (terminal_id, generation) in keys {
            self.stop_generation(terminal_id, generation, events.clone())
                .await;
        }
    }
}

async fn forward_client<H: russh::client::Handler + Send + 'static>(
    socket: TcpStream,
    peer: SocketAddr,
    rule: &LocalPortForward,
    handle: SharedHandle<H>,
    mut cancel: watch::Receiver<bool>,
    manager: PortForwardManager,
    key: Key,
) -> Result<(), String> {
    let (tx, rx) = oneshot::channel();
    let (ack, acknowledged) = oneshot::channel::<()>();
    let slot = Arc::new(std::sync::Mutex::new(None));
    let open_slot = slot.clone();
    {
        let mut pending = manager.pending.lock().unwrap();
        let tasks = pending.entry(key).or_default();
        tasks.retain(|task| !task.is_finished());
        if tasks.len() >= MAX_CLIENTS {
            return Err("SSH pending channel limit reached (64)".into());
        }
        let host = rule.remote_host.clone();
        let port = rule.remote_port;
        tasks.push(tokio::spawn(async move {
            let opened = handle
                .channel_open_direct_tcpip(
                    host,
                    port as u32,
                    peer.ip().to_string(),
                    peer.port() as u32,
                )
                .await;
            *open_slot.lock().unwrap() = Some(opened);
            let delivered = tx.send(()).is_ok();
            if !delivered || acknowledged.await.is_err() {
                let orphan = open_slot.lock().unwrap().take();
                if let Some(Ok(channel)) = orphan {
                    let _ = tokio::time::timeout(CLOSE_TIMEOUT, channel.close()).await;
                }
            }
        }));
    }
    let opened = tokio::select! {
        biased;
        _ = cancelled(&mut cancel) => return Ok(()),
        opened = tokio::time::timeout(OPEN_TIMEOUT, rx) => opened,
    };
    match opened {
        Ok(Ok(())) => (),
        Ok(Err(_)) => return Err("SSH channel open task ended".into()),
        Err(_) => {
            return Err(format!(
                "SSH target {}:{} open timed out",
                rule.remote_host, rule.remote_port
            ))
        }
    }
    // Taking ownership and acknowledging is synchronous, so cancellation cannot
    // strand a successfully delivered channel in an unread oneshot buffer.
    let opened = slot
        .lock()
        .unwrap()
        .take()
        .ok_or("SSH channel result missing")?;
    let _ = ack.send(());
    let mut channel = opened.map_err(|e| {
        format!(
            "SSH target {}:{} rejected: {e}",
            rule.remote_host, rule.remote_port
        )
    })?;
    let result = {
        let mut writer = channel.make_writer();
        let mut reader = channel.make_reader();
        let (mut tcp_read, mut tcp_write) = socket.into_split();
        let transfer = async {
            tokio::try_join!(
                async {
                    copy(&mut tcp_read, &mut writer).await?;
                    writer.shutdown().await
                },
                async {
                    copy(&mut reader, &mut tcp_write).await?;
                    tcp_write.shutdown().await
                }
            )
        };
        tokio::select! {
            biased;
            _ = cancelled(&mut cancel) => Ok(()),
            result = transfer => result.map(|_| ()).map_err(|e| format!("Forward transfer failed: {e}")),
        }
    };
    // Writer shutdown sends SSH EOF (half-close); EOF is not SSH channel close.
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, channel.close()).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct Client;
    impl russh::client::Handler for Client {
        type Error = russh::Error;
        async fn check_server_key(
            &mut self,
            _: &russh::keys::PublicKey,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }
    struct Server {
        delay: Duration,
        unconfirmed: Option<Arc<tokio::sync::Notify>>,
    }
    impl russh::server::Handler for Server {
        type Error = russh::Error;
        async fn auth_none(&mut self, _: &str) -> Result<russh::server::Auth, Self::Error> {
            Ok(russh::server::Auth::Accept)
        }
        async fn channel_open_direct_tcpip(
            &mut self,
            mut channel: russh::Channel<russh::server::Msg>,
            host: &str,
            port: u32,
            _: &str,
            _: u32,
            _: &mut russh::server::Session,
        ) -> Result<bool, Self::Error> {
            if host == "reject.test" {
                return Ok(false);
            }
            if let Some(unconfirmed) = &self.unconfirmed {
                unconfirmed.notify_one();
                std::future::pending::<()>().await;
            }
            tokio::time::sleep(self.delay).await;
            let mut socket = TcpStream::connect((host, port as u16)).await?;
            tokio::spawn(async move {
                let mut writer = channel.make_writer();
                let mut reader = channel.make_reader();
                let (mut read, mut write) = socket.split();
                let _ = tokio::try_join!(
                    async {
                        copy(&mut reader, &mut write).await?;
                        write.shutdown().await
                    },
                    async {
                        copy(&mut read, &mut writer).await?;
                        writer.shutdown().await
                    }
                );
                drop(reader);
                let _ = channel.close().await;
            });
            Ok(true)
        }
    }
    async fn ssh(delay: Duration) -> (SharedHandle<Client>, tokio::task::JoinHandle<()>) {
        let (handle, task, _) = ssh_transport(delay, None).await;
        (handle, task)
    }
    async fn ssh_transport(
        delay: Duration,
        unconfirmed: Option<Arc<tokio::sync::Notify>>,
    ) -> (
        SharedHandle<Client>,
        tokio::task::JoinHandle<()>,
        std::net::TcpStream,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let mut config = russh::server::Config::default();
            config.keys.push(
                russh::keys::PrivateKey::random(
                    &mut russh::keys::key::safe_rng(),
                    russh::keys::Algorithm::Ed25519,
                )
                .unwrap(),
            );
            let (mut socket, _) = listener.accept().await.unwrap();
            // russh's test server awaits outgoing flushes before reading again.
            // Buffer this fixture's socket I/O independently so simultaneous
            // channel replies and uploads can progress. The production client
            // keeps its TCP stream; the optional independent peer tests that path.
            let (stream, mut network) = tokio::io::duplex(4 * 1024 * 1024);
            let bridge = tokio::spawn(async move {
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut network).await;
            });
            let running =
                russh::server::run_stream(Arc::new(config), stream, Server { delay, unconfirmed })
                    .await
                    .unwrap();
            let _ = running.await;
            bridge.abort();
            let _ = bridge.await;
        });
        let socket = TcpStream::connect(address).await.unwrap();
        let socket = socket.into_std().unwrap();
        let transport = socket.try_clone().unwrap();
        let socket = TcpStream::from_std(socket).unwrap();
        let mut config = russh::client::Config::default();
        config.window_size = 16 * 1024 * 1024;
        config.channel_buffer_size = 1024;
        let mut handle = russh::client::connect_stream(Arc::new(config), socket, Client)
            .await
            .unwrap();
        assert!(handle.authenticate_none("test").await.unwrap().success());
        (Arc::new(handle), task, transport)
    }
    fn rule(remote_port: u16) -> LocalPortForward {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        LocalPortForward {
            id: Uuid::new_v4(),
            name: "test".into(),
            local_host: "127.0.0.1".into(),
            local_port: listener.local_addr().unwrap().port(),
            remote_host: "127.0.0.1".into(),
            remote_port,
        }
    }
    fn events() -> Events {
        Arc::new(|_| {})
    }
    async fn finish(
        handle: SharedHandle<Client>,
        task: tokio::task::JoinHandle<()>,
        manager: &PortForwardManager,
        key: Key,
    ) {
        manager.stop_generation(key.0, key.1, events()).await;
        handle
            .disconnect(russh::Disconnect::ByApplication, "test done", "")
            .await
            .unwrap();
        tokio::time::timeout(
            Duration::from_secs(5),
            manager.drain_generation(key.0, key.1),
        )
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn transfers_large_payload_and_preserves_half_close() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = target.local_addr().unwrap().port();
        let echo = tokio::spawn(async move {
            let (mut socket, _) = target.accept().await.unwrap();
            let mut bytes = Vec::new();
            socket.read_to_end(&mut bytes).await.unwrap();
            // Reply only after client EOF to verify half-close.
            socket.write_all(&bytes).await.unwrap();
            socket.shutdown().await.unwrap();
        });
        let (handle, server) = ssh(Duration::ZERO).await;
        let manager = PortForwardManager::default();
        let key = (Uuid::new_v4(), Uuid::new_v4());
        let rule = rule(port);
        let started = manager
            .start(key.0, key.1, rule.clone(), handle.clone(), events())
            .await
            .unwrap();
        let payload = vec![0x5a; 512 * 1024];
        let mut client = TcpStream::connect((rule.local_host.as_str(), rule.local_port))
            .await
            .unwrap();
        client.write_all(&payload).await.unwrap();
        client.shutdown().await.unwrap();
        let mut received = Vec::new();
        tokio::time::timeout(Duration::from_secs(10), client.read_to_end(&mut received))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(received, payload);
        echo.await.unwrap();
        let stopped = manager
            .stop(
                key.0,
                key.1,
                rule.id,
                started.forwards[0].instance_id,
                events(),
            )
            .await;
        assert!(stopped.forwards.is_empty());
        assert!(stopped.revision > started.revision);
        let rebound = TcpListener::bind((rule.local_host.as_str(), rule.local_port))
            .await
            .unwrap();
        drop(rebound);
        finish(handle, server, &manager, key).await;
    }

    #[tokio::test]
    async fn concurrent_start_instance_guard_bind_conflict_and_generation_isolation() {
        let (handle, server) = ssh(Duration::ZERO).await;
        let manager = PortForwardManager::default();
        let key = (Uuid::new_v4(), Uuid::new_v4());
        let rule = rule(22);
        let (a, b) = tokio::join!(
            manager.start(key.0, key.1, rule.clone(), handle.clone(), events()),
            manager.start(key.0, key.1, rule.clone(), handle.clone(), events())
        );
        let a = a.unwrap();
        let b = b.unwrap();
        assert_eq!(a.forwards[0].instance_id, b.forwards[0].instance_id);
        let ignored = manager
            .stop(key.0, key.1, rule.id, Uuid::new_v4(), events())
            .await;
        assert_eq!(ignored.forwards[0].state, PortForwardState::Listening);
        let other = Uuid::new_v4();
        let conflicting = manager
            .start(key.0, other, rule.clone(), handle.clone(), events())
            .await
            .unwrap();
        assert_eq!(conflicting.forwards[0].state, PortForwardState::Failed);
        manager.stop_generation(key.0, other, events()).await;
        assert_eq!(manager.list(key.0, key.1).await.forwards.len(), 1);
        finish(handle, server, &manager, key).await;
    }

    #[tokio::test]
    async fn independent_clients_transfer_simultaneously() {
        simultaneous_clients().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn independent_clients_transfer_on_multithread_runtime() {
        simultaneous_clients().await;
    }

    async fn simultaneous_clients() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = target.local_addr().unwrap().port();
        let echo = tokio::spawn(async move {
            let mut clients = JoinSet::new();
            for _ in 0..8 {
                let (mut socket, _) = target.accept().await.unwrap();
                clients.spawn(async move {
                    let mut bytes = Vec::new();
                    socket.read_to_end(&mut bytes).await.unwrap();
                    socket.write_all(&bytes).await.unwrap();
                    socket.shutdown().await.unwrap();
                });
            }
            while let Some(result) = clients.join_next().await {
                result.unwrap();
            }
        });
        let (handle, server) = if let Ok(port) = std::env::var("PANDATERM_TEST_SSH_PORT") {
            let mut config = russh::client::Config::default();
            config.window_size = 16 * 1024 * 1024;
            config.channel_buffer_size = 1024;
            let mut handle = russh::client::connect(
                Arc::new(config),
                ("127.0.0.1", port.parse::<u16>().unwrap()),
                Client,
            )
            .await
            .unwrap();
            assert!(handle.authenticate_none("test").await.unwrap().success());
            (Arc::new(handle), tokio::spawn(async {}))
        } else {
            ssh(Duration::ZERO).await
        };
        let manager = PortForwardManager::default();
        let key = (Uuid::new_v4(), Uuid::new_v4());
        let rule = rule(port);
        manager
            .start(key.0, key.1, rule.clone(), handle.clone(), events())
            .await
            .unwrap();
        let mut clients = JoinSet::new();
        for byte in 0..8u8 {
            let port = rule.local_port;
            clients.spawn(async move {
                let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
                let payload = vec![byte; 128 * 1024];
                client.write_all(&payload).await.unwrap();
                client.shutdown().await.unwrap();
                let mut response = Vec::new();
                client.read_to_end(&mut response).await.unwrap();
                assert_eq!(response, payload);
            });
        }
        tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(result) = clients.join_next().await {
                result.unwrap();
            }
            echo.await.unwrap();
        })
        .await
        .unwrap();
        finish(handle, server, &manager, key).await;
    }

    #[tokio::test]
    async fn transport_shutdown_drains_a_never_confirmed_open() {
        let unconfirmed = Arc::new(tokio::sync::Notify::new());
        let (handle, server, transport) =
            ssh_transport(Duration::ZERO, Some(unconfirmed.clone())).await;
        let manager = PortForwardManager::default();
        let key = (Uuid::new_v4(), Uuid::new_v4());
        let rule = rule(22);
        manager
            .start(key.0, key.1, rule.clone(), handle.clone(), events())
            .await
            .unwrap();
        let mut client = TcpStream::connect((rule.local_host.as_str(), rule.local_port))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), unconfirmed.notified())
            .await
            .unwrap();
        tokio::time::timeout(
            Duration::from_secs(1),
            manager.stop_generation(key.0, key.1, events()),
        )
        .await
        .unwrap();
        assert!(!manager.pending.lock().unwrap()[&key][0].is_finished());
        let mut byte = [0];
        assert_eq!(client.read(&mut byte).await.unwrap(), 0);
        transport.shutdown(std::net::Shutdown::Both).unwrap();
        tokio::time::timeout(
            Duration::from_secs(3),
            manager.drain_generation(key.0, key.1),
        )
        .await
        .unwrap();
        assert!(!manager.pending.lock().unwrap().contains_key(&key));
        drop(handle);
        // The deliberately stuck server callback cannot observe its socket;
        // abort only that test peer after the client transport has drained.
        server.abort();
        let _ = server.await;
    }

    #[tokio::test]
    async fn pending_open_limit_survives_restarts() {
        let (handle, server) = ssh(Duration::ZERO).await;
        let manager = PortForwardManager::default();
        let key = (Uuid::new_v4(), Uuid::new_v4());
        // Model a peer that never confirms its opens. These supervised slots
        // deliberately survive stop/start of an individual rule.
        let mut tasks = Vec::new();
        for _ in 0..MAX_CLIENTS {
            tasks.push(tokio::spawn(std::future::pending::<()>()));
        }
        manager.pending.lock().unwrap().insert(key, tasks);
        let rule = rule(22);
        for _ in 0..2 {
            let started = manager
                .start(key.0, key.1, rule.clone(), handle.clone(), events())
                .await
                .unwrap();
            let mut client = TcpStream::connect((rule.local_host.as_str(), rule.local_port))
                .await
                .unwrap();
            let mut byte = [0];
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(2), client.read(&mut byte))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
            assert!(manager.list(key.0, key.1).await.forwards[0]
                .last_error
                .as_ref()
                .unwrap()
                .contains("pending channel limit"));
            manager
                .stop(
                    key.0,
                    key.1,
                    rule.id,
                    started.forwards[0].instance_id,
                    events(),
                )
                .await;
            assert_eq!(manager.pending.lock().unwrap()[&key].len(), MAX_CLIENTS);
        }
        for task in manager.pending.lock().unwrap().remove(&key).unwrap() {
            task.abort();
        }
        finish(handle, server, &manager, key).await;
    }

    #[tokio::test]
    async fn stop_cancels_an_active_client_and_releases_port() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (handle, server) = ssh(Duration::ZERO).await;
        let manager = PortForwardManager::default();
        let key = (Uuid::new_v4(), Uuid::new_v4());
        let rule = rule(target.local_addr().unwrap().port());
        let started = manager
            .start(key.0, key.1, rule.clone(), handle.clone(), events())
            .await
            .unwrap();
        let mut client = TcpStream::connect((rule.local_host.as_str(), rule.local_port))
            .await
            .unwrap();
        let (mut remote, _) = tokio::time::timeout(Duration::from_secs(3), target.accept())
            .await
            .unwrap()
            .unwrap();
        client.write_all(b"ready").await.unwrap();
        let mut ready = [0; 5];
        remote.read_exact(&mut ready).await.unwrap();
        assert_eq!(&ready, b"ready");
        manager
            .stop(
                key.0,
                key.1,
                rule.id,
                started.forwards[0].instance_id,
                events(),
            )
            .await;
        let mut byte = [0];
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), client.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), remote.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        assert!(
            TcpListener::bind((rule.local_host.as_str(), rule.local_port))
                .await
                .is_ok()
        );
        finish(handle, server, &manager, key).await;
    }

    #[tokio::test]
    async fn target_rejection_keeps_listener_and_records_error() {
        let (handle, server) = ssh(Duration::ZERO).await;
        let manager = PortForwardManager::default();
        let key = (Uuid::new_v4(), Uuid::new_v4());
        let mut rule = rule(22);
        rule.remote_host = "reject.test".into();
        manager
            .start(key.0, key.1, rule.clone(), handle.clone(), events())
            .await
            .unwrap();
        let mut client = TcpStream::connect((rule.local_host.as_str(), rule.local_port))
            .await
            .unwrap();
        let mut byte = [0];
        tokio::time::timeout(Duration::from_secs(5), client.read(&mut byte))
            .await
            .unwrap()
            .unwrap();
        let status = manager.list(key.0, key.1).await.forwards.remove(0);
        assert_eq!(status.state, PortForwardState::Listening);
        assert!(status.last_error.unwrap().contains("rejected"));
        finish(handle, server, &manager, key).await;
    }

    #[tokio::test]
    async fn stop_releases_client_and_closes_delayed_confirmation() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (handle, server) = ssh(Duration::from_millis(300)).await;
        let manager = PortForwardManager::default();
        let key = (Uuid::new_v4(), Uuid::new_v4());
        let rule = rule(target.local_addr().unwrap().port());
        let started = manager
            .start(key.0, key.1, rule.clone(), handle.clone(), events())
            .await
            .unwrap();
        let mut client = TcpStream::connect((rule.local_host.as_str(), rule.local_port))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if manager
                    .pending
                    .lock()
                    .unwrap()
                    .get(&key)
                    .is_some_and(|v| !v.is_empty())
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::time::timeout(
            Duration::from_millis(200),
            manager.stop(
                key.0,
                key.1,
                rule.id,
                started.forwards[0].instance_id,
                events(),
            ),
        )
        .await
        .unwrap();
        let mut byte = [0];
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), client.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        let (mut remote, _) = tokio::time::timeout(Duration::from_secs(3), target.accept())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), remote.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        assert!(manager.list(key.0, key.1).await.forwards.is_empty());
        finish(handle, server, &manager, key).await;
    }
}
