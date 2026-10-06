"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { createAuthMiddleware } = require("../lib/auth");

function runMiddleware(mw, headers = {}) {
  const req = { headers, path: headers.__path || "/send-text" };
  delete req.headers.__path;
  let statusCode = null;
  let body = null;
  let nextCalled = false;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };
  mw(req, res, () => {
    nextCalled = true;
  });
  return { statusCode, body, nextCalled };
}

describe("createAuthMiddleware", () => {
  test("without an API key configured it lets every request through", () => {
    const mw = createAuthMiddleware({ apiKey: "" });
    assert.equal(runMiddleware(mw).nextCalled, true);
  });

  test("with an API key configured it rejects a request that carries none", () => {
    const mw = createAuthMiddleware({ apiKey: "s3cret" });
    const { statusCode, body, nextCalled } = runMiddleware(mw);
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
    assert.equal(body.error, "unauthorized");
  });

  test("accepts the key in the x-api-key header", () => {
    const mw = createAuthMiddleware({ apiKey: "s3cret" });
    assert.equal(runMiddleware(mw, { "x-api-key": "s3cret" }).nextCalled, true);
  });

  test("accepts the key as an Authorization bearer token", () => {
    const mw = createAuthMiddleware({ apiKey: "s3cret" });
    assert.equal(runMiddleware(mw, { authorization: "Bearer s3cret" }).nextCalled, true);
  });

  test("rejects a wrong key", () => {
    const mw = createAuthMiddleware({ apiKey: "s3cret" });
    const { statusCode, nextCalled } = runMiddleware(mw, { "x-api-key": "wrong" });
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
  });

  test("rejects a key of a different length without leaking the comparison", () => {
    const mw = createAuthMiddleware({ apiKey: "s3cret" });
    assert.equal(runMiddleware(mw, { "x-api-key": "s" }).nextCalled, false);
    assert.equal(runMiddleware(mw, { "x-api-key": "s3cretlonger" }).nextCalled, false);
  });

  test("leaves the health endpoint open so probes work without credentials", () => {
    const mw = createAuthMiddleware({ apiKey: "s3cret", publicPaths: ["/health"] });
    assert.equal(runMiddleware(mw, { __path: "/health" }).nextCalled, true);
    assert.equal(runMiddleware(mw, { __path: "/status" }).nextCalled, false);
  });

  test("reports whether authentication is actually enforced", () => {
    assert.equal(createAuthMiddleware({ apiKey: "" }).enabled, false);
    assert.equal(createAuthMiddleware({ apiKey: "s3cret" }).enabled, true);
  });
});

describe("createAuthMiddleware with principals", () => {
  const agent = { id: "prn_a", name: "agente", scope: "conversations" };
  const principals = {
    authenticate: (key) => (key === "wsk_agent" ? agent : null),
  };

  function run(mw, { headers = {}, path = "/conversations" } = {}) {
    const req = { headers, path };
    const out = { req, statusCode: null, body: null, nextCalled: false };
    const res = {
      status(code) {
        out.statusCode = code;
        return this;
      },
      json(payload) {
        out.body = payload;
        return this;
      },
    };
    mw(req, res, () => {
      out.nextCalled = true;
    });
    return out;
  }

  test("the shared API_KEY identifies as the implicit legacy principal with scope all", () => {
    const mw = createAuthMiddleware({ apiKey: "s3cret", principals });
    const { req, nextCalled } = run(mw, { headers: { "x-api-key": "s3cret" } });
    assert.equal(nextCalled, true);
    assert.deepEqual(req.principal, { id: "legacy", name: "legacy", scope: "all" });
  });

  test("a principal key identifies that principal, in either header", () => {
    const mw = createAuthMiddleware({ apiKey: "s3cret", principals });
    assert.equal(run(mw, { headers: { "x-api-key": "wsk_agent" } }).req.principal, agent);
    assert.equal(run(mw, { headers: { authorization: "Bearer wsk_agent" } }).req.principal, agent);
  });

  test("an unknown key is still 401 with the frozen body", () => {
    const mw = createAuthMiddleware({ apiKey: "s3cret", principals });
    const { statusCode, body, nextCalled } = run(mw, { headers: { "x-api-key": "wsk_other" } });
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
    assert.deepEqual(body, {
      ok: false,
      error: "unauthorized",
      message: "Falta o es inválida la API key (header x-api-key o Authorization: Bearer).",
    });
  });

  test("with API_KEY empty a request without key stays open as legacy", () => {
    const mw = createAuthMiddleware({ apiKey: "", principals });
    const { req, nextCalled } = run(mw);
    assert.equal(nextCalled, true);
    assert.equal(req.principal.scope, "all");
  });

  test("with API_KEY empty a principal key still identifies its principal", () => {
    const mw = createAuthMiddleware({ apiKey: "", principals });
    assert.equal(run(mw, { headers: { "x-api-key": "wsk_agent" } }).req.principal, agent);
  });

  test("public paths pass without identifying anyone", () => {
    const mw = createAuthMiddleware({ apiKey: "s3cret", principals, publicPaths: ["/health"] });
    const { req, nextCalled } = run(mw, { path: "/health" });
    assert.equal(nextCalled, true);
    assert.equal(req.principal, null);
  });
});

describe("requireScope", () => {
  const { requireScope } = require("../lib/auth");

  function run(principal) {
    const out = { statusCode: null, body: null, nextCalled: false };
    const res = {
      status(code) {
        out.statusCode = code;
        return this;
      },
      json(payload) {
        out.body = payload;
        return this;
      },
    };
    requireScope("all")({ principal }, res, () => {
      out.nextCalled = true;
    });
    return out;
  }

  test("lets a principal with the scope through", () => {
    assert.equal(run({ id: "legacy", scope: "all" }).nextCalled, true);
  });

  test("answers 403 forbidden to a principal without it", () => {
    const { statusCode, body, nextCalled } = run({ id: "prn_a", scope: "conversations" });
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 403);
    assert.equal(body.ok, false);
    assert.equal(body.error, "forbidden");
    assert.equal(typeof body.message, "string");
  });

  test("answers 403 when no principal was identified", () => {
    assert.equal(run(undefined).statusCode, 403);
  });
});
