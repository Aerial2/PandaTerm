//! Native Agent loop state. Each provider turn is a step; the loop suspends at
//! the UI approval boundary and resumes only after matching tool results arrive.
use crate::ai_provider;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};

pub const EVENT_PROTOCOL: &str = "pandaterm.ai.v1";
pub const DEFAULT_MAX_STEPS: u32 = 32;
const MAX_RUNS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentPhase {
    Idle,
    Thinking,
    AwaitingToolApproval,
    ExecutingTool,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRun {
    pub agent_id: String,
    pub conversation_id: String,
    pub step_index: u32,
    pub max_steps: u32,
    pub phase: AgentPhase,
    pub account_id: String,
    pub model: String,
    pub pending_tool_ids: Vec<String>,
}

impl AgentRun {
    pub fn new(agent_id: impl Into<String>, conversation_id: impl Into<String>) -> Self {
        Self {
            agent_id: agent_id.into(),
            conversation_id: conversation_id.into(),
            step_index: 0,
            max_steps: DEFAULT_MAX_STEPS,
            phase: AgentPhase::Idle,
            account_id: String::new(),
            model: String::new(),
            pending_tool_ids: Vec::new(),
        }
    }
    pub fn begin_step(&mut self) -> Result<u32, String> {
        if !matches!(
            self.phase,
            AgentPhase::Idle | AgentPhase::AwaitingToolApproval
        ) {
            return Err("Agent 当前状态不允许开始新步骤".into());
        }
        if self.step_index >= self.max_steps {
            self.phase = AgentPhase::Failed;
            return Err(format!("Agent 步骤不能超过 {} 步", self.max_steps));
        }
        self.step_index += 1;
        self.phase = AgentPhase::Thinking;
        Ok(self.step_index)
    }
    pub fn transition(&mut self, phase: AgentPhase) -> Result<(), String> {
        let allowed = self.phase == phase
            || match self.phase {
                AgentPhase::Idle => matches!(
                    phase,
                    AgentPhase::Thinking | AgentPhase::Cancelled | AgentPhase::Failed
                ),
                AgentPhase::Thinking => matches!(
                    phase,
                    AgentPhase::AwaitingToolApproval
                        | AgentPhase::Completed
                        | AgentPhase::Cancelled
                        | AgentPhase::Failed
                ),
                AgentPhase::AwaitingToolApproval => matches!(
                    phase,
                    AgentPhase::ExecutingTool
                        | AgentPhase::Thinking
                        | AgentPhase::Cancelled
                        | AgentPhase::Failed
                ),
                AgentPhase::ExecutingTool => matches!(
                    phase,
                    AgentPhase::AwaitingToolApproval | AgentPhase::Cancelled | AgentPhase::Failed
                ),
                _ => false,
            };
        if !allowed {
            return Err("Agent 状态转换无效，已结束任务不能重新启动".into());
        }
        self.phase = phase;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentEventMeta {
    pub protocol: &'static str,
    pub agent_id: String,
    pub step_id: String,
    pub step_index: u32,
    pub sequence: u64,
    pub phase: AgentPhase,
}

#[derive(Clone)]
pub struct AgentStep {
    pub agent_id: String,
    pub request_id: String,
    pub step_index: u32,
    sequence: Arc<AtomicU64>,
}
impl AgentStep {
    pub fn meta(&self, phase: AgentPhase) -> AgentEventMeta {
        AgentEventMeta {
            protocol: EVENT_PROTOCOL,
            agent_id: self.agent_id.clone(),
            step_id: self.request_id.clone(),
            step_index: self.step_index,
            sequence: self.sequence.fetch_add(1, Ordering::SeqCst) + 1,
            phase,
        }
    }
}

#[derive(Default)]
struct Runs {
    entries: HashMap<String, AgentRun>,
    order: VecDeque<String>,
}
#[derive(Default)]
pub struct AgentRuntime {
    runs: Mutex<Runs>,
}

impl AgentRuntime {
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &self,
        agent_id: &str,
        conversation_id: &str,
        request_id: &str,
        account_id: &str,
        model: &str,
        resolved: &HashSet<String>,
        resume_step: u32,
    ) -> Result<AgentStep, String> {
        for id in [agent_id, conversation_id, request_id] {
            uuid::Uuid::parse_str(id).map_err(|_| "Agent、会话或步骤 ID 无效".to_string())?;
        }
        if resume_step == 0 || resume_step > DEFAULT_MAX_STEPS {
            return Err("Agent 恢复步骤超出限制".into());
        }
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| "Agent 状态锁不可用".to_string())?;
        if !runs.entries.contains_key(agent_id) {
            while runs.entries.len() >= MAX_RUNS {
                let position = runs
                    .order
                    .iter()
                    .position(|id| {
                        runs.entries.get(id).is_some_and(|run| {
                            !matches!(run.phase, AgentPhase::Thinking | AgentPhase::ExecutingTool)
                        })
                    })
                    .ok_or_else(|| "同时运行的 Agent 过多".to_string())?;
                let id = runs.order.remove(position).unwrap();
                runs.entries.remove(&id);
            }
            let mut run = AgentRun::new(agent_id, conversation_id);
            run.account_id = account_id.into();
            run.model = model.into();
            run.step_index = resume_step - 1;
            runs.entries.insert(agent_id.into(), run);
            runs.order.push_back(agent_id.into());
        }
        let run = runs.entries.get_mut(agent_id).unwrap();
        if run.conversation_id != conversation_id
            || run.account_id != account_id
            || run.model != model
        {
            return Err("Agent 续接必须使用原会话、账号和模型".into());
        }
        if !run.pending_tool_ids.iter().all(|id| resolved.contains(id)) {
            return Err("Agent 仍有未完成授权或执行结果的工具调用".into());
        }
        let step_index = run.begin_step()?;
        run.pending_tool_ids.clear();
        Ok(AgentStep {
            agent_id: agent_id.into(),
            request_id: request_id.into(),
            step_index,
            sequence: Arc::new(AtomicU64::new(0)),
        })
    }
    pub fn finish(
        &self,
        step: &AgentStep,
        response: &ai_provider::ProviderResponse,
    ) -> Result<AgentPhase, String> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| "Agent 状态锁不可用".to_string())?;
        let run = runs
            .entries
            .get_mut(&step.agent_id)
            .ok_or_else(|| "Agent 状态不存在".to_string())?;
        if run.step_index != step.step_index {
            return Err("Agent 步骤已失效".into());
        }
        let phase = if response.cancelled {
            AgentPhase::Cancelled
        } else if !response.tool_calls.is_empty()
            || [
                "```pandaterm-terminal",
                "```pandaterm-mcp",
                "```pandaterm-edit",
            ]
            .iter()
            .any(|tag| response.content.contains(tag))
        {
            AgentPhase::AwaitingToolApproval
        } else {
            AgentPhase::Completed
        };
        run.pending_tool_ids = response
            .tool_calls
            .iter()
            .map(|call| call.id.clone())
            .collect();
        run.transition(phase)?;
        Ok(phase)
    }
    pub fn fail(&self, step: &AgentStep) {
        if let Ok(mut runs) = self.runs.lock() {
            if let Some(run) = runs
                .entries
                .get_mut(&step.agent_id)
                .filter(|run| run.step_index == step.step_index)
            {
                let _ = run.transition(AgentPhase::Failed);
            }
        }
    }
    #[cfg(test)]
    pub fn snapshot(&self, agent_id: &str) -> Option<AgentRun> {
        self.runs.lock().ok()?.entries.get(agent_id).cloned()
    }
    /// The executor updates the owning run while preserving the provider step.
    pub fn tool_phase(&self, tool_id: &str, executing: bool) {
        if let Ok(mut runs) = self.runs.lock() {
            for run in runs
                .entries
                .values_mut()
                .filter(|run| run.pending_tool_ids.iter().any(|id| id == tool_id))
            {
                let _ = run.transition(if executing {
                    AgentPhase::ExecutingTool
                } else {
                    AgentPhase::AwaitingToolApproval
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ids() -> (String, String, String) {
        (
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
        )
    }
    #[test]
    fn steps_bounded_and_terminal_cannot_restart() {
        let mut run = AgentRun::new("a", "c");
        run.max_steps = 2;
        assert_eq!(run.begin_step().unwrap(), 1);
        assert!(run.begin_step().is_err());
        run.transition(AgentPhase::AwaitingToolApproval).unwrap();
        assert_eq!(run.begin_step().unwrap(), 2);
        run.transition(AgentPhase::AwaitingToolApproval).unwrap();
        assert!(run.begin_step().is_err());
        assert_eq!(run.phase, AgentPhase::Failed);
    }
    #[test]
    fn approval_results_resume_and_pin_model() {
        let runtime = AgentRuntime::default();
        let (a, c, r) = ids();
        let step = runtime
            .start(&a, &c, &r, "account", "model", &HashSet::new(), 1)
            .unwrap();
        let response = ai_provider::ProviderResponse {
            tool_calls: vec![ai_provider::UnifiedToolCall {
                id: "call_1".into(),
                name: "call_mcp_tool".into(),
                arguments: "{}".into(),
            }],
            ..Default::default()
        };
        assert_eq!(
            runtime.finish(&step, &response).unwrap(),
            AgentPhase::AwaitingToolApproval
        );
        assert!(runtime
            .start(&a, &c, &r, "account", "other", &HashSet::new(), 1)
            .is_err());
        assert!(runtime
            .start(&a, &c, &r, "account", "model", &HashSet::new(), 1)
            .is_err());
        runtime.tool_phase("call_1", true);
        assert_eq!(
            runtime.snapshot(&a).unwrap().phase,
            AgentPhase::ExecutingTool
        );
        runtime.tool_phase("call_1", false);
        let second = runtime
            .start(
                &a,
                &c,
                &r,
                "account",
                "model",
                &HashSet::from(["call_1".into()]),
                2,
            )
            .unwrap();
        assert_eq!(second.step_index, 2);
        runtime.finish(&second, &Default::default()).unwrap();
        assert!(runtime
            .start(&a, &c, &r, "account", "model", &HashSet::new(), 3)
            .is_err());
    }
    #[test]
    fn cancellation_failure_and_sequence() {
        let runtime = AgentRuntime::default();
        let (a, c, r) = ids();
        let step = runtime
            .start(&a, &c, &r, "acc", "model", &HashSet::new(), 1)
            .unwrap();
        assert_eq!(step.meta(AgentPhase::Thinking).sequence, 1);
        assert_eq!(step.clone().meta(AgentPhase::Thinking).sequence, 2);
        runtime
            .finish(
                &step,
                &ai_provider::ProviderResponse {
                    cancelled: true,
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(runtime
            .start(&a, &c, &r, "acc", "model", &HashSet::new(), 1)
            .is_err());
        let (a, c, r) = ids();
        let step = runtime
            .start(&a, &c, &r, "acc", "model", &HashSet::new(), 1)
            .unwrap();
        runtime.fail(&step);
        assert_eq!(runtime.snapshot(&a).unwrap().phase, AgentPhase::Failed);
    }
    #[test]
    fn restored_steps_keep_limit_and_legacy_fences_suspend() {
        let runtime = AgentRuntime::default();
        let (a, c, r) = ids();
        assert!(runtime
            .start(&a, &c, &r, "a", "m", &HashSet::new(), 33)
            .is_err());
        let step = runtime
            .start(&a, &c, &r, "a", "m", &HashSet::new(), 32)
            .unwrap();
        runtime
            .finish(
                &step,
                &ai_provider::ProviderResponse {
                    content: "```pandaterm-edit\n{}\n```".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(runtime
            .start(&a, &c, &r, "a", "m", &HashSet::new(), 33)
            .is_err());
    }
}
