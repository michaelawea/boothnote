# Lessons learned

Each of these rules came out of a specific failure while building and running Boothnote. The rule comes first, then what happened.

## Delivery and integrations

**A delivery endpoint that says "success" may have delivered nothing.**
A chat-platform flow webhook returned `200 {"success": true}` both when the message was delivered *and* when a keyword filter silently dropped it. The two responses were byte-for-byte identical. You can only verify delivery at the receiving end: somebody has to look in the group.

**"Soft delete or hard delete?" can't be answered from the response.**
Twenty's REST `DELETE` and GraphQL `delete{Object}` return almost the same payload. Only the database showed the difference: after GraphQL the row was still there with `deletedAt` set, and after REST it was gone. We found out when REST hard-deleted three records that an Undo button then couldn't bring back. Deletes and restores now go through GraphQL only.

**Changing metadata and getting HTTP 200 doesn't mean nothing broke.**
Re-provisioning an enum field returned 200 and silently emptied the column. The only trustworthy check is a data snapshot before and after, compared field by field. That's why every deploy runs a data guard straight after provisioning.

**Don't probe "does the other side support X?" by matching error text.**
The wording belongs to the other side and changes without notice. Instead, on any 4xx, retry once with the minimal parameter set. The exceptions are 401, 403 and 429, whose meaning is unambiguous.

**A fail-open guard that never blocks looks exactly like one that's broken.**
A cheap-model gatekeeper had been getting HTTP 400 on every call since launch: that model family rejects `max_tokens` and `temperature: 0`. Because it failed open, nothing looked wrong. The request shape is now pinned in a unit test.

## Tests

**A green test doesn't prove it tests anything.**
The only way to know is to break what it guards and watch it go red (mutation testing). In one pass, 7 of 8 mutations were caught. The one that got through exposed an assertion that was true on both branches.

**Before trusting a mutation run, confirm the mutation was applied.**
Otherwise "the mutation didn't apply" looks like "the test is weak", and you end up weakening a perfectly good assertion.

**A new guard has to fail once before you trust it.**
A lint step ran for three days without ever running: the shell script called it bare, and without `set -e` its exit code was dropped, so the suite still printed "all passed".

**Test helpers that swallow errors cost more than product code that does.**
A helper returned `null` on HTTP 429, and the assertion then reported "the original text was lost", sending everyone to debug a data problem that was really rate limiting. Product code that swallows an error fails once. A test helper that does it points every future failure in the wrong direction.

**Not creating garbage beats cleaning it up.**
Integration tests start a disposable Postgres and gateway, and point the CRM URL at a closed port. Clean-up afterwards has three holes: runs that die halfway, append-only tables, and the fact that someone has to remember to run it. If Docker isn't available the suite exits 1; it never falls back to your real database.

## UI

**"All tests pass" and "the page is right" are different claims.**
Paging through the app in a browser once turned up five problems that no test covered.

**Stacking order only guarantees "can't see it". Removing it guarantees "can't tap it".**
On iOS a shell bar sat above an overlay, so tapping a visible button triggered the one underneath. Two overlays that can be on screen together are portalled to `body`, and the shell is hidden while an overlay is open.

**`z-index` doesn't compare across stacking contexts.**
A confirm dialog at `z-index: 60` sat inside a transformed sheet at 40, underneath a backdrop at 50. Tapping "Delete" just closed the drawer.

**"Is it running?" is a fact the server knows, not something this tab remembers.**
The thinking animation keyed off a local `waiting` flag that only one entry point ever set, so the most common entry point never showed it.

## Data and domain

**A count that depends on the model taking the right path isn't a count.**
Aggregation keys have to be machine-checked (UUIDs, controlled lists), never names the model wrote. The spreadsheet this system replaced fell apart because it joined on names: brand lists overlapped 32 of 61, and group names across three copies didn't overlap at all.

**When a limit is itself a mitigation, ask what happens to the failure it mitigates before you change it.**
The original 90-second recording cap was a workaround for iOS killing background recording. Raising it to 10 minutes meant also handling interruptions, and keeping whatever had been recorded, because before that an interruption lost the recording silently.

**Transfer ownership at the same moment the new owner actually has the thing.**
When a correction replaced an already-committed note, handing over its CRM records early left orphans whenever the correction was never confirmed.

**"Hide it" and "delete it" are different requests.**
A cleanup list that would have removed two load-bearing objects turned out to mean "take them off the sidebar". Ask which one is meant, then ask what else that path turns off.
