# Commercial Task Fidelity, frozen native Stage 0

Canonical baseline: `d74329d7c027c2cf1a924788ff57fcd3370ac6a9`.
Branch: `codex/commercial-task-fidelity-stage0-v1`, created independently of
the unmerged Demand Radar PR #50. The experiment does not adopt or replay
its Scout sample as current source evidence.

## Question and frozen protocol

Can the actual configured Gemini through native Hermes/CLIProxyAPI preserve
a participant's own commercial task, conditional restrictions, speaker
ownership and later cancellation? Does one general instruction addition help,
without substituting a FitLine pitch, adding implicit permission or hiding
all findings behind an empty answer?

Four freshly researcher-authored conversations and a separately authored
oracle were reviewed before any model completion. They are synthetic test
cases, not market observations or proof of provider novelty. The first two
require a nonempty task finding. The third tests quoted-customer vs vendor
vs independent studio workflow needs. The fourth tests a historical task
explicitly cancelled by the same author in a different thread; the review
must retain history without claiming a current reason to act.

Case two deliberately retains the author's different initial and later option
lists. A model must preserve both rather than invent how they were reconciled.
No case supplies verified offer terms: fit remains UNKNOWN; contact false.

LF-normalized SHA-256 frozen before completions:

| Artifact | Hash |
| --- | --- |
| Cases | `9eaa9bf5b2a3e0feadbee9bd8060762ccfd67c3ecb11905765d583bad2d34966` |
| Independent gold | `57ea038df47ed9a5ce92430c0db9ca9860b6cb725807581b52bda4750f3b67f7` |
| A: canonical Audience prompt | `4edf1a5ddf4058bf3f9c713990edb0b913efa214f90cba0d628487e5a77e99fe` |
| B: canonical plus one general brief | `e6aa06842f7a2b69883f47b325d0ac2149a56ce60f59e878e9587f636ca8a90b` |
| Manifest | `9bb3ea815d779fd69232f36a1c6c2b4db02dff34a5e6ecd90e0498b2c4ab7953` |

The manifest also freezes the actual production Audience prompt/schema,
reasoning code, Hermes adapter and worker. It does not attest upstream model
weights or untracked provider configuration. Both arms explicitly bind their
actual instructions to the prepared run before dispatch. This experimental
mutation leaves the source packet, one-attempt grant, model config and domain
state machine unchanged. The model sees neither gold nor researcher case
objectives. Owner goal is the same neutral task-discovery brief in all cells.

Independent pre-call red-team caught a comparison confound: the initial title
exposed the arm, and the native domain regenerates UUIDs and capture clocks.
The title now depends only on the case, with a separately checked controlled
source/task hash before B dispatch. We do not rewrite event clocks, immutable
source facts or authority history to make a prettier comparison. Complete
inputs still differ by domain IDs/clocks. The experiment is explicitly
`UNPAIRED_NATIVE_FIDELITY_OBSERVATIONS`, `causal_comparison: false`; individual
gold fidelity judgments remain valid, but an A/B causal-performance claim
or automatic B adoption would be invalid. The fixture's declared observation
time and actual runtime capture time are reported separately. This resolves
the reporting blocker by limiting the conclusion, not fabricating input parity.

## Reuse and boundaries

Reuse the existing source ingestion, Audience reply projection, continuity
freshness checks, explicit attention grant, Control Plane admission, JSON
schema, Hermes adapter and owner's configured CLIProxyAPI. Reuse the existing
conformance driver's exclusive lock/write-ahead reservation/atomic summary
pattern. New experiment code freezes inputs and collects truthful native
receipts plus separately reviewed semantics; it is not generic infrastructure
or a new semantic classifier. Production code, prompt, defaults and schema
are unchanged. Runtime/scheduler/Telegram/workspace/send remain disabled.

One isolated SQLite store per cell. Original source publication clocks remain
historical. Source evidence can be freshly admitted in this synthetic test
without proving the described task still active today. No owner review of a
need, transfer, person, conversation, draft, action or send is created.

Eight logical dispatch reservations maximum, one cell at a time. Reservation
is fsynced before adapter entry. All runs end with explicit grant revocation.
Unknown completion, runtime/contract/safety failure, B semantic FAIL or unknown
review stops future work. A semantic failure remains a legitimate comparator.
Every checklist is bound to the exact output and frozen gold. Fabricated
all-PASS empty positive controls, missing checklist rows or altered reports
are rejected. A correct-looking checklist still requires an honest independent
reviewer; the script cannot automatically prove its semantic judgment.

An abrupt crash preserves a reserved cell and possibly its process lock.
Manual dead-process inspection can release only the lock, not reset history
or retry the consumed cell. Automatic lock recovery is intentionally absent
from this finite experiment. Adapter exceptions caught by the production
Audience layer become a blocked cell with unknown wire/completion details;
they are never considered success or unused budget.

Hermes forces two decision iterations. No exact upstream-request bound is
claimed: credential/proxy failover may be invisible. Requested model and
reported served identity are separately recorded; missing/different reported
identities make comparison inconclusive. Equal reported identities are not
an upstream attestation. Missing tokens/cost stay unknown, never zero.

## Verification before real calls

Fourteen focused offline tests PASS. Freeze tests catch altered input and
production bytes, quote/speaker mismatch even after rehashing, non-synthetic
sources, future publication, replaced canonical prompt, malformed allowlists,
nonlocal reply IDs and wrong gold sets. CLI tests use the real source/domain
pipeline with a fake adapter at the existing injection seam: preserved source
IDs/authors/dates/text; actual A/B prompt hashes in receipts; revoked one-turn
grant; zero effect artifacts; review gate; empty positive control refusal;
missing/contradictory checklist; altered output/gold/report; reserved/corrupted
history; crash restart; concurrent lock; changed model; tool-call rejection.

These checks prove the experiment's control/fidelity plumbing. They do not
prove Gemini understands the conversations. Native call results, full gate,
reviewer judgments and any stop condition are recorded after execution.

## Actual native outcome: BLOCKED — RUNTIME

Frozen pre-call commit: `994f806eaf9b8e51eb558db3ebe338f1063c6566`.
No case/gold/prompt/manifest byte was changed after the first dispatch.

| Operation | Logical dispatches | Requested alias | Native failure | Valid completion |
| --- | --- | --- | --- | --- |
| Frozen Stage0, cell 1A | 1 of cap 8 | gemini-3.7-flash-high | provider_error, HTTP 404 | 0 |
| Separate operational prerequisite smoke | 1 of independent cap 1 | gemini-3.8-flash | provider_error, HTTP 403 | 0 |

Cell 1A's durable reservation remains consumed with
`RUNTIME_OR_CONTRACT_OR_SAFETY_FAILURE`. No reset, retry, 1B or later cell
was dispatched. Raw response is empty, output and reported served identity
are null, decision review is not recorded. Every RU/UA intent/fidelity
judgment is `NOT_TESTED`; B and causal comparison are also `NOT_TESTED`.

After read-only operational investigation, one separately announced route
smoke reused the unchanged `scripts/audience-conformance.mjs` English synthetic
test on an explicitly configured alias. Its own one-attempt operator marker
was persisted before invocation; it is not a replay of Stage0 or a new gold
test. It also failed before a valid response, so no third call was made.

Across both distinct operations: two logical native dispatches, no valid
model completion, zero business effect artifacts, both one-attempt attention
grants revoked. Person, contact permission, conversation, draft, delivery,
work transfer and action proposal counts were independently read from each
SQLite store and remain zero. Runtime/scheduler/Telegram/send stayed disabled.
Reported Hermes API-call counter is 1 per failed operation, not an HTTP or
upstream count. Local input/output counters report zero; these do not prove
zero upstream usage or cost. Wire count, billed tokens and price remain UNKNOWN.

Evidence retained locally, without keys: `.cache/commercial-task-fidelity-stage0-v1/1A.json`
and `history.json`; `.cache/audience-conformance/latest.json`, `summary.json`,
and isolated SQLite stores; `.cache/fidelity-native-route-smoke-reservation.json`.
The local bootstrap reads the owner's existing proxy credential in memory
and provides it only to the authorized child environment. It is ignored,
contains no embedded key, and never writes or prints credential values.

Read-only source/config facts: pinned Hermes passes a custom-provider model
unchanged, preserves explicit chat_completions mode and uses the supplied
base URL for the OpenAI-compatible POST. Proxy metadata lists the first alias;
successful GET /models does not prove completion support. Current proxy config
contains explicit mappings for other Gemini aliases and configured upstream
compatibility providers; it declares round-robin and request-retry 25. This
further prevents inferring upstream request counts from a logical reservation.
These facts do NOT isolate the causes of 404 or 403: model mapping, provider
access, route or upstream policy are still hypotheses. No provider/config
mutation, credential rotation, model fallback or production activation was
performed. No serving identity attests a Google model or its weights here.

Final combined local gate on this implementation:

| Check | Result |
| --- | --- |
| Focused freeze + offline native CLI | 14/14 PASS |
| npm test | 1660/1660 PASS, no failures/skips/pending |
| npm run test:credentials | 25/25 Python PASS |
| npm run build | PASS, 262 JavaScript/JSON + 11 Python |
| git diff --check | PASS |
| Frozen RU/UA model fidelity | NOT_TESTED — native provider failure |

The next prerequisite is a positively verified native model route with known
requested/reported identity and truthful usage. Then explicitly admit a new
finite fidelity protocol; never erase this stopped experiment's history or
declare B adopted. If a causal prompt comparison is needed, arrange identical
prepared input/state in advance or retain the independent-observation label.
The useful-source/current-demand pilot is still unproved; this experiment
does not authorize new live collection, contact, or sending.
