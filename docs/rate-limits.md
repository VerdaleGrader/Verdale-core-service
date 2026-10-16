# Rate limits (GRD-55)

Core limits how often an address and a person may call it, so a flood (or a
loop in somebody's script) cannot use up Judge or the API. Over a limit Core
answers **429** in the usual error shape, with the time to wait in the message
and in a `Retry-After` header:

```json
{
  "status": 429,
  "error_code": "RATE_LIMITED",
  "message": "Too many requests. Try again in 23 seconds.",
  "request_id": "…"
}
```

## The limits

All are per minute, all set in the environment (`.env.example`), and Core
refuses to start on a value that is not a whole number from 1 to 100000.

| Limit               | Variable                           | Default | Counted by       | Applies to                                                    |
| ------------------- | ---------------------------------- | ------: | ---------------- | ------------------------------------------------------------- |
| API, address        | `RATE_LIMIT_API_PER_IP`            |     300 | address          | every request under the API (not `/health` or `/ready`)       |
| API, person         | `RATE_LIMIT_API_PER_USER`          |     600 | signed-in person | every request that carries a valid session                    |
| Sign-in             | `RATE_LIMIT_SIGN_IN_PER_IP`        |      20 | address          | starting and finishing an OAuth sign-in (one budget for both) |
| Submitting, person  | `RATE_LIMIT_SUBMIT_PER_USER`       |      10 | person           | `POST …/submissions` and re-checks (`…/rejudge`)              |
| Submitting, address | `RATE_LIMIT_SUBMIT_PER_IP`         |      30 | address          | the same, for accounts behind one address                     |
| Waiting submissions | `MAX_PENDING_SUBMISSIONS_PER_USER` |      10 | person           | submissions that are `queued` or `running`; not per minute    |

Also, as before: profile changes (10 a minute, per person) and starting AI
testcase drafts (`AI_TEST_LIMITS.starts_per_minute`) have their own budgets.

A submission refused for the waiting-queue cap is `429 TOO_MANY_PENDING_SUBMISSIONS`
with `Retry-After: 10`: it clears when Judge finishes one of the person's
earlier submissions. Only the person's own queue counts, so one person cannot
take the queue from the rest.

Which budget answers first: the address budget (every request), then the
person's budget, then the route's own (sign-in, submitting).

## Where the counters live, and what that means

In the memory of the Core process (decision in `docs/decisions.md`). Core is one
instance. A restart or a deploy gives everybody a fresh budget, and a second
instance would double every limit; before running a second instance, give the
plugin a shared store (`@fastify/rate-limit` accepts a Redis client) or move
the counters to Postgres. The cap on waiting submissions is a database count, so
it is already exact.

## Which address

Counting by address is only as good as the address. `TRUST_PROXY=true` makes
Fastify read `X-Forwarded-For`, whose leftmost value is written by the client:
send a different one with every request and the address budget never fills. Where
the proxy sets a header of its own that a client cannot write (Cloudflare:
`cf-connecting-ip`), name it in `CLIENT_IP_HEADER`; Core then counts by it, and
falls back to the connection address when the header is missing or is not an
address. Set it only when nothing but that proxy can reach Core, or the header
can be forged just as well.

## Checking it

`src/services/rate-limit/rate-limit.test.ts` covers each limit: the Nth request
passes and the next is 429 with `Retry-After`, another address or person is not
affected, and the counter starts again when the window ends (the tests shorten
the window to one second).
