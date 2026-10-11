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
