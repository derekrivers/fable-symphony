/** §17.5 linear_graphql extension contract + §17.7 CLI argument handling */
import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli.js";
import { countOperations, executeLinearGraphql } from "../src/mcp/linearGraphql.js";
import { makeStore, VALID_TRACKER_YAML } from "./helpers.js";

describe("linear_graphql tool (§10.5)", () => {
  const store = makeStore(VALID_TRACKER_YAML);

  it("rejects empty/invalid query and non-object variables as invalid input", async () => {
    expect(await executeLinearGraphql(store, {})).toMatchObject({
      success: false,
      error: { code: "invalid_input" },
    });
    expect(await executeLinearGraphql(store, { query: "  " })).toMatchObject({ success: false });
    expect(await executeLinearGraphql(store, { query: "{ viewer { id } }", variables: [1] })).toMatchObject({
      success: false,
      error: { code: "invalid_input" },
    });
  });

  it("rejects multi-operation documents", async () => {
    const multi = "query A { viewer { id } }\nquery B { viewer { name } }";
    expect(await executeLinearGraphql(store, { query: multi })).toMatchObject({
      success: false,
      error: { code: "invalid_input" },
    });
    expect(countOperations("mutation M { x }")).toBe(1);
    expect(countOperations("{ viewer { id } }")).toBe(1);
    expect(countOperations('query Q { f(arg: "query mutation") }')).toBe(1); // strings don't count
  });

  it("accepts a raw query string as shorthand and executes with configured auth", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: { viewer: { id: "u1" } } }), { status: 200 }),
    );
    const result = await executeLinearGraphql(store, "{ viewer { id } }", fetchMock as unknown as typeof fetch);
    expect(result).toMatchObject({ success: true, response: { data: { viewer: { id: "u1" } } } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.linear.app/graphql");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "test-key" });
  });

  it("top-level GraphQL errors -> success=false but the body is preserved", async () => {
    const body = { data: null, errors: [{ message: "denied" }] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const result = await executeLinearGraphql(
      store,
      { query: "{ viewer { id } }" },
      fetchMock as unknown as typeof fetch,
    );
    expect(result.success).toBe(false);
    expect(result).toMatchObject({ error: { code: "graphql_errors" }, response: body });
  });

  it("missing auth and transport failures return structured failure payloads", async () => {
    const noAuth = makeStore("tracker:\n  kind: linear\n  project_slug: p");
    expect(await executeLinearGraphql(noAuth, { query: "{ viewer { id } }" })).toMatchObject({
      success: false,
      error: { code: "missing_auth" },
    });

    const failing = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    expect(
      await executeLinearGraphql(store, { query: "{ viewer { id } }" }, failing as unknown as typeof fetch),
    ).toMatchObject({ success: false, error: { code: "transport_failure" } });
  });
});

describe("CLI args (§17.7)", () => {
  it("defaults to ./WORKFLOW.md and accepts a positional path", () => {
    expect(parseArgs([]).workflowPath).toBe("./WORKFLOW.md");
    expect(parseArgs(["custom/WF.md"]).workflowPath).toBe("custom/WF.md");
  });

  it("parses --port and rejects bad values/unknown flags", () => {
    expect(parseArgs(["--port", "8080"]).port).toBe(8080);
    expect(() => parseArgs(["--port", "nope"])).toThrow();
    expect(() => parseArgs(["--bogus"])).toThrow();
    expect(() => parseArgs(["a.md", "b.md"])).toThrow();
  });

  it("recognizes the mcp-linear subcommand", () => {
    const args = parseArgs(["mcp-linear", "wf.md"]);
    expect(args.command).toBe("mcp-linear");
    expect(args.workflowPath).toBe("wf.md");
  });
});
