# Commercial Task Fidelity, Stage 0

One finite experiment on four researcher-authored RU/UA conversations. This is
not a source-discovery service, real-audience sample, contact tool, or a claim
that the model has never seen similar text. It tests how the existing native
Audience → Hermes → configured CLIProxyAPI route preserves commercial tasks,
speakers, conditions, exclusions and later status.

The cases, independent gold and two prompts are hash-frozen before calls.
Production files are separately checked against their frozen hashes. A is
the canonical Audience instruction text, normalized to LF; B appends one
general source-fidelity brief. Both run through the same explicit experimental
prompt-binding seam. The actual prompt and full model-input hashes are stored
in the prepared run and durable receipt. The gold and researcher case objectives
are never included in model input. All cells use the same neutral objective.

This is a diagnostic set of two native instruction arms, not a controlled
paired causal A/B benchmark. The domain generates fresh goal/assessment/
exchange IDs and capture clocks for each isolated run. Both arms have the same
case-only title and controlled source/task fingerprint (drift blocks B), but
their complete model-input bytes differ. Evaluate each output against the
frozen oracle; do not credit a difference to B or declare B better from this
experiment. The fixture's declared observation date is metadata; actual
ingestion/capture clocks remain truthful and are recorded separately.

Each cell has its own synthetic source, SQLite database, one-attempt attention
grant and native no-tools run. Publication dates, message identities, author
identities, full text and reply relationships must survive the real source
projection. Historical dates are not rewritten to today. Receipt currentness
and a person's still-active intention are distinct.

Use the owner's existing proxy credential in the process environment, never
in a CLI argument or tracked file:

```powershell
node experiments/commercial-task-fidelity-v1/run.mjs --status
node experiments/commercial-task-fidelity-v1/run.mjs --run 1A --model MODEL_ID --base-url http://127.0.0.1:PORT/v1
node experiments/commercial-task-fidelity-v1/run.mjs --review PATH_TO_MANUAL_REVIEW_JSON
```

Sequence is `1A, 1B, 2A, 2B, 3A, 3B, 4A, 4B`, at most eight logical native
dispatch reservations in `.cache/commercial-task-fidelity-stage0-v1/history.json`.
There is no run-all mode, reset, automatic retry or replay of a reserved cell.
The write-ahead reservation is fsynced before adapter entry. A process lock
prevents concurrent dispatch. A crash can leave a retained lock/reservation;
inspect the dead process and records manually, do not delete history or
convert an uncertain attempt into an unused slot. Automatic lock recovery is
deliberately absent from this finite experiment.

Every completed cell needs a separate reviewer verdict bound to its exact
output and frozen gold. A semantic A failure can proceed to B; a B failure,
unknown review, runtime/contract/safety failure or unknown comparative model
identity stops further dispatch. Empty output cannot pass either required
positive control. A structurally accepted model response is NOT a semantic
PASS. Manual review must cover every source fact, required distinction,
forbidden claim, critical failure, currentness, positive control, offer fit
and contact permission, with a concrete reason for each. Checklist `PASS`
means the fact/distinction is preserved or the prohibited failure is absent.

Review JSON has `version:1`, `cell_id`, `case_id`, `reviewer`, `output_hash`,
`gold_case_hash`, `verdict: PASS|FAIL|UNKNOWN`; the four list fields
`source_facts`, `required_distinctions`, `forbidden_claims`, `critical_failures`
contain `{index,result,reason}` rows matching every gold entry. Four scalar
checks `currentness`, `positive_control`, `offer_fit`, `contact_permission`
contain `{result,reason}`. All results are `PASS|FAIL|UNKNOWN`. The verdict
must agree with the checklist. Reviews are recorded in history; report
changes after completion are rejected. The script validates review coverage
and bindings, not the truth of a human/agent's semantic judgment.

Reports retain exact output, source packet, actual input/prompt hashes, native
receipt, requested/reported model identity, reported token usage, permission
closure and effect-table counts. Runtime, scheduler, Telegram, workspace and
outbound remain disabled. No source content is read from live Telegram.
Test grants are revoked in `finally`, with closure failures stopping the run.

Hermes' decision envelope has two iterations. Iterations and logical dispatch
counts are not HTTP/upstream request counts: credential/proxy failover can
retry invisibly. Those counts and actual billing remain UNKNOWN. Equal
reported identities provide a weaker comparison than an upstream attestation;
unequal/missing identities make A/B inconclusive. Known token totals may be
reported, but missing usage is never converted to zero or estimated pricing.

This reuses HARNES's existing source ingestion, evidence projection, grants,
Control Plane, Audience state machine, schema, Hermes adapter, configured proxy,
and the conformance CLI's lock/reservation/report pattern. New code is only
the frozen experimental protocol and oracle-bound review, not a new parser,
provider, workflow engine, production scheduler or semantic evaluator.
