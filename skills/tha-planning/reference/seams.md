# Choosing the test seam

The seam is the line between "runs for real" and "substituted". Get it in the right
place and the tests describe behaviour; get it wrong and they describe implementation.

## The rule

**Entry point:** the outermost thing you can call *in process* that a real caller would
reach — the HTTP route (through routing, binding, filters, middleware), the CLI command,
the MCP tool handler, the queue consumer, the public pipeline function.

**Substitute only what leaves the process:**

| Boundary | Substitute with | Why |
|---|---|---|
| Database / ORM | in-memory store or fake repository implementing the real interface | speed, isolation, no schema setup |
| Outbound HTTP / SDK | stub client returning canned responses, and failures on demand | no network, no rate limits, failure paths become testable |
| Clock, `now()`, uuid, random | fixed/seeded values injected | assertions on timestamps and ids stay stable |
| Filesystem | temp directory per test | no cross-test bleed |
| Queue, mail, webhook | recording fake you can assert against | the emission is the observable output |
| Auth provider | pre-built principal / test token | the route's authorization still runs |

**Everything else runs for real:** routing, serialization, model binding, validation,
middleware, handlers, domain rules, mapping. That is where most bugs live.

**Assert only observables:** status code, response body, headers, error shape, what the
fake recorded, what a subsequent read through the same entry point returns.

## Anti-patterns

- Asserting a mock was called N times — that is a test of the implementation, and it
  will break on every harmless refactor. The exception: when the *only* observable
  effect is at the substituted boundary (an email sent, a webhook posted), assert on the
  recorded payload, not the call count.
- Mocking the thing under test's direct collaborator instead of the process boundary.
  Mocking the handler out of a controller test leaves you testing the framework.
- Pointing a "unit" test at a real localhost database, container, or staging service.
  It is now a slow, flaky, order-dependent test.
- Reaching into private state to assert. If it isn't visible at the seam, either the
  feature has no observable effect or the seam is too deep.

## Recipes

### ASP.NET Core

`WebApplicationFactory<Program>` boots the real pipeline; override only the outer
services.

```csharp
var app = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
    b.ConfigureServices(s => {
        s.RemoveAll<IBookmarkRepository>();
        s.AddSingleton<IBookmarkRepository, InMemoryBookmarkRepository>();
        s.AddSingleton<IClock>(new FixedClock("2026-01-01T00:00:00Z"));
    }));

var res = await app.CreateClient().PostAsJsonAsync("/bookmarks", new { url = "https://x.dev" });
res.StatusCode.Should().Be(HttpStatusCode.Created);
```

EF Core's in-memory provider is an acceptable substitute, but it does not enforce
relational constraints — a uniqueness or cascade rule must be asserted against a real
provider (SQLite in-memory) or covered by a separate migration test.

### FastAPI

`TestClient` plus `app.dependency_overrides` — real routing, real Pydantic validation.

```python
app.dependency_overrides[get_repo] = lambda: InMemoryRepo()
client = TestClient(app)
r = client.post("/bookmarks", json={"url": "https://x.dev"})
assert r.status_code == 201
```

For a step-and-artifact pipeline (functions taking a `job_dir`), the entry point is the
route or the orchestrator; substitute the downloader/model calls with
`monkeypatch.setattr` and give each test a `tmp_path` job directory.

### Express / Node

`supertest(app)` against the real app instance with the outer adapters injected:

```ts
const app = createApp({ repo: new InMemoryRepo(), clock: fixedClock });
await request(app).post("/bookmarks").send({ url: "https://x.dev" }).expect(201);
```

Use `undici` interceptors or `nock` for outbound HTTP — not a hand-mocked `fetch` inside
the module under test.

### MCP server (stdio)

The tool handler is the entry point. Call it the way the transport would — name plus
argument object — and assert the returned content and `isError`. Substitute the upstream
client. If the server has a request-ordering invariant (a mutex, a cache), the
out-of-order and repeated-call cases belong in the catalogue.

### CLI

Invoke the command function with parsed args, capturing stdout/stderr and the exit code;
give it a temp working directory. Assert on output text, exit code, and files written.

### Library / pure module

The public API *is* the entry point. Substitution is usually limited to the clock and
randomness. Resist testing private helpers — if one is complex enough to need its own
tests, it probably wants to be public API with its own catalogue section.

## In an unfamiliar stack

Ask three questions:

1. **What does a real caller touch first?** That is the entry point.
2. **What in this process talks to something outside it?** Those are the only
   substitutions.
3. **How does the repo already do this?** An existing fixture or factory beats a new
   harness. Name it in the plan's Harness line and reuse it.

If the codebase offers no seam — no dependency injection, adapters constructed inline —
say so in the plan's Risks section and make "introduce the seam" the first task, rather
than quietly widening the tests to reach real infrastructure.
