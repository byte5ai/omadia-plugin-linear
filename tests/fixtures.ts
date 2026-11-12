import type {
  CreateIssueInput,
  LinearClient,
  LinearComment,
  LinearIssue,
  LinearIssueDetail,
  LinearLabel,
  LinearTeam,
  LinearUser,
  LinearWorkflowState,
  SearchIssuesInput,
  UpdateIssueInput,
} from '@omadia/integration-linear';

/**
 * A stand-in for the Linear API capability.
 *
 * Hand-written rather than a mocking library: the whole value of this fixture
 * is the `calls` log, which is what lets a test assert the thing the write gate
 * actually promises — that `linear_prepare_write` reaches no mutating method.
 * A library that records calls would record them the same way and add a
 * dependency to a package that has none.
 *
 * The mutating methods are wired to the same in-memory records the reads serve,
 * so a prepare/commit round-trip in a test moves the same issue a real one
 * would.
 */

export const MUTATING_METHODS = ['createIssue', 'updateIssue', 'addComment'] as const;

export interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface MockLinear {
  readonly client: LinearClient;
  readonly calls: RecordedCall[];
  /** Every recorded call to `createIssue`, `updateIssue` or `addComment`. */
  mutations(): readonly RecordedCall[];
  callsTo(method: string): readonly RecordedCall[];
  /** Replace the issue a key resolves to, e.g. to make a field already match. */
  setIssue(issue: LinearIssueDetail): void;
}

export const TEAM_OMA: LinearTeam = { id: 'team-oma', key: 'OMA', name: 'Omadia' };
export const TEAM_WEB: LinearTeam = { id: 'team-web', key: 'WEB', name: 'Website' };

export const STATE_BACKLOG: LinearWorkflowState = {
  id: 'state-backlog',
  name: 'Backlog',
  type: 'backlog',
  position: 0,
  teamId: TEAM_OMA.id,
};
export const STATE_TODO: LinearWorkflowState = {
  id: 'state-todo',
  name: 'Todo',
  type: 'unstarted',
  position: 1,
  teamId: TEAM_OMA.id,
};
export const STATE_IN_PROGRESS: LinearWorkflowState = {
  id: 'state-wip',
  name: 'In Progress',
  type: 'started',
  position: 2,
  teamId: TEAM_OMA.id,
};
export const STATE_DONE: LinearWorkflowState = {
  id: 'state-done',
  name: 'Done',
  type: 'completed',
  position: 3,
  teamId: TEAM_OMA.id,
};
/** Deliberately a substring superset of "Done", so the exact-before-substring
 *  rule in lookup.ts has something to get wrong. */
export const STATE_DONE_DEPLOY: LinearWorkflowState = {
  id: 'state-done-deploy',
  name: 'Done (deployed)',
  type: 'completed',
  position: 4,
  teamId: TEAM_OMA.id,
};

export const VIEWER: LinearUser = {
  id: 'user-viewer',
  name: 'Andre Derjagin',
  displayName: 'andre',
  email: 'andre@example.com',
  active: true,
};
export const USER_KIM_LEE: LinearUser = {
  id: 'user-kim-lee',
  name: 'Kim Lee',
  displayName: 'kimlee',
  email: 'kim.lee@example.com',
  active: true,
};
export const USER_KIM_PARK: LinearUser = {
  id: 'user-kim-park',
  name: 'Kim Park',
  displayName: 'kimpark',
  email: 'kim.park@example.com',
  active: true,
};
export const USER_INACTIVE: LinearUser = {
  id: 'user-old',
  name: 'Robin Gone',
  displayName: 'robin',
  email: undefined,
  active: false,
};

export const LABEL_BUG: LinearLabel = { id: 'label-bug', name: 'bug', teamId: TEAM_OMA.id };
export const LABEL_MOBILE: LinearLabel = {
  id: 'label-mobile',
  name: 'mobile',
  teamId: TEAM_OMA.id,
};
export const LABEL_WORKSPACE: LinearLabel = {
  id: 'label-triage',
  name: 'needs-triage',
  teamId: undefined,
};

export function makeIssue(overrides: Partial<LinearIssueDetail> = {}): LinearIssueDetail {
  return {
    id: 'issue-7',
    identifier: 'OMA-7',
    title: 'Login fails on Safari',
    url: 'https://linear.app/omadia-dev/issue/OMA-7',
    priority: 3,
    priorityLabel: 'Medium',
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-05T09:30:00.000Z',
    state: { id: STATE_TODO.id, name: STATE_TODO.name, type: STATE_TODO.type },
    assignee: { id: VIEWER.id, name: VIEWER.name, displayName: VIEWER.displayName },
    team: TEAM_OMA,
    labels: ['bug'],
    description: 'Safari 17 rejects the session cookie.',
    comments: [],
    ...overrides,
  };
}

export function makeComment(overrides: Partial<LinearComment> = {}): LinearComment {
  return {
    id: 'comment-1',
    body: 'Reproduced on staging.',
    url: 'https://linear.app/omadia-dev/issue/OMA-7#comment-1',
    createdAt: '2026-09-05T10:00:00.000Z',
    author: 'andre',
    ...overrides,
  };
}

export function createMockLinear(
  options: {
    issues?: readonly LinearIssueDetail[];
    teams?: readonly LinearTeam[];
    states?: readonly LinearWorkflowState[];
    users?: readonly LinearUser[];
    labels?: readonly LinearLabel[];
    searchResult?: readonly LinearIssue[];
  } = {},
): MockLinear {
  const calls: RecordedCall[] = [];
  const record = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args });
  };

  const issues = new Map<string, LinearIssueDetail>();
  for (const issue of options.issues ?? [makeIssue()]) {
    issues.set(issue.identifier.toUpperCase(), issue);
    issues.set(issue.id, issue);
  }
  const teams = options.teams ?? [TEAM_OMA, TEAM_WEB];
  const states = options.states ?? [STATE_BACKLOG, STATE_TODO, STATE_IN_PROGRESS, STATE_DONE];
  const users = options.users ?? [VIEWER, USER_KIM_LEE, USER_KIM_PARK, USER_INACTIVE];
  const labels = options.labels ?? [LABEL_BUG, LABEL_MOBILE, LABEL_WORKSPACE];

  const client: LinearClient = {
    async viewer() {
      record('viewer');
      return VIEWER;
    },
    async teams() {
      record('teams');
      return [...teams];
    },
    async workflowStates(teamId) {
      record('workflowStates', teamId);
      return states.filter((s) => s.teamId === teamId);
    },
    async users(query) {
      record('users', query);
      return [...users];
    },
    async labels(teamId) {
      record('labels', teamId);
      return labels.filter((l) => l.teamId === undefined || l.teamId === teamId);
    },
    async searchIssues(input: SearchIssuesInput) {
      record('searchIssues', input);
      return [...(options.searchResult ?? [...issues.values()].slice(0, 1))];
    },
    async getIssue(keyOrId) {
      record('getIssue', keyOrId);
      return issues.get(keyOrId.toUpperCase()) ?? issues.get(keyOrId);
    },
    async createIssue(input: CreateIssueInput) {
      record('createIssue', input);
      const created = makeIssue({
        id: 'issue-31',
        identifier: 'OMA-31',
        title: input.title,
        url: 'https://linear.app/omadia-dev/issue/OMA-31',
        labels: [],
        comments: [],
      });
      issues.set(created.identifier, created);
      return created;
    },
    async updateIssue(id, input: UpdateIssueInput) {
      record('updateIssue', id, input);
      const current = issues.get(id);
      if (!current) throw new Error(`mock: no issue ${id}`);
      const next: LinearIssueDetail = {
        ...current,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.stateId === undefined
          ? {}
          : {
              state: {
                id: input.stateId,
                name: states.find((s) => s.id === input.stateId)?.name ?? 'Unknown',
                type: states.find((s) => s.id === input.stateId)?.type ?? 'unstarted',
              },
            }),
        ...(input.assigneeId === undefined
          ? {}
          : {
              assignee:
                input.assigneeId === null
                  ? undefined
                  : {
                      id: input.assigneeId,
                      name: users.find((u) => u.id === input.assigneeId)?.name ?? '?',
                      displayName:
                        users.find((u) => u.id === input.assigneeId)?.displayName ?? '?',
                    },
            }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.labelIds === undefined
          ? {}
          : {
              labels: input.labelIds.map((id) => labels.find((l) => l.id === id)?.name ?? '?'),
            }),
      };
      issues.set(next.identifier.toUpperCase(), next);
      issues.set(next.id, next);
      return next;
    },
    async addComment(issueId, body) {
      record('addComment', issueId, body);
      return makeComment({ id: 'comment-99', body });
    },
  };

  return {
    client,
    calls,
    mutations: () =>
      calls.filter((c) => (MUTATING_METHODS as readonly string[]).includes(c.method)),
    callsTo: (method) => calls.filter((c) => c.method === method),
    setIssue: (issue) => {
      issues.set(issue.identifier.toUpperCase(), issue);
      issues.set(issue.id, issue);
    },
  };
}

/** Collects `ctx.log` / toolkit-log output so a test can stay silent. */
export function createLog(): { log: (...args: unknown[]) => void; lines: unknown[][] } {
  const lines: unknown[][] = [];
  return { log: (...args: unknown[]) => void lines.push(args), lines };
}
