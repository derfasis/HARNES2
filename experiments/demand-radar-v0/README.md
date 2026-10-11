# Demand Radar — bounded source-first acquisition v1 (offline)

An executable retrieval experiment over a frozen Scout sample, not a deployed
lead finder or semantic classifier. Related task [#49](https://github.com/derfasis/HARNES2/issues/49);
initial donor scaffold [PR #50](https://github.com/derfasis/HARNES2/pull/50).

We look for **expressed commercial tasks, resources and constraints**: customer
goods demand, service capacity, supply barriers, or comparison of ways to
monetize work. A profession, client list, seller pitch or quotation alone is not
an own task. Historical own tasks are not current opportunities. No family,
debt, age, health or distress targeting.

## Run

From the repository root, on Node 24:

~~~powershell
New-Item -ItemType Directory -Force .cache/demand-radar-acquisition | Out-Null
node experiments/demand-radar-v0/run.mjs --demo --out .cache/demand-radar-acquisition/demo.json
~~~

The output must not already exist; its parent directory must exist. The demo
uses 22 authored synthetic messages, not actual users or market evidence.
The report preserves originals and shows matched controls and unmatched gold
without claiming model accuracy.

For an **independently admitted local** Scout row:

~~~powershell
node experiments/demand-radar-v0/run.mjs --sample path/to/sealed-scout-row.json --mission path/to/versioned-mission.json --out path/to/new-report.json
~~~

The input is a JSON object with the existing SQL Scout fields:
id, candidate_id, account_id, source_ref, requested_from, requested_until,
status=sealed, messages_json, coverage, digest, source_cursor, finished_at.
messages_json is the original JSON string, not a transformed message array.
The adapter verifies the existing Scout commitment over every original row,
including its semantic content_hash. Actual Scout rows use unsupported=null
or a reason string, and content_hash=digest(semantic); this hash cannot be
independently reconstructed from the reduced row. The original semantic hash
is preserved separately from a newly computed text_hash. No raw-text hash is
misrepresented as the existing source hash.
It does not read the business DB, admit a source, verify current policies or
authorize the use of platform content. A digest is not a signature or grant.

To continue a bounded report, save **only packet.next_cursor** to a small JSON
file and pass --cursor path/to/cursor.json with the identical sample, mission
and budgets. Options: --max-anchors (1–24), --max-characters (1–96000),
--exploration-slots (0–max-anchors). Defaults: 8 anchors, 24000 text characters,
2 exploration slots. No hidden model/network/send switches.

## What gets preserved

- The full original message text, negative wording, source-scoped author ref,
  publication date, original link, content hash and reply relationship.
- All readable nonmatches for false-negative review; unreadable/opaque IDs and
  reasons; the bounded sample denominator and declared sampling coverage.
- Full reply ancestry inspection, including missing, opaque and cyclic branches.
  An independent readable message from the same author remains usable.
- Same-author references capped at 32, with total/truncation disclosed.
  Co-occurrence is never classified as cancellation automatically.
- Stable exact same-author/reply/text duplicate references; duplicate text stays
  available as context but does not become another independent review anchor.

The default RU/UA mission has six editable retrieval families. Literal roots
are deliberately broad. They route quotations, refusals, advertisements and
client-only statements too; they do not assign semantic intent or heat.

## Review packet

probeScoutDemandCandidates verifies native frozen content. Then
buildDemandReviewPacket selects matched anchors (oldest first) and reserves
slots **and whole anchor text** for unmatched exploration (newest first).
This deterministic exploration is not random or representative.

Context order is anchor, its ancestors, direct replies, recent same-author
messages, and any additional ancestry required by those messages. Context is
bounded to 32 messages per group and a global text character budget. Text is
never cut to manufacture completeness. Every omitted relevant context ID and
incompleteness is disclosed.

Duplicate anchors, missing/opaque/cyclic required ancestry and anchors larger
than the whole packet budget are skipped with reasons. Pending eligible
anchors stay in bound cursor queues. Restart needs no volatile identity;
the CLI re-verifies the same row and rebuilds its packet. Changes to mission,
sample, content or budgets invalidate the old cursor. Full evidence remains in
the report even when review packets defer it.

## Boundaries

Every report keeps semantic_intent=NOT_ASSESSED, offer_fit=UNKNOWN,
current_intent=UNKNOWN, contact_permission=false,
can_promote_to_discovery=false, model_calls=0 and network_calls=0.

Sample integrity does not prove publication freshness, continuous coverage,
distinct people, source revocation state, completeness or processing authority.
finished_at is explicitly declared, not a currentness check. Old frozen
history remains historical. No ingestion replay, Discovery/Person/
Conversation creation, watch grant, draft or send occurs.

The legacy pure probeDemandCandidates accepts source-neutral frozen fixture
arrays, explicitly leaves digest_checked=false and cannot build review packets.
Only the fresh in-process verified native adapter result can do so; fabricated,
changed or rehydrated probe objects are rejected. To resume serialized work,
re-verify the original Scout row, not the report.

The tool writes a new local report after validation and never overwrites an
existing file. Filesystem failure is a failed run, not a successful receipt.
A crash during final writing may leave an incomplete output file; it must be
inspected/discarded by the operator before another run. No provider dispatch,
durable platform cursor, scheduler or production grant is involved.

## Verification and remaining work

~~~powershell
node --test tests/demand-radar-*.test.mjs
npm test
npm run test:credentials
npm run build
git diff --check
~~~

See [engineering report](../../docs/DEMAND_RADAR_ACQUISITION_V1_2026-10-11.md)
for exact scope, independent kills and measured results.

This establishes an executable offline acquisition boundary. It does **not**
prove real-community yield, actual author intent, Gemini fidelity or FitLine
fit. Separately freeze and test the native CLIProxyAPI/Hermes assessment path;
independently admit a real corpus and verify offer terms before adoption.
Known earlier source-fidelity failures are not repaired by this experiment.

## GitHub-first reuse

Reviewed [subscope](https://github.com/dancolta/subscope) at
cf45ffd8956d0d24bbaaf4eaa5d7f0ecc293cb27 (MIT), specifically its staged retrieval,
contextual classification and explanation pattern. Its English Reddit/SaaS
scoring, role assumptions and alternate-host access-block failover do not fit
this boundary. No donor code or new dependency is copied.

Also considered [reddit-idea-scout](https://github.com/huxm-git/reddit-idea-scout)
and [opportunity-radar](https://github.com/hunterr198/opportunity-radar).
Use HARNES2's existing GramJS/Scout transport, sample schema, canonical digest,
content hashes and native model path; the new code is the product-specific
retrieval mission, context projection and inspectable offline report.
