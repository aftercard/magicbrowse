export enum Actors {
  SYSTEM = 'system',
  USER = 'user',
  PLANNER = 'planner',
  NAVIGATOR = 'navigator',
}

export enum EventType {
  /**
   * Type of events that can be subscribed to.
   *
   * For now, only execution events are supported.
   */
  EXECUTION = 'execution',
}

export enum ExecutionState {
  /**
   * States representing different phases in the execution lifecycle.
   *
   * Format: <SCOPE>.<STATUS>
   * Scopes: task, step, act
   * Statuses: start, ok, fail, cancel
   *
   * Examples:
   *     TASK_OK = "task.ok"  // Task completed successfully
   *     STEP_FAIL = "step.fail"  // Step failed
   *     ACT_START = "act.start"  // Action started
   */
  // Task level states
  TASK_START = 'task.start',
  TASK_OK = 'task.ok',
  TASK_FAIL = 'task.fail',
  TASK_PAUSE = 'task.pause',
  TASK_RESUME = 'task.resume',
  TASK_CANCEL = 'task.cancel',

  // Step level states
  STEP_START = 'step.start',
  STEP_OK = 'step.ok',
  STEP_FAIL = 'step.fail',
  STEP_CANCEL = 'step.cancel',

  // Step phase states (added in adapt — visibility for what happens inside a navigator step)
  STEP_OBSERVE_START = 'step.observe.start',
  STEP_OBSERVE_OK = 'step.observe.ok',
  STEP_THINK_START = 'step.think.start',
  STEP_THINK_OK = 'step.think.ok',

  // Action/Tool level states
  ACT_START = 'act.start',
  ACT_OK = 'act.ok',
  ACT_FAIL = 'act.fail',
}

export type ExecutionEventKind =
  | 'planner.continue'
  | 'planner.completed'
  | 'planner.blocked'
  | 'planner.needs_handoff'
  | 'planner.needs_approval'
  | 'navigator.done'
  | 'system.final_answer'
  | 'system.blocked'
  | 'system.needs_handoff'
  | 'system.needs_approval';

export type ExecutionBlockedReason =
  | 'missing_input'
  | 'item_unavailable'
  | 'ambiguous'
  | 'no_path';

export type ExecutionHandoff =
  | {
      readonly kind: 'protected_form';
      readonly resumeObjective: string;
    }
  | {
      readonly kind: 'captcha';
    }
  | {
      readonly kind: 'auth';
    }
  | {
      readonly kind: 'identity_verification';
    };

export interface EventData {
  /** Data associated with an event */
  taskId: string;
  /** step is the step number of the task where the event occurred */
  step: number;
  /** max_steps is the maximum number of steps in the task */
  maxSteps: number;
  /** details is the content of the event */
  details: string;
  /** Adapter metadata for typed event projection; not used as execution authority. */
  kind?: ExecutionEventKind;
  /** Structured handoff payload for typed terminal projections. */
  handoff?: ExecutionHandoff;
  /** Structured blocked reason for typed terminal projections. */
  blockedReason?: ExecutionBlockedReason;
  /** Adapter metadata for action events. */
  actionName?: string;
}

export class AgentEvent {
  /**
   * Represents a state change event in the task execution system.
   * Each event has a type, a specific state that changed,
   * the actor that triggered the change, and associated data.
   */
  constructor(
    public actor: Actors,
    public state: ExecutionState,
    public data: EventData,
    public timestamp: number = Date.now(),
    public type: EventType = EventType.EXECUTION,
  ) {}
}

// The type of callback for event subscribers
export type EventCallback = (event: AgentEvent) => Promise<void>;
