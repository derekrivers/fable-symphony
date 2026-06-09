/**
 * Linear tracker client (spec-claude.md §11).
 *
 * Three adapter operations: fetch_candidate_issues, fetch_issues_by_states,
 * fetch_issue_states_by_ids. Query construction is kept isolated here because
 * Linear's GraphQL schema can drift (§11.2).
 */
import { SymphonyError, type BlockerRef, type Issue, type Settings } from "./types.js";

const PAGE_SIZE = 50;
const NETWORK_TIMEOUT_MS = 30000;

export interface TrackerClient {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>;
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  createdAt
  updatedAt
  url
  branchName
  state { name }
  labels { nodes { name } }
  inverseRelations { nodes { type issue { id identifier state { name } } } }
`;

const CANDIDATES_QUERY = `
query Candidates($projectSlug: String!, $states: [String!]!, $after: String) {
  issues(
    first: ${PAGE_SIZE}
    after: $after
    filter: {
      project: { slugId: { eq: $projectSlug } }
      state: { name: { in: $states } }
    }
  ) {
    pageInfo { hasNextPage endCursor }
    nodes { ${ISSUE_FIELDS} }
  }
}`;

const STATES_BY_IDS_QUERY = `
query StatesByIds($ids: [ID!]) {
  issues(first: ${PAGE_SIZE}, filter: { id: { in: $ids } }) {
    pageInfo { hasNextPage endCursor }
    nodes { ${ISSUE_FIELDS} }
  }
}`;

type SettingsProvider = () => Settings;

export class LinearClient implements TrackerClient {
  constructor(
    private readonly settings: SettingsProvider,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchCandidateIssues(): Promise<Issue[]> {
    const s = this.settings();
    return this.fetchIssuesByStates(s.tracker.active_states);
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) return [];
    const s = this.settings();
    const issues: Issue[] = [];
    let after: string | null = null;
    for (;;) {
      const data = await this.request(CANDIDATES_QUERY, {
        projectSlug: s.tracker.project_slug,
        states: stateNames,
        after,
      });
      const page = extractIssuesPage(data);
      issues.push(...page.nodes.map(normalizeIssue));
      if (!page.hasNextPage) break;
      if (!page.endCursor) {
        throw new SymphonyError("linear_missing_end_cursor", "hasNextPage=true but endCursor missing");
      }
      after = page.endCursor;
    }
    return issues;
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) return [];
    const data = await this.request(STATES_BY_IDS_QUERY, { ids: issueIds });
    const page = extractIssuesPage(data);
    return page.nodes.map(normalizeIssue);
  }

  private async request(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const s = this.settings();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(s.tracker.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: s.tracker.api_key ?? "",
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new SymphonyError("linear_api_request", `transport failure: ${(err as Error).message}`, err);
    } finally {
      clearTimeout(timer);
    }

    if (res.status !== 200) {
      const body = await res.text().catch(() => "");
      throw new SymphonyError("linear_api_status", `linear returned HTTP ${res.status}`, body.slice(0, 2000));
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch (err) {
      throw new SymphonyError("linear_unknown_payload", "response body is not JSON", err);
    }

    const map = payload as { data?: unknown; errors?: unknown[] };
    if (Array.isArray(map.errors) && map.errors.length > 0) {
      throw new SymphonyError("linear_graphql_errors", "linear returned GraphQL errors", map.errors);
    }
    if (map.data === undefined || map.data === null) {
      throw new SymphonyError("linear_unknown_payload", "response has no data field", payload);
    }
    return map.data;
  }
}

interface IssuesPage {
  nodes: Record<string, unknown>[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function extractIssuesPage(data: unknown): IssuesPage {
  const issues = (data as { issues?: unknown })?.issues as
    | { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: unknown }
    | undefined;
  if (!issues || !Array.isArray(issues.nodes)) {
    throw new SymphonyError("linear_unknown_payload", "missing issues.nodes in response", data);
  }
  return {
    nodes: issues.nodes as Record<string, unknown>[],
    hasNextPage: issues.pageInfo?.hasNextPage === true,
    endCursor: issues.pageInfo?.endCursor ?? null,
  };
}

/** Normalization rules (spec §11.3, §4.1.1). Exported for tests. */
export function normalizeIssue(node: Record<string, unknown>): Issue {
  const labelsNodes = ((node["labels"] as { nodes?: unknown })?.nodes ?? []) as { name?: unknown }[];
  const labels = labelsNodes
    .map((l) => (typeof l?.name === "string" ? l.name.trim().toLowerCase() : null))
    .filter((l): l is string => l !== null && l.length > 0);

  const relations = ((node["inverseRelations"] as { nodes?: unknown })?.nodes ?? []) as {
    type?: unknown;
    issue?: { id?: unknown; identifier?: unknown; state?: { name?: unknown } } | null;
  }[];
  const blocked_by: BlockerRef[] = relations
    .filter((r) => r?.type === "blocks")
    .map((r) => ({
      id: typeof r.issue?.id === "string" ? r.issue.id : null,
      identifier: typeof r.issue?.identifier === "string" ? r.issue.identifier : null,
      state: typeof r.issue?.state?.name === "string" ? r.issue.state.name : null,
    }));

  const priorityRaw = node["priority"];
  const priority = typeof priorityRaw === "number" && Number.isInteger(priorityRaw) ? priorityRaw : null;

  return {
    id: typeof node["id"] === "string" ? node["id"] : "",
    identifier: typeof node["identifier"] === "string" ? node["identifier"] : "",
    title: typeof node["title"] === "string" ? node["title"] : "",
    description: typeof node["description"] === "string" ? node["description"] : null,
    priority,
    state: typeof (node["state"] as { name?: unknown })?.name === "string" ? ((node["state"] as { name: string }).name) : "",
    branch_name: typeof node["branchName"] === "string" ? node["branchName"] : null,
    url: typeof node["url"] === "string" ? node["url"] : null,
    labels,
    blocked_by,
    created_at: parseIso(node["createdAt"]),
    updated_at: parseIso(node["updatedAt"]),
  };
}

function parseIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Label routing rule (spec §8.2): issue must contain every required label. */
export function issueRoutable(issue: Issue, requiredLabels: string[]): boolean {
  return requiredLabels.every((raw) => {
    const wanted = raw.trim().toLowerCase();
    if (wanted === "") return false; // a blank configured label matches no issue (§5.3.1)
    return issue.labels.includes(wanted);
  });
}
