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
