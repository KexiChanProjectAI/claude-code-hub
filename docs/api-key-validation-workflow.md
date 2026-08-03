# API Key Validation Workflow

The `POST /api/v1/keys:validate` endpoint lets an administrator verify whether a
plaintext API key is currently valid in the system without using the key for a
proxy request. It is useful for onboarding checks, billing reconciliation, audit
tools, and support workflows.

This endpoint is **admin-tier**. It only accepts credentials that can call admin
routes, and it intentionally returns the same `404` response for every failure
case so callers cannot distinguish between "key does not exist", "user is
disabled", and "user is expired".

## Authentication

Use any credential that is allowed for admin-tier `/api/v1/*` routes:

- Browser session cookie: `Cookie: auth-token=<session>`
- Admin bearer token: `Authorization: Bearer <ADMIN_TOKEN>`
- User API key (requires `ENABLE_API_KEY_ADMIN_ACCESS=true` and an owner with
  `role=admin`): `X-Api-Key: <key>`

See `api-authentication-guide.md` and `security/api-key-admin-access.md` for
details about admin access tiers and CSRF requirements.

## Request

```http
POST /api/v1/keys:validate
Content-Type: application/json

{
  "key": "sk-..."
}
```

### Request body

| Field | Type   | Required | Description                        |
|-------|--------|----------|------------------------------------|
| key   | string | yes      | The plaintext API key to validate. |

## Validation Rules

The key is considered **valid** only when **all** of the following are true:

1. The key string exists in the database.
2. The key belongs to a user whose `isEnabled` flag is `true`.
3. The key's owner has not expired (`expiresAt` is either `null` or in the
   future).

If any of the above conditions is not met, the endpoint returns `404 Not Found`
with a generic problem response.

## Success Response

`200 OK`

```json
{
  "owner": "alice",
  "name": "production-key"
}
```

| Field | Type   | Description                              |
|-------|--------|------------------------------------------|
| owner | string | User name of the API key owner.          |
| name  | string | Human-readable name assigned to the key. |

## Error Response

### 404 Not Found

Returned for any of the validation failure cases. The response body is a
standard `application/problem+json` envelope:

```json
{
  "type": "urn:claude-code-hub:problem:not_found",
  "title": "Not Found",
  "status": 404,
  "detail": "API key not found or not valid.",
  "instance": "/api/v1/keys:validate",
  "errorCode": "not_found",
  "errorParams": {}
}
```

### 401 Unauthorized

The request did not carry a valid admin credential.

### 403 Forbidden

The caller is authenticated but is not allowed to access admin-tier routes.

### 400 Bad Request

The request body is missing the `key` field or is malformed.

## Example: curl

```bash
# Validate a key using the ADMIN_TOKEN as a Bearer token.
curl -X POST 'https://cch.ts.zenkexi.com/api/v1/keys:validate' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer your-admin-token' \
  -d '{"key":"sk-abc123"}'
```

## Example: Node.js

```javascript
const response = await fetch(
  "https://cch.ts.zenkexi.com/api/v1/keys:validate",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.CCH_ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ key: "sk-abc123" }),
  }
);

if (!response.ok) {
  const problem = await response.json();
  throw new Error(`${problem.errorCode}: ${problem.detail}`);
}

const { owner, name } = await response.json();
console.log(`Key belongs to ${owner} (${name})`);
```

## Use Cases

- **Pre-flight check**: Confirm a key exists before allowing it to be used in a
  third-party integration.
- **Billing reconciliation**: Map a reported key string back to its owner and
  key name for invoice line items.
- **Audit and support**: Determine whether a key that is failing proxy requests
  has been disabled, expired, or never existed.
- **Key rotation helpers**: Verify that an old key has been revoked (returning
  `404`) before deleting local records.

## Security Notes

- The endpoint accepts the plaintext key in the request body. Always send it
  over HTTPS and avoid logging the value.
- Do not expose this endpoint to non-admin callers. It allows enumeration of
  valid keys by testing arbitrary strings, so the generic `404` response is
  intentional to limit information leakage.
- Combine the validation response with usage limits and quota checks when
  authorizing a third-party tool.

## Related Resources

- OpenAPI JSON: `/api/v1/openapi.json`
- Scalar UI: `/api/v1/scalar`
- Swagger UI: `/api/v1/docs`
- API Authentication Guide: `api-authentication-guide.md`
- API Key Admin Access: `security/api-key-admin-access.md`
