# Discovery evaluation v1 — synthetic, offline

15 hand-authored episodes / 31 chronological checkpoints: 10 positive, 15 negative, 2 uncertain, 4 insufficient-evidence. Topics include noise, occupation without need, weak hints, accumulated questions, unrelated needs, quoted intent, contradiction/refusal, edits/delete, required/optional opaque ancestry, missing parent and later-created interest.

Run `npm run evaluate:discovery`. With no supplied predictions this validates corpus structure/time only: precision/recall are null, `model_quality_measured:false`, `live_proof:false`. It never loads local model configuration, starts a worker or contacts Telegram.

Export blinded contexts and a report to NEW files:

```powershell
node scripts/discovery-evaluate.mjs --contexts exports/discovery-contexts.json --report exports/discovery-structure.json
node scripts/discovery-evaluate.mjs --predictions exports/discovery-predictions.json --report exports/discovery-scored.json
```

Create the output directory first. Files use exclusive creation and cannot overwrite the corpus/predictions. Contexts contain only the prefix available at each checkpoint, current message revisions, coverage, exact offer and prefix hash. Gold labels and later validation are excluded. These are evaluation inputs; the CLI does not run the production prompt or pretend to replay a model. Retain model/version/prompt provenance when obtaining predictions in a separately authorized run.

Prediction wrapper:

```json
{
  "contract_version": "discovery-predictions-v1",
  "provenance": {"kind": "model", "label": "exact model, prompt/version, run ID"},
  "predictions": [{
    "checkpoint_id": "explicit-relevant-need-1",
    "prefix_hash": "copy the 64-character hash from the blinded context",
    "offer_version": "synthetic-v1",
    "decision": "REVIEW",
    "assessment": "opportunity",
    "evidence": [{"source_event_id": "copy the event ID", "span": "exact observed text", "kind": "question", "attribution": "author_statement"}],
    "authority": {"contact_permission": false, "allowed_effects": []}
  }]
}
```

The example is a shape, not a scored valid prediction. `kind` may be model/human/synthetic_test; supplied provenance is declared, not independently verified. Do not call an oracle fixture model proof.

Metrics include TP/FP/FN/TN, prediction/valid coverage, missing/invalid by label, uncertain/insufficient cases, WAIT abstentions, grounded recall, conservative precision over all positive proposals, and delay from the first eligible positive prefix. Missing/invalid positives stay in recall's denominator. Future detection after refusal cannot repair the earlier missed window. A later-created need does not retroactively make the earlier correct IGNORE a false negative.

Exact spans/IDs can be checked mechanically. Semantic attribution, suitability, quote interpretation and usefulness of a natural opening still require blind human adjudication. This small synthetic set is a regression starting point, not a representative live distribution or proof of business effectiveness.
