# router — implementation plan of record

> Mirror of the RouterDoc kept in durable storage; the engine rewrites this file.
> `plan` writes the graph here for human review before the `run --approve --revision` grant.
> Each successful plan carries a fresh PLAN REVISION — a review identity minted
> per plan (even for identical replans), not the storage schema version. A
> replan archives the replaced revision and invalidates prior approvals, so a
> stamp from an old plan never authorizes the new one. Approval and bare
> resume act on the durable RouterDoc through that revision, never on
> hand-edited text here.
> A grant approves exactly THIS revision: `run --approve --revision <revision>`
> (omit `--tasks` for every task, or repeat `--tasks <id>` once per granted
> task — the full list is stored explicitly, never as a wildcard). A bare
> `run` resumes the stored grant and never imports edits made here; approval
> is refused while this mirror differs from the durable plan (replan to
> refresh). Do not edit this mirror as plan input. To change the graph,
> revise the PRD and rerun `plan`.
