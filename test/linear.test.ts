/** §17.3 Issue Tracker Client */
import { describe, expect, it, vi } from "vitest";
import { issueRoutable, LinearClient, normalizeIssue } from "../src/linear.js";
import { makeIssue, makeSettings } from "./helpers.js";

const settings = () =>
  makeSettings({ tracker: { kind: "linear", api_key: "key-1", project_slug: "proj-1" } });

function gqlResponse(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return new Response(
    JSON.stringify({ data: { issues: { pageInfo: { hasNextPage, endCursor }, nodes } } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function rawNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "id-1",
    identifier: "MT-1",
    title: "T",
    description: null,
    priority: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    url: "https://linear.app/x/issue/MT-1",
    branchName: "mt-1-branch",
    state: { name: "Todo" },
    labels: { nodes: [{ name: " Agent " }, { name: "BUG" }] },
    inverseRelations: {
      nodes: [
        { type: "blocks", issue: { id: "id-9", identifier: "MT-9", state: { name: "Done" } } },
        { type: "related", issue: { id: "id-8", identifier: "MT-8", state: { name: "Todo" } } },
      ],
    },
    ...overrides,
  };
}

describe("normalization (§11.3)", () => {
  it("lowercases/trims labels, derives blockers from inverse 'blocks' relations only", () => {
    const issue = normalizeIssue(rawNode());
    expect(issue.labels).toEqual(["agent", "bug"]);
    expect(issue.blocked_by).toEqual([{ id: "id-9", identifier: "MT-9", state: "Done" }]);
    expect(issue.branch_name).toBe("mt-1-branch");
    expect(issue.created_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("non-integer priority becomes null", () => {
    expect(normalizeIssue(rawNode({ priority: 2.5 })).priority).toBeNull();
    expect(normalizeIssue(rawNode({ priority: "high" })).priority).toBeNull();
    expect(normalizeIssue(rawNode({ priority: 1 })).priority).toBe(1);
  });
});

describe("query semantics (§11.2)", () => {
  it("candidate query filters project via slugId and uses active states", async () => {
    const fetchMock = vi.fn(async () => gqlResponse([rawNode()]));
    const client = new LinearClient(settings, fetchMock as unknown as typeof fetch);
    await client.fetchCandidateIssues();
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.query).toContain("slugId: { eq: $projectSlug }");
    expect(body.variables.projectSlug).toBe("proj-1");
    expect(body.variables.states).toEqual(["Todo", "In Progress"]);
  });

  it("state refresh query uses [ID!] typing", async () => {
    const fetchMock = vi.fn(async () => gqlResponse([rawNode()]));
    const client = new LinearClient(settings, fetchMock as unknown as typeof fetch);
    await client.fetchIssueStatesByIds(["id-1"]);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.query).toContain("$ids: [ID!]");
  });

  it("empty fetchIssuesByStates([]) returns empty without an API call", async () => {
    const fetchMock = vi.fn();
    const client = new LinearClient(settings, fetchMock as unknown as typeof fetch);
    expect(await client.fetchIssuesByStates([])).toEqual([]);
    expect(await client.fetchIssueStatesByIds([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pagination preserves order across pages and follows endCursor", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(gqlResponse([rawNode({ identifier: "MT-1", id: "a" })], true, "cur-1"))
      .mockResolvedValueOnce(gqlResponse([rawNode({ identifier: "MT-2", id: "b" })], false, null));
    const client = new LinearClient(settings, fetchMock as unknown as typeof fetch);
    const issues = await client.fetchCandidateIssues();
    expect(issues.map((i) => i.identifier)).toEqual(["MT-1", "MT-2"]);
    const secondBody = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(secondBody.variables.after).toBe("cur-1");
  });

  it("hasNextPage without endCursor is a pagination integrity error", async () => {
    const fetchMock = vi.fn(async () => gqlResponse([rawNode()], true, null));
    const client = new LinearClient(settings, fetchMock as unknown as typeof fetch);
    await expect(client.fetchCandidateIssues()).rejects.toMatchObject({ code: "linear_missing_end_cursor" });
  });
});

describe("error mapping (§11.4)", () => {
  it("non-200 -> linear_api_status", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));
    const client = new LinearClient(settings, fetchMock as unknown as typeof fetch);
    await expect(client.fetchCandidateIssues()).rejects.toMatchObject({ code: "linear_api_status" });
  });

  it("GraphQL errors -> linear_graphql_errors", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ errors: [{ message: "bad" }] }), { status: 200 }),
    );
    const client = new LinearClient(settings, fetchMock as unknown as typeof fetch);
    await expect(client.fetchCandidateIssues()).rejects.toMatchObject({ code: "linear_graphql_errors" });
  });

  it("transport failure -> linear_api_request; malformed payload -> linear_unknown_payload", async () => {
    const failing = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const client = new LinearClient(settings, failing as unknown as typeof fetch);
    await expect(client.fetchCandidateIssues()).rejects.toMatchObject({ code: "linear_api_request" });

    const weird = vi.fn(async () => new Response(JSON.stringify({ data: { nope: true } }), { status: 200 }));
    const client2 = new LinearClient(settings, weird as unknown as typeof fetch);
    await expect(client2.fetchCandidateIssues()).rejects.toMatchObject({ code: "linear_unknown_payload" });
  });
});

describe("label routing (§8.2, §5.3.1)", () => {
  it("requires every configured label; blank configured label matches nothing", () => {
    const issue = makeIssue({ labels: ["agent", "bug"] });
    expect(issueRoutable(issue, [])).toBe(true);
    expect(issueRoutable(issue, ["Agent "])).toBe(true); // case/whitespace-insensitive match
    expect(issueRoutable(issue, ["agent", "bug"])).toBe(true);
    expect(issueRoutable(issue, ["agent", "missing"])).toBe(false);
    expect(issueRoutable(issue, [""])).toBe(false);
  });
});
