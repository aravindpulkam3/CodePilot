import { test } from "node:test";
import assert from "node:assert/strict";
import { isUuid, positiveInteger, isValidMessage, MAX_MESSAGE_LENGTH, parseGitHubRepositoryUrl } from "./inputValidation.js";

test("UUID inputs reject malformed IDs and non-string query values", () => {
  assert.equal(isUuid("9aa68757-5505-4e6e-82bf-5a889d993bc3"), true);
  for (const value of ["new", "bad-id", "", null, 123, ["9aa68757-5505-4e6e-82bf-5a889d993bc3"], {}]) {
    assert.equal(isUuid(value), false);
  }
});

test("PR numbers require a complete positive safe integer", () => {
  assert.equal(positiveInteger("12"), 12);
  assert.equal(positiveInteger(12), 12);
  for (const value of ["12junk", 0, -3, 1.5, NaN, Infinity, "-3", "1.5", "", " ", true, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(positiveInteger(value), null);
  }
});

test("messages and answers must be nonblank bounded strings", () => {
  for (const value of [123, {}, [], null, undefined, "", " \n\t ", "a".repeat(MAX_MESSAGE_LENGTH + 1)]) {
    assert.equal(isValidMessage(value), false);
  }
  assert.equal(isValidMessage("  Explain this code  "), true);
  assert.equal(isValidMessage("a".repeat(MAX_MESSAGE_LENGTH)), true);
});

test("GitHub URL parsing preserves dotted names and removes only the git suffix", () => {
  for (const suffix of ["", "/", ".git", ".git/"]) {
    assert.deepEqual(parseGitHubRepositoryUrl("https://github.com/owner/example.js" + suffix), { owner: "owner", repoName: "example.js" });
  }
  for (const value of [123, null, "github.com/owner/repo", "https://notgithub.com/owner/repo", "https://github.com.evil.test/owner/repo", "https://github.com/owner", "https://github.com/owner/repo/tree/main", "https://github.com/owner/%2Frepo", "https://user:pass@github.com/owner/repo", "https://github.com/owner/" + "a".repeat(2048)]) {
    assert.equal(parseGitHubRepositoryUrl(value), null);
  }
});
